// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

/** @typedef {{start: number, end: number}} CommentSpan */
/** @typedef {{line: number, column: number, message: string}} CommentViolation */
/** @typedef {{start: number, end: number}} PhysicalLine */
/** @typedef {{line: number, column: number, visualWidth: number, body: string}} CommentLine */
/** @typedef {{kind: "line" | "block", spans: CommentSpan[]}} CommentBlock */

const MAX_COMMENT_LINES = 4;
const MAX_COMMENT_COLUMNS = 100;
const RUST_TEST_BARE_DIRECTIVES = [
  "check-pass",
  "compile-fail",
  "run-pass",
  "build-pass",
  "run-fail",
  "run-rustfix",
  "pp-exact",
  "compare-output",
];
const RUST_TEST_VALUE_DIRECTIVES = [
  "compile-flags",
  "rustc-flags",
  "run-flags",
  "edition",
  "revisions",
  "aux-build",
  "aux-crate",
  "error-pattern",
  "rustc-env",
  "known-bug",
];
const DIRECTIVE_PREFIXES = [
  "@ts-expect-error",
  "@ts-ignore",
  "@ts-nocheck",
  "@ts-check",
  "eslint-disable-next-line",
  "eslint-disable-line",
  "eslint-disable",
  "eslint-enable",
  "eslint-env",
  "oxlint-disable-next-line",
  "oxlint-disable-line",
  "oxlint-disable",
  "oxlint-enable",
  "biome-ignore",
  "prettier-ignore",
  "rustfmt::skip",
  "@vite-ignore",
  "@__PURE__",
  "#__PURE__",
  "#region",
  "#endregion",
  "c8 ignore next",
  "c8 ignore start",
  "c8 ignore stop",
  "istanbul ignore next",
  "istanbul ignore if",
  "istanbul ignore else",
  "go:build",
  "go:generate",
  "+build",
];

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

/** @param {string} source @returns {PhysicalLine[]} */
function getPhysicalLines(source) {
  /** @type {PhysicalLine[]} */
  const lines = [];
  let start = 0;
  for (let offset = 0; offset < source.length; offset++) {
    const terminatorLength = lineTerminatorLengthAt(source, offset);
    if (terminatorLength === 0) continue;
    lines.push({ start, end: offset });
    offset += terminatorLength - 1;
    start = offset + 1;
  }
  lines.push({ start, end: source.length });
  return lines;
}

/** @param {string} source @param {number} start @param {number} end @returns {boolean} */
function hasOneLineBreakAndWhitespace(source, start, end) {
  let lineBreaks = 0;
  for (let offset = start; offset < end; offset++) {
    const terminatorLength = lineTerminatorLengthAt(source, offset);
    if (terminatorLength > 0) {
      lineBreaks++;
      if (lineBreaks > 1) return false;
      offset += terminatorLength - 1;
      continue;
    }
    if (source.charAt(offset).trim() !== "") return false;
  }
  return lineBreaks === 1;
}

/** @param {string} source @param {CommentSpan} span @returns {boolean} */
function isLineComment(source, span) {
  return source.startsWith("//", span.start);
}

/** @param {string} source @param {CommentSpan} previous @param {CommentSpan} next @returns {boolean} */
function areAdjacentLineComments(source, previous, next) {
  return (
    isLineComment(source, next) && hasOneLineBreakAndWhitespace(source, previous.end, next.start)
  );
}

/** @param {number} code @returns {boolean} */
function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

/** @param {number} code @returns {boolean} */
function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** @param {number} code @param {number} next @returns {number} */
function codePointLength(code, next) {
  return isHighSurrogate(code) && isLowSurrogate(next) ? 2 : 1;
}

/** @param {number} columns @param {number} tabWidth @returns {number} */
function tabAdvance(columns, tabWidth) {
  return tabWidth - (columns % tabWidth);
}

