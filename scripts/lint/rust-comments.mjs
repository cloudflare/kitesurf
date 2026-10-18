// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

/** @typedef {{start: number, end: number}} RustCommentSpan */

/** @param {string} source @param {number} start @returns {number | null} */
function skipRawString(source, start) {
  if (start > 0 && isIdentifierContinuation(source.charCodeAt(start - 1))) return null;

  let cursor = start;
  if (source.startsWith("br", start) || source.startsWith("cr", start)) cursor = start + 2;
  else if (source[start] === "r") cursor = start + 1;
  else return null;

  const hashStart = cursor;
  while (source[cursor] === "#") cursor++;
  if (source[cursor] !== '"') return null;
  const hashCount = cursor - hashStart;
  cursor++;

  while (cursor < source.length) {
    if (source[cursor] !== '"') {
      cursor++;
      continue;
    }
    let hashEnd = cursor + 1;
    while (source[hashEnd] === "#") hashEnd++;
    if (hashEnd - cursor - 1 >= hashCount) return cursor + hashCount + 1;
    cursor = hashEnd;
  }
  return source.length;
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

/** @param {string} source @param {number} slash @returns {number | null} */
function skipRustEscape(source, slash) {
  let cursor = slash + 1;
  const escaped = source[cursor];
  if (escaped === undefined || escaped === "\n" || escaped === "\r") return null;
  if (escaped === "x") return cursor + 3 <= source.length ? cursor + 3 : null;
  if (escaped === "u" && source[cursor + 1] === "{") {
    cursor += 2;
    while (
      cursor < source.length &&
      source[cursor] !== "}" &&
      source[cursor] !== "'" &&
      source[cursor] !== "\n" &&
      source[cursor] !== "\r"
    )
      cursor++;
    return source[cursor] === "}" ? cursor + 1 : null;
  }
  return cursor + 1;
}

/** @param {string} source @param {number} start @returns {number | null} */
function skipCharLiteral(source, start) {
  if (source[start] !== "'") return null;
  let cursor = start + 1;
  if (cursor >= source.length || source[cursor] === "\n" || source[cursor] === "\r") return null;
  if (source[cursor] === "\\") {
    const escapedEnd = skipRustEscape(source, cursor);
    if (escapedEnd === null) return null;
    cursor = escapedEnd;
  } else {
    if (source[cursor] === "'") return null;
    const codePoint = source.codePointAt(cursor);
    cursor += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
  }
  return source[cursor] === "'" ? cursor + 1 : null;
}

/** @param {string} source @param {number} offset @returns {number} */
function lineTerminatorLengthAt(source, offset) {
  const code = source.charCodeAt(offset);
  if (code === 13) return source.charCodeAt(offset + 1) === 10 ? 2 : 1;
  return code === 10 || code === 0x2028 || code === 0x2029 ? 1 : 0;
}

/** @param {string} source Rust source text.
 * @returns {RustCommentSpan[]} Ordered UTF-16 [start,end) comment ranges.
 */
export function scanRustComments(source) {
  /** @type {RustCommentSpan[]} */
  const comments = [];
  let cursor = 0;
  while (cursor < source.length) {
    const rawStringEnd = skipRawString(source, cursor);
    if (rawStringEnd !== null) {
      cursor = rawStringEnd;
      continue;
    }

    const isByteChar =
      source[cursor] === "b" &&
      source[cursor + 1] === "'" &&
      (cursor === 0 || !isIdentifierContinuation(source.charCodeAt(cursor - 1)));
    if (isByteChar) {
      const charEnd = skipCharLiteral(source, cursor + 1);
      if (charEnd !== null) {
        cursor = charEnd;
        continue;
      }
    }
    if (source[cursor] === '"') {
      cursor = skipQuotedString(source, cursor);
      continue;
    }
    if (source[cursor] === "'") {
      const charEnd = skipCharLiteral(source, cursor);
      if (charEnd !== null) {
        cursor = charEnd;
        continue;
      }
    }
    if (source[cursor] === "/" && source[cursor + 1] === "/") {
      const start = cursor;
      cursor += 2;
      while (cursor < source.length && lineTerminatorLengthAt(source, cursor) === 0) cursor++;
      comments.push({ start, end: cursor });
      continue;
    }
    if (source[cursor] === "/" && source[cursor + 1] === "*") {
      const start = cursor;
      cursor += 2;
      let depth = 1;
      while (cursor < source.length && depth > 0) {
        if (source[cursor] === "/" && source[cursor + 1] === "*") {
          depth++;
          cursor += 2;
        } else if (source[cursor] === "*" && source[cursor + 1] === "/") {
          depth--;
          cursor += 2;
        } else {
          cursor++;
        }
      }
      comments.push({ start, end: cursor });
      continue;
    }
    cursor++;
  }
  return comments;
}

/** @param {number} code @returns {boolean} */
function isIdentifierContinuation(code) {
  return (
    code === 95 ||
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code >= 0x80
  );
}
