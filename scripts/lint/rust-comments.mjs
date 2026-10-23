// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

/** @typedef {{start: number, end: number}} RustCommentSpan */
const RUST_UNICODE_ESCAPE_STOPS = new Set(["}", "'", "\n", "\r"]);

/** @param {string} source @param {number} start @returns {number | null} */
function rawStringPrefixEnd(source, start) {
  if (source.startsWith("br", start) || source.startsWith("cr", start)) return start + 2;
  return source[start] === "r" ? start + 1 : null;
}

/** @param {string} source @param {number} start @returns {{cursor: number, hashes: number} | null} */
function rawStringOpening(source, start) {
  let cursor = rawStringPrefixEnd(source, start);
  if (cursor === null) return null;
  const hashStart = cursor;
  while (source[cursor] === "#") cursor++;
  if (source[cursor] !== '"') return null;
  return { cursor: cursor + 1, hashes: cursor - hashStart };
}

/** @param {string} source @param {number} cursor @param {number} hashes @returns {number} */
function rawStringEnd(source, cursor, hashes) {
  while (cursor < source.length) {
    if (source[cursor] !== '"') {
      cursor++;
      continue;
    }
    let hashEnd = cursor + 1;
    while (source[hashEnd] === "#") hashEnd++;
    if (hashEnd - cursor - 1 >= hashes) return cursor + hashes + 1;
    cursor = hashEnd;
  }
  return source.length;
}

/** @param {string} source @param {number} start @returns {number | null} */
function skipRawString(source, start) {
  if (start > 0 && isIdentifierContinuation(source.charCodeAt(start - 1))) return null;
  const opening = rawStringOpening(source, start);
  return opening === null ? null : rawStringEnd(source, opening.cursor, opening.hashes);
}

/** @param {string} source @param {number} start @returns {number} */
function skipQuotedString(source, start) {
  let cursor = start + 1;
  while (cursor < source.length) {
    if (source[cursor] === '"') return cursor + 1;
    if (source[cursor] === "\\") cursor++;
    cursor++;
  }
  return source.length;
}

function isLineBreak(character) {
  return character === "\n" || character === "\r";
}

/** @param {string} source @param {number} cursor @returns {number | null} */
function skipHexEscape(source, cursor) {
  return cursor + 3 <= source.length ? cursor + 3 : null;
}

/** @param {string} source @param {number} cursor @returns {number | null} */
function skipUnicodeEscapeBody(source, cursor) {
  while (cursor < source.length && !RUST_UNICODE_ESCAPE_STOPS.has(source[cursor])) cursor++;
  return source[cursor] === "}" ? cursor + 1 : null;
}

/** @param {string} source @param {number} cursor @returns {number | null | undefined} */
function skipUnicodeEscape(source, cursor) {
  if (source[cursor] !== "u" || source[cursor + 1] !== "{") return undefined;
  return skipUnicodeEscapeBody(source, cursor + 2);
}

/** @param {string} source @param {number} slash @returns {number | null} */
function skipRustEscape(source, slash) {
  const cursor = slash + 1;
  const escaped = source[cursor];
  if (escaped === undefined || isLineBreak(escaped)) return null;
  if (escaped === "x") return skipHexEscape(source, cursor);
  const unicodeEnd = skipUnicodeEscape(source, cursor);
  return unicodeEnd === undefined ? cursor + 1 : unicodeEnd;
}

/** @param {string} source @param {number} cursor @returns {number | null} */
function skipPlainChar(source, cursor) {
  if (source[cursor] === "'") return null;
  const codePoint = source.codePointAt(cursor);
  return cursor + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1);
}

/** @param {string} source @param {number} cursor @returns {number | null} */
function skipCharLiteralContent(source, cursor) {
  if (cursor >= source.length || isLineBreak(source[cursor])) return null;
  return source[cursor] === "\\" ? skipRustEscape(source, cursor) : skipPlainChar(source, cursor);
}

/** @param {string} source @param {number} start @returns {number | null} */
function skipCharLiteral(source, start) {
  if (source[start] !== "'") return null;
  const contentEnd = skipCharLiteralContent(source, start + 1);
  return contentEnd !== null && source[contentEnd] === "'" ? contentEnd + 1 : null;
}

/** @param {string} source @param {number} offset @returns {number} */
function carriageReturnLength(source, offset) {
  return source.charCodeAt(offset + 1) === 10 ? 2 : 1;
}