/** @param {string} source @param {number} start @param {number} end @param {number} tabWidth @returns {number} */
function measureColumns(source, start, end, tabWidth) {
  let columns = 0;
  for (let offset = start; offset < end;) {
    const code = source.charCodeAt(offset);
    if (code === 9) {
      columns += tabAdvance(columns, tabWidth);
      offset++;
      continue;
    }
    offset += codePointLength(code, source.charCodeAt(offset + 1));
    columns++;
  }
  return columns;
}

/** @param {PhysicalLine[]} lines @param {number} cursor @param {number} offset @returns {number} */
function findLineIndex(lines, cursor, offset) {
  while (cursor + 1 < lines.length) {
    const next = lines[cursor + 1];
    if (next === undefined || next.start > offset) break;
    cursor++;
  }
  return cursor;
}

/** @param {string} source @param {CommentSpan} span @returns {string} */
function lineCommentBody(source, span) {
  let start = span.start + 2;
  if (source[start] === "/" || source[start] === "!") start++;
  return source.slice(start, span.end).trim();
}

/** @param {string} source @param {number} start @param {number} end @param {boolean} first @param {boolean} last @returns {{start: number, end: number}} */
function trimBlockCommentDelimiters(source, start, end, first, last) {
  if (first) start += 2;
  if (last && source.slice(end - 2, end) === "*/") end -= 2;
  return { start, end };
}

/** @param {string} source @param {number} start @param {boolean} first @returns {number} */
function skipBlockCommentDecoration(source, start, first) {
  if (source[start] !== "*" && !(first && source[start] === "!")) return start;
  start++;
  if (source[start] === " ") start++;
  return start;
}

/** @param {string} source @param {number} start @param {number} end @param {boolean} first @param {boolean} last @returns {string} */
function blockCommentBody(source, start, end, first, last) {
  ({ start, end } = trimBlockCommentDelimiters(source, start, end, first, last));
  while (start < end && source.charAt(start).trim() === "") start++;
  start = skipBlockCommentDecoration(source, start, first);
  return source.slice(start, end).trim();
}

/** @param {string} source @param {CommentSpan[]} spans @param {PhysicalLine[]} physicalLines @param {number} lineCursor @param {number} tabWidth @returns {{lines: CommentLine[], nextLineCursor: number}} */
function getLineCommentLines(source, spans, physicalLines, lineCursor, tabWidth) {
  /** @type {CommentLine[]} */
  const lines = [];
  for (const span of spans) {
    lineCursor = findLineIndex(physicalLines, lineCursor, span.start);
    const physicalLine = physicalLines[lineCursor];
    if (physicalLine === undefined) throw new RangeError("comment line is outside the source");
    if (span.end > physicalLine.end) {
      throw new RangeError("Line comment span must not include a line terminator");
    }
    lines.push({
      line: lineCursor + 1,
      column: span.start - physicalLine.start,
      visualWidth: measureColumns(source, physicalLine.start, span.end, tabWidth),
      body: lineCommentBody(source, span),
    });
  }
  return { lines, nextLineCursor: lineCursor };
}

/** @param {string} source @param {CommentSpan} span @param {PhysicalLine[]} physicalLines @param {number} lineCursor @param {number} tabWidth @returns {{lines: CommentLine[], nextLineCursor: number}} */
function getBlockCommentLines(source, span, physicalLines, lineCursor, tabWidth) {
  /** @type {CommentLine[]} */
  const lines = [];
  lineCursor = findLineIndex(physicalLines, lineCursor, span.start);
  const firstLine = lineCursor;
  while (lineCursor < physicalLines.length) {
    const physicalLine = physicalLines[lineCursor];
    if (physicalLine === undefined) throw new RangeError("comment line is outside the source");
    const commentStart = Math.max(span.start, physicalLine.start);
    const commentEnd = Math.min(span.end, physicalLine.end);
    const first = lineCursor === firstLine;
    const last = span.end <= physicalLine.end;
    const locationOffset = first
      ? span.start
      : firstNonWhitespace(source, physicalLine.start, commentEnd);
    lines.push({
      line: lineCursor + 1,
      column: locationOffset - physicalLine.start,
      visualWidth: measureColumns(source, physicalLine.start, commentEnd, tabWidth),
      body: blockCommentBody(source, commentStart, commentEnd, first, last),
    });
    if (last) break;
    lineCursor++;
  }
  return { lines, nextLineCursor: lineCursor };
}