/** @param {number} code @returns {number} */
function otherLineTerminatorLength(code) {
  return code === 10 || code === 0x2028 || code === 0x2029 ? 1 : 0;
}

/** @param {string} source @param {number} offset @returns {number} */
function lineTerminatorLengthAt(source, offset) {
  const code = source.charCodeAt(offset);
  if (code === 13) return carriageReturnLength(source, offset);
  return otherLineTerminatorLength(code);
}

/** @param {string} source @param {number} cursor @returns {boolean} */
function isByteCharPrefix(source, cursor) {
  return (
    source[cursor] === "b" &&
    source[cursor + 1] === "'" &&
    (cursor === 0 || !isIdentifierContinuation(source.charCodeAt(cursor - 1)))
  );
}

/** @param {string} source @param {number} cursor @returns {number | null} */
function skipByteChar(source, cursor) {
  if (!isByteCharPrefix(source, cursor)) return null;
  return skipCharLiteral(source, cursor + 1);
}

/** @param {string} source @param {number} cursor @returns {number | null} */
function skipQuotedLiteral(source, cursor) {
  if (source[cursor] === '"') return skipQuotedString(source, cursor);
  if (source[cursor] === "'") return skipCharLiteral(source, cursor);
  return null;
}

/** @param {string} source @param {number} cursor @returns {number | null} */
function skipLiteral(source, cursor) {
  const rawStringEnd = skipRawString(source, cursor);
  if (rawStringEnd !== null) return rawStringEnd;
  const byteCharEnd = skipByteChar(source, cursor);
  if (byteCharEnd !== null) return byteCharEnd;
  return skipQuotedLiteral(source, cursor);
}

/** @param {string} source @param {number} cursor @returns {number} */
function lineCommentEnd(source, cursor) {
  cursor += 2;
  while (cursor < source.length && lineTerminatorLengthAt(source, cursor) === 0) cursor++;
  return cursor;
}

/** @param {string} source @param {number} cursor @returns {number} */
function blockCommentStep(source, cursor, depth) {
  if (source[cursor] === "/" && source[cursor + 1] === "*") {
    return { cursor: cursor + 2, depth: depth + 1 };
  }
  if (source[cursor] === "*" && source[cursor + 1] === "/") {
    return { cursor: cursor + 2, depth: depth - 1 };
  }
  return { cursor: cursor + 1, depth };
}

/** @param {string} source @param {number} cursor @returns {number} */
function blockCommentEnd(source, cursor) {
  cursor += 2;
  let depth = 1;
  while (cursor < source.length && depth > 0) {
    const next = blockCommentStep(source, cursor, depth);
    cursor = next.cursor;
    depth = next.depth;
  }
  return cursor;
}

/** @param {string} source @param {number} cursor @returns {RustCommentSpan | null} */
function rustCommentAt(source, cursor) {
  if (source[cursor] !== "/") return null;
  const start = cursor;
  if (source[cursor + 1] === "/") return { start, end: lineCommentEnd(source, cursor) };
  if (source[cursor + 1] === "*") return { start, end: blockCommentEnd(source, cursor) };
  return null;
}

/** @param {string} source Rust source text.
 * @returns {RustCommentSpan[]} Ordered UTF-16 [start,end) comment ranges.
 */
export function scanRustComments(source) {
  /** @type {RustCommentSpan[]} */
  const comments = [];
  let cursor = 0;
  while (cursor < source.length) {
    const literalEnd = skipLiteral(source, cursor);
    if (literalEnd !== null) {
      cursor = literalEnd;
      continue;
    }
    const comment = rustCommentAt(source, cursor);
    if (comment !== null) {
      comments.push(comment);
      cursor = comment.end;
    } else cursor++;
  }
  return comments;
}

/** @param {number} code @param {number} min @param {number} max @returns {boolean} */
function isAsciiRange(code, min, max) {
  return code >= min && code <= max;
}

/** @param {number} code @returns {boolean} */
function isAsciiLetter(code) {
  return isAsciiRange(code, 65, 90) || isAsciiRange(code, 97, 122);
}

/** @param {number} code @returns {boolean} */
function isAsciiIdentifierContinuation(code) {
  return code === 95 || isAsciiRange(code, 48, 57) || isAsciiLetter(code);
}

/** @param {number} code @returns {boolean} */
function isIdentifierContinuation(code) {
  return isAsciiIdentifierContinuation(code) || code >= 0x80;
}