/**
 * @param {string} source
 * @param {CommentSpan[]} spans
 * @param {"line" | "block"} kind
 * @param {PhysicalLine[]} physicalLines
 * @param {number} lineCursor
 * @param {number} tabWidth
 * @returns {{lines: CommentLine[], nextLineCursor: number}}
 */
function getCommentLines(source, spans, kind, physicalLines, lineCursor, tabWidth) {
  if (kind === "line")
    return getLineCommentLines(source, spans, physicalLines, lineCursor, tabWidth);
  const span = spans[0];
  if (span === undefined) throw new RangeError("block comment span is missing");
  return getBlockCommentLines(source, span, physicalLines, lineCursor, tabWidth);
}

/** @param {string} source @param {number} start @param {number} end @returns {number} */
function firstNonWhitespace(source, start, end) {
  while (start < end && source.charAt(start).trim() === "") start++;
  return start;
}

/** @param {number} code @returns {boolean} */
function isAsciiDigit(code) {
  return code >= 48 && code <= 57;
}

/** @param {string} value @param {number} offset @returns {boolean} */
function hasFourDigitsAt(value, offset) {
  return (
    isAsciiDigit(value.charCodeAt(offset)) &&
    isAsciiDigit(value.charCodeAt(offset + 1)) &&
    isAsciiDigit(value.charCodeAt(offset + 2)) &&
    isAsciiDigit(value.charCodeAt(offset + 3))
  );
}

/** @param {string} value @returns {boolean} */
function hasYear(value) {
  for (let offset = 0; offset + 3 < value.length; offset++) {
    if (hasFourDigitsAt(value, offset)) return true;
  }
  return false;
}

const LEGAL_BODY_PREFIXES = [
  "you may not use this file except in compliance with the license",
  "you may obtain a copy of the license at",
  "unless required by applicable law or agreed to in writing, software",
  'distributed under the license is distributed on an "as is" basis',
  "without warranties or conditions of any kind",
  "see the license for the specific language governing permissions and",
  "limitations under the license",
  "permission is hereby granted,",
  'of this software and associated documentation files (the "software"), to deal',
  "in the software without restriction, including without limitation the rights",
  "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
  "copies of the software, and to permit persons to whom the software is",
  "furnished to do so, subject to the following conditions:",
  "the above copyright notice and this permission notice shall be included",
  "copies or substantial portions of the software.",
  'the software is provided "as is"',
  "implied, including but not limited to the warranties of",
  "fitness for a particular purpose and noninfringement",
  "authors or copyright holders be liable",
  "liability, whether in an action of contract, tort or otherwise",
  "out of or in connection with the software or the use or other dealings",
  "redistribution and use in source and binary forms",
  "redistributions of source code must retain",
  "redistributions in binary form must reproduce",
  "neither the name of",
  "this software is provided by the copyright holders and contributors",
];

/** @param {string} value @returns {boolean} */
function isSpdxMarker(value) {
  return value.startsWith("SPDX-License-Identifier:") && value.slice(24).trim() !== "";
}

/** @param {string} value @returns {boolean} */
function isCopyrightMarker(value) {
  return value.startsWith("Copyright ") && hasYear(value);
}

/** @param {string} lower @returns {boolean} */
function isLicensedMarker(lower) {
  return lower.startsWith("licensed under ") && lower.includes("license");
}

/** @param {string} value @param {string} lower @returns {boolean} */
function isLegalHeaderMarker(value, lower) {
  return (
    isSpdxMarker(value) ||
    isCopyrightMarker(value) ||
    isLicensedMarker(lower) ||
    lower === "all rights reserved."
  );
}

/** @param {string} lower @returns {boolean} */
function isLicenseUrl(lower) {
  return (lower.startsWith("http://") || lower.startsWith("https://")) && lower.includes("license");
}

/** @param {string} lower @returns {boolean} */
function isLegalHeaderBody(lower) {
  return (
    LEGAL_BODY_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
    lower === "software." ||
    isLicenseUrl(lower)
  );
}

/** @param {string} value @returns {"marker" | "body" | null} */
function legalHeaderLineKind(value) {
  const lower = value.toLowerCase();
  if (isLegalHeaderMarker(value, lower)) return "marker";
  if (isLegalHeaderBody(lower)) return "body";
  return null;
}

/** @param {string} source @param {number} offset @returns {number} */
function skipWhitespace(source, offset) {
  while (offset < source.length) {
    const terminatorLength = lineTerminatorLengthAt(source, offset);
    if (terminatorLength > 0) {
      offset += terminatorLength;
      continue;
    }
    if (source.charAt(offset).trim() !== "") break;
    offset++;
  }
  return offset;
}

/** @param {string} source @param {number} offset @returns {boolean} */
function isShebangAt(source, offset) {
  return source.startsWith("#!", offset) && !source.startsWith("#![", offset);
}

/** @param {string} source @param {number} offset @returns {number} */
function shebangEnd(source, offset) {
  if (!isShebangAt(source, offset)) return offset;
  while (offset < source.length && lineTerminatorLengthAt(source, offset) === 0) offset++;
  return offset + lineTerminatorLengthAt(source, offset);
}

/** @param {string} source @returns {number} */
function getLegalHeaderOffset(source) {
  const bomEnd = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const firstContent = skipWhitespace(source, bomEnd);
  return skipWhitespace(source, shebangEnd(source, firstContent));
}

/** @param {CommentLine[]} lines @returns {boolean} */
function isLegalHeader(lines) {
  let hasMarker = false;
  for (const line of lines) {
    if (line.body === "") continue;
    const kind = legalHeaderLineKind(line.body);
    if (kind === null) return false;
    if (kind === "marker") hasMarker = true;
  }
  return hasMarker;
}

/** @param {string} value @param {string} prefix @returns {boolean} */
function hasDirectivePrefix(value, prefix) {
  if (!value.startsWith(prefix)) return false;
  const next = value[prefix.length];
  return next === undefined || next === ":" || next.trim() === "";
}

/** @param {string} value @param {string} prefix @returns {boolean} */
function hasDirectiveValue(value, prefix) {
  const next = value[prefix.length];
  return (
    value.startsWith(prefix) &&
    (next === " " || next === "\t") &&
    value.slice(prefix.length).trim() !== ""
  );
}

/** @param {number} code @returns {boolean} */
function isAsciiLetterCode(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** @param {number} code @returns {boolean} */
function isAsciiDigitCode(code) {
  return code >= 48 && code <= 57;
}

/** @param {number} code @returns {boolean} */
function isMetaKeyCharacter(code) {
  return isAsciiLetterCode(code) || isAsciiDigitCode(code) || code === 45 || code === 95;
}

/** @param {string} value @param {number} offset @returns {number} */
function skipMetaWhitespace(value, offset) {
  while (value[offset] === " " || value[offset] === "\t") offset++;
  return offset;
}

/** @param {string} value @param {number} offset @returns {number} */
function metaKeyEnd(value, offset) {
  while (offset < value.length && isMetaKeyCharacter(value.charCodeAt(offset))) offset++;
  return offset;
}

/** @param {string} value @returns {boolean} */
function isMetaDirective(value) {
  if (!value.startsWith("META:")) return false;
  const keyStart = skipMetaWhitespace(value, 5);
  const keyEnd = metaKeyEnd(value, keyStart);
  const first = value.charCodeAt(keyStart);
  return keyEnd > keyStart && isAsciiLetterCode(first) && value[keyEnd] === "=";
}

/** @param {string} value @returns {boolean} */
function isRustTestDirective(value) {
  let directive = value;
  if (directive.startsWith("@")) directive = directive.slice(1).trimStart();
  if (RUST_TEST_BARE_DIRECTIVES.includes(directive)) return true;
  if (RUST_TEST_VALUE_DIRECTIVES.some((prefix) => hasDirectiveValue(directive, `${prefix}:`)))
    return true;
  return ["ignore-", "only-", "needs-"].some(
    (prefix) => directive.startsWith(prefix) && directive.length > prefix.length,
  );
}

/** @param {string} value @returns {boolean} */
function isToolDirective(value) {
  return DIRECTIVE_PREFIXES.some((prefix) => hasDirectivePrefix(value, prefix));
}

/** @param {string} value @returns {boolean} */
function isTestEnvironmentDirective(value) {
  return (
    hasDirectiveValue(value, "@jest-environment") || hasDirectiveValue(value, "@vitest-environment")
  );
}

/** @param {string} value @returns {boolean} */
function isSourceMapDirective(value) {
  return value.startsWith("# sourceMappingURL=") && value.slice(19).trim() !== "";
}

/** @param {string} value @returns {boolean} */
function isDirectiveLine(value) {
  return (
    isToolDirective(value) ||
    isTestEnvironmentDirective(value) ||
    isSourceMapDirective(value) ||
    isMetaDirective(value) ||
    isRustTestDirective(value)
  );
}

/** @param {CommentLine | undefined} line @returns {boolean} */
function isNonEmptyDirectiveLine(line) {
  return line !== undefined && line.body !== "" && isDirectiveLine(line.body);
}

/** @param {CommentLine[]} lines @returns {boolean} */
function isDirectiveBlock(lines) {
  return lines.length > 0 && lines.every(isNonEmptyDirectiveLine);
}

const JSDOC_TYPE_TAGS = ["@typedef", "@returns", "@param", "@type"];

/** @param {string} text @param {number} offset @param {string} tag @returns {boolean} */
function isJsDocTypeTagAt(text, offset, tag) {
  const after = text[offset + tag.length];
  return text.startsWith(tag, offset) && (after === " " || after === "\t");
}

/** @param {string} text @param {number} offset @returns {string | null} */
function jsDocTypeTagAt(text, offset) {
  return JSDOC_TYPE_TAGS.find((tag) => isJsDocTypeTagAt(text, offset, tag)) ?? null;
}

/** @param {string} text @param {number} offset @returns {number | null} */
function jsDocTypeStart(text, offset) {
  let cursor = offset;
  while (text[cursor] === " " || text[cursor] === "\t") cursor++;
  return text[cursor] === "{" ? cursor + 1 : null;
}

/** @typedef {{depth: number, quote: string, escaped: boolean}} JsDocTypeScan */

/** @param {string} character @param {JsDocTypeScan} state */
function advanceQuotedCharacter(character, state) {
  if (state.escaped) {
    state.escaped = false;
    return;
  }
  if (character === "\\") state.escaped = true;
  else if (character === state.quote) state.quote = "";
}

/** @param {string} character @returns {boolean} */
function isQuoteDelimiter(character) {
  return character === '"' || character === "'" || character === "`";
}

/** @param {string} character @param {number} cursor @param {JsDocTypeScan} state @returns {number | null} */
function updateJsDocTypeDepth(character, cursor, state) {
  if (character === "{") state.depth++;
  if (character !== "}") return null;
  state.depth--;
  return state.depth === 0 ? cursor + 1 : null;
}

/** @param {string} text @param {number} cursor @param {JsDocTypeScan} state @returns {number | null} */
/** @param {string} text @param {number} cursor @param {JsDocTypeScan} state @returns {number | null} */
function findJsDocTypeEnd(text, cursor, state) {
  for (; cursor < text.length; cursor++) {
    const character = text.charAt(cursor);
    if (state.quote !== "") {
      advanceQuotedCharacter(character, state);
      continue;
    }
    if (isQuoteDelimiter(character)) {
      state.quote = character;
      continue;
    }
    const end = updateJsDocTypeDepth(character, cursor, state);
    if (end !== null) return end;
  }
  return null;
}

/** @param {string} text @param {number} offset @returns {number | null} */
function typedJsDocTagEnd(text, offset) {
  const tag = jsDocTypeTagAt(text, offset);
  if (tag === null) return null;
  const typeStart = jsDocTypeStart(text, offset + tag.length);
  if (typeStart === null) return null;
  const state = { depth: 0, quote: "", escaped: false };
  const end = findJsDocTypeEnd(text, typeStart - 1, state);
  if (end === null) return null;
  return text.slice(typeStart, end - 1).trim() === "" ? null : end;
}

/** @param {string} source @param {CommentBlock} block @returns {boolean} */
function isJsDocBlock(source, block) {
  const firstSpan = block.spans[0];
  return (
    block.kind === "block" && firstSpan !== undefined && source.startsWith("/**", firstSpan.start)
  );
}

/** @param {CommentLine} line @param {number} offset @param {number} consumedThrough @returns {boolean} */
function isSkippedJsDocLine(line, offset, consumedThrough) {
  return line.body === "" || offset < consumedThrough;
}

/** @param {string} text @param {number} offset @param {{sawTag: boolean, consumedThrough: number}} state @returns {boolean} */
function consumeTypedJsDocTag(text, offset, state) {
  const end = typedJsDocTagEnd(text, offset);
  if (end === null) return false;
  state.sawTag = true;
  state.consumedThrough = end;
  return true;
}

/** @param {string} text @param {CommentLine} line @param {number} offset @param {{sawTag: boolean, consumedThrough: number}} state @returns {boolean} */
function consumeJsDocLine(text, line, offset, state) {
  if (isSkippedJsDocLine(line, offset, state.consumedThrough)) return true;
  if (!line.body.startsWith("@")) return state.sawTag;
  return consumeTypedJsDocTag(text, offset, state);
}

/** @param {string} source @param {CommentBlock} block @param {CommentLine[]} lines @returns {boolean} */
function isFunctionalJsDoc(source, block, lines) {
  if (!isJsDocBlock(source, block)) return false;
  const text = lines.map((line) => line.body).join("\n");
  const state = { sawTag: false, consumedThrough: 0 };
  let offset = 0;
  for (const line of lines) {
    if (!consumeJsDocLine(text, line, offset, state)) return false;
    offset += line.body.length + 1;
  }
  return state.sawTag;
}

/** @param {string} first @param {number} meaningfulCount @returns {boolean} */
function isRequiredLabelExplanation(first, meaningfulCount) {
  const labels = ["SAFETY:", "FFI:", "LIFETIME:", "LIFETIME INVARIANT:"];
  const label = labels.find((candidate) => first.startsWith(candidate));
  if (label === undefined) return false;
  const next = first[label.length];
  return (
    (next === undefined || next.trim() === "") &&
    (first.slice(label.length).trim() !== "" || meaningfulCount > 1)
  );
}

/** @param {string} first @param {number} meaningfulCount @returns {boolean} */
function isRequiredHeadingExplanation(first, meaningfulCount) {
  return ["# Safety", "# FFI", "# Lifetime"].includes(first) && meaningfulCount > 1;
}

/** @param {CommentLine[]} lines @returns {boolean} */
function isRequiredExplanation(lines) {
  const meaningful = lines.map((line) => line.body).filter((body) => body !== "");
  if (meaningful.length === 0) return false;
  const first = meaningful[0];
  if (first === undefined) return false;
  return (
    isRequiredLabelExplanation(first, meaningful.length) ||
    isRequiredHeadingExplanation(first, meaningful.length)
  );
}

/** @param {CommentSpan | undefined} firstSpan @param {CommentLine[]} lines @param {number} legalHeaderOffset @returns {boolean} */
function isLegalHeaderBlock(firstSpan, lines, legalHeaderOffset) {
  return firstSpan !== undefined && firstSpan.start === legalHeaderOffset && isLegalHeader(lines);
}

/** @param {string} source @param {CommentBlock} block @param {CommentLine[]} lines @param {number} legalHeaderOffset @returns {boolean} */
function isExemptBlock(source, block, lines, legalHeaderOffset) {
  const firstSpan = block.spans[0];
  return (
    isLegalHeaderBlock(firstSpan, lines, legalHeaderOffset) ||
    isRequiredExplanation(lines) ||
    isDirectiveBlock(lines) ||
    isFunctionalJsDoc(source, block, lines)
  );
}

/** @param {{tabWidth: number}} options @returns {number} */
function validatedTabWidth(options) {
  const tabWidth = options?.tabWidth;
  if (typeof tabWidth !== "number" || !Number.isSafeInteger(tabWidth) || tabWidth < 1) {
    throw new RangeError("tabWidth must be a positive integer");
  }
  return tabWidth;
}

/** @param {CommentSpan} span @returns {boolean} */
function hasSafeCommentOffsets(span) {
  return Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end);
}

/** @param {CommentSpan} span @param {number} previousEnd @param {number} sourceLength @returns {boolean} */
function isOrderedCommentRange(span, previousEnd, sourceLength) {
  return span.start >= previousEnd && span.end > span.start && span.end <= sourceLength;
}

/** @param {string} source @param {CommentSpan} span */
function validateCommentDelimiter(source, span) {
  if (!source.startsWith("//", span.start) && !source.startsWith("/*", span.start)) {
    throw new TypeError("comment spans must start at // or /* delimiters");
  }
}

/** @param {string} source @param {CommentSpan} span @param {number} previousEnd */
function validateCommentSpan(source, span, previousEnd) {
  if (span === null || typeof span !== "object") {
    throw new TypeError("each comment span must have start and end offsets");
  }
  if (!hasSafeCommentOffsets(span) || !isOrderedCommentRange(span, previousEnd, source.length)) {
    throw new RangeError("comment spans must be valid, source-ordered, non-overlapping ranges");
  }
  validateCommentDelimiter(source, span);
}

/** @param {string} source @param {CommentSpan[]} spans */
function validateCommentSpans(source, spans) {
  let previousEnd = 0;
  for (const span of spans) {
    validateCommentSpan(source, span, previousEnd);
    previousEnd = span.end;
  }
}

/** @param {string} source @param {CommentSpan[]} spans @param {{tabWidth: number}} options @returns {number} */
function validateCommentInput(source, spans, options) {
  if (typeof source !== "string") throw new TypeError("source must be a string");
  const tabWidth = validatedTabWidth(options);
  if (!Array.isArray(spans)) throw new TypeError("spans must be an array");
  validateCommentSpans(source, spans);
  return tabWidth;
}

/** @param {string} source @param {CommentSpan[]} spans @param {number} start @returns {boolean} */
function canAppendLineComment(source, spans, start) {
  const previous = spans[start];
  const next = spans[start + 1];
  return (
    previous !== undefined && next !== undefined && areAdjacentLineComments(source, previous, next)
  );
}

/** @param {string} source @param {CommentSpan[]} spans @param {number} start @returns {number} */
function lineCommentBlockEnd(source, spans, start) {
  let end = start + 1;
  while (end < spans.length && canAppendLineComment(source, spans, end - 1)) end++;
  return end;
}

/** @param {string} source @param {CommentSpan[]} spans @param {number} start @returns {{block: CommentBlock, nextSpanIndex: number}} */
function commentBlockAt(source, spans, start) {
  const first = spans[start];
  if (first === undefined) throw new RangeError("comment block span is missing");
  const kind = isLineComment(source, first) ? "line" : "block";
  const nextSpanIndex = kind === "line" ? lineCommentBlockEnd(source, spans, start) : start + 1;
  return { block: { kind, spans: spans.slice(start, nextSpanIndex) }, nextSpanIndex };
}

/** @param {CommentLine[]} lines @param {CommentViolation[]} violations */
function addCommentLineCountViolation(lines, violations) {
  if (lines.length <= MAX_COMMENT_LINES) return;
  const firstLine = lines[0];
  if (firstLine === undefined) return;
  violations.push({
    line: firstLine.line,
    column: firstLine.column,
    message: `Comment block uses ${lines.length} physical lines; maximum is ${MAX_COMMENT_LINES}.`,
  });
}

/** @param {CommentLine[]} lines @returns {number} */
function firstContentLine(lines) {
  let index = 0;
  while (index < lines.length && lines[index]?.body === "") index++;
  return index;
}

/** @param {CommentLine[]} lines @param {number} firstContent @returns {number} */
function lastContentLine(lines, firstContent) {
  let index = lines.length - 1;
  while (index >= firstContent && lines[index]?.body === "") index--;
  return index;
}

/** @param {CommentLine[]} lines @param {CommentViolation[]} violations */
function addInteriorBlankLineViolations(lines, violations) {
  const firstContent = firstContentLine(lines);
  const lastContent = lastContentLine(lines, firstContent);
  for (let index = firstContent + 1; index < lastContent; index++) {
    const line = lines[index];
    if (line !== undefined && line.body === "") {
      violations.push({
        line: line.line,
        column: line.column,
        message: "Comment block has a blank interior line; remove it or split the block.",
      });
    }
  }
}

/** @param {CommentLine[]} lines @param {number} tabWidth @param {CommentViolation[]} violations */
function addCommentWidthViolations(lines, tabWidth, violations) {
  for (const line of lines) {
    if (line.visualWidth > MAX_COMMENT_COLUMNS) {
      violations.push({
        line: line.line,
        column: line.column,
        message: `Comment line is ${line.visualWidth} columns; maximum is ${MAX_COMMENT_COLUMNS} (tab stops: ${tabWidth}, code points count once).`,
      });
    }
  }
}

/** @param {CommentLine[]} lines @param {number} tabWidth @param {CommentViolation[]} violations */
function addCommentBlockViolations(lines, tabWidth, violations) {
  addCommentLineCountViolation(lines, violations);
  addInteriorBlankLineViolations(lines, violations);
  addCommentWidthViolations(lines, tabWidth, violations);
}

/** @param {string} source @param {CommentBlock} block @param {PhysicalLine[]} physicalLines @param {number} lineCursor @param {number} tabWidth @param {number} legalHeaderOffset @param {CommentViolation[]} violations @returns {number} */
function checkCommentBlock(
  source,
  block,
  physicalLines,
  lineCursor,
  tabWidth,
  legalHeaderOffset,
  violations,
) {
  const result = getCommentLines(
    source,
    block.spans,
    block.kind,
    physicalLines,
    lineCursor,
    tabWidth,
  );
  if (!isExemptBlock(source, block, result.lines, legalHeaderOffset)) {
    addCommentBlockViolations(result.lines, tabWidth, violations);
  }
  return result.nextLineCursor;
}

/** @param {string} source @param {CommentSpan[]} spans @param {PhysicalLine[]} physicalLines @param {number} legalHeaderOffset @param {number} tabWidth @returns {CommentViolation[]} */
function collectCommentViolations(source, spans, physicalLines, legalHeaderOffset, tabWidth) {
  /** @type {CommentViolation[]} */
  const violations = [];
  let spanIndex = 0;
  let lineCursor = 0;
  while (spanIndex < spans.length) {
    const { block, nextSpanIndex } = commentBlockAt(source, spans, spanIndex);
    lineCursor = checkCommentBlock(
      source,
      block,
      physicalLines,
      lineCursor,
      tabWidth,
      legalHeaderOffset,
      violations,
    );
    spanIndex = nextSpanIndex;
  }
  return violations;
}

/** @param {string} source Source text; result lines are 1-based.
 * @param {CommentSpan[]} spans Ordered UTF-16 [start,end) comment ranges.
 * @param {{tabWidth: number}} options Include indentation; tabs use tabWidth stops.
 * @returns {CommentViolation[]} Columns are 0-based UTF-16; code points count once. */
export function checkCommentBlocks(source, spans, options) {
  const tabWidth = validateCommentInput(source, spans, options);
  if (spans.length === 0) return [];

  const physicalLines = getPhysicalLines(source);
  const legalHeaderOffset = getLegalHeaderOffset(source);
  return collectCommentViolations(source, spans, physicalLines, legalHeaderOffset, tabWidth);
}
