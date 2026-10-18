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
function lineTerminatorLengthAt(source, offset) {
  const code = source.charCodeAt(offset);
  if (code === 13) return source.charCodeAt(offset + 1) === 10 ? 2 : 1;
  return code === 10 || code === 0x2028 || code === 0x2029 ? 1 : 0;
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

/** @param {string} source @param {number} start @param {number} end @param {number} tabWidth @returns {number} */
function measureColumns(source, start, end, tabWidth) {
  let columns = 0;
  for (let offset = start; offset < end;) {
    const code = source.charCodeAt(offset);
    if (code === 9) {
      columns += tabWidth - (columns % tabWidth);
      offset++;
      continue;
    }
    const next = source.charCodeAt(offset + 1);
    offset += code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? 2 : 1;
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

/** @param {string} source @param {number} start @param {number} end @param {boolean} first @param {boolean} last @returns {string} */
function blockCommentBody(source, start, end, first, last) {
  if (first) start += 2;
  if (last && source.slice(end - 2, end) === "*/") end -= 2;
  while (start < end && source.charAt(start).trim() === "") start++;
  if (source[start] === "*" || (first && source[start] === "!")) {
    start++;
    if (source[start] === " ") start++;
  }
  return source.slice(start, end).trim();
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
  /** @type {CommentLine[]} */
  const lines = [];
  if (kind === "line") {
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

  const span = spans[0];
  if (span === undefined) throw new RangeError("block comment span is missing");
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

/** @param {string} source @param {number} start @param {number} end @returns {number} */
function firstNonWhitespace(source, start, end) {
  while (start < end && source.charAt(start).trim() === "") start++;
  return start;
}

/** @param {string} value @returns {boolean} */
function hasYear(value) {
  for (let offset = 0; offset + 3 < value.length; offset++) {
    if (
      value.charCodeAt(offset) >= 48 &&
      value.charCodeAt(offset) <= 57 &&
      value.charCodeAt(offset + 1) >= 48 &&
      value.charCodeAt(offset + 1) <= 57 &&
      value.charCodeAt(offset + 2) >= 48 &&
      value.charCodeAt(offset + 2) <= 57 &&
      value.charCodeAt(offset + 3) >= 48 &&
      value.charCodeAt(offset + 3) <= 57
    )
      return true;
  }
  return false;
}

/** @param {string} value @returns {"marker" | "body" | null} */
function legalHeaderLineKind(value) {
  const lower = value.toLowerCase();
  if (value.startsWith("SPDX-License-Identifier:") && value.slice(24).trim() !== "")
    return "marker";
  if (value.startsWith("Copyright ") && hasYear(value)) return "marker";
  if (lower.startsWith("licensed under ") && lower.includes("license")) return "marker";
  if (lower === "all rights reserved.") return "marker";
  if (
    lower.startsWith("you may not use this file except in compliance with the license") ||
    lower.startsWith("you may obtain a copy of the license at") ||
    lower.startsWith("unless required by applicable law or agreed to in writing, software") ||
    lower.startsWith('distributed under the license is distributed on an "as is" basis') ||
    lower.startsWith("without warranties or conditions of any kind") ||
    lower.startsWith("see the license for the specific language governing permissions and") ||
    lower.startsWith("limitations under the license") ||
    lower.startsWith("permission is hereby granted,") ||
    lower.startsWith(
      'of this software and associated documentation files (the "software"), to deal',
    ) ||
    lower.startsWith(
      "in the software without restriction, including without limitation the rights",
    ) ||
    lower.startsWith("to use, copy, modify, merge, publish, distribute, sublicense, and/or sell") ||
    lower.startsWith("copies of the software, and to permit persons to whom the software is") ||
    lower.startsWith("furnished to do so, subject to the following conditions:") ||
    lower.startsWith("the above copyright notice and this permission notice shall be included") ||
    lower.startsWith("copies or substantial portions of the software.") ||
    lower.startsWith('the software is provided "as is"') ||
    lower.startsWith("implied, including but not limited to the warranties of") ||
    lower.startsWith("fitness for a particular purpose and noninfringement") ||
    lower.startsWith("authors or copyright holders be liable") ||
    lower.startsWith("liability, whether in an action of contract, tort or otherwise") ||
    lower.startsWith("out of or in connection with the software or the use or other dealings") ||
    lower === "software." ||
    lower.startsWith("redistribution and use in source and binary forms") ||
    lower.startsWith("redistributions of source code must retain") ||
    lower.startsWith("redistributions in binary form must reproduce") ||
    lower.startsWith("neither the name of") ||
    lower.startsWith("this software is provided by the copyright holders and contributors")
  )
    return "body";
  if ((lower.startsWith("http://") || lower.startsWith("https://")) && lower.includes("license")) {
    return "body";
  }
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

/** @param {string} source @returns {number} */
function getLegalHeaderOffset(source) {
  let offset = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  offset = skipWhitespace(source, offset);
  if (source.startsWith("#!", offset) && !source.startsWith("#![", offset)) {
    while (offset < source.length && lineTerminatorLengthAt(source, offset) === 0) offset++;
    offset += lineTerminatorLengthAt(source, offset);
    offset = skipWhitespace(source, offset);
  }
  return offset;
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

/** @param {string} value @returns {boolean} */
function isMetaDirective(value) {
  if (!value.startsWith("META:")) return false;
  let offset = 5;
  while (value[offset] === " " || value[offset] === "\t") offset++;
  const keyStart = offset;
  while (offset < value.length) {
    const code = value.charCodeAt(offset);
    if (
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 45 ||
      code === 95
    )
      offset++;
    else break;
  }
  const first = value.charCodeAt(keyStart);
  const firstIsLetter = (first >= 65 && first <= 90) || (first >= 97 && first <= 122);
  return offset > keyStart && firstIsLetter && value[offset] === "=";
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
function isDirectiveLine(value) {
  if (DIRECTIVE_PREFIXES.some((prefix) => hasDirectivePrefix(value, prefix))) return true;
  if (
    hasDirectiveValue(value, "@jest-environment") ||
    hasDirectiveValue(value, "@vitest-environment")
  ) {
    return true;
  }
  if (value.startsWith("# sourceMappingURL=") && value.slice(19).trim() !== "") return true;
  if (isMetaDirective(value) || isRustTestDirective(value)) return true;
  return false;
}

/** @param {CommentLine[]} lines @returns {boolean} */
function isDirectiveBlock(lines) {
  if (lines.length === 0) return false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined || line.body === "" || !isDirectiveLine(line.body)) return false;
  }
  return true;
}

/** @param {string} text @param {number} offset @returns {number | null} */
function typedJsDocTagEnd(text, offset) {
  const tags = ["@typedef", "@returns", "@param", "@type"];
  const tag = tags.find((candidate) => {
    const after = text[offset + candidate.length];
    return text.startsWith(candidate, offset) && (after === " " || after === "\t");
  });
  if (tag === undefined) return null;
  let cursor = offset + tag.length;
  while (text[cursor] === " " || text[cursor] === "\t") cursor++;
  if (text[cursor] !== "{") return null;
  const typeStart = cursor + 1;
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (quote !== "") {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(typeStart, cursor).trim() === "" ? null : cursor + 1;
      }
    }
  }
  return null;
}

/** @param {string} source @param {CommentBlock} block @param {CommentLine[]} lines @returns {boolean} */
function isFunctionalJsDoc(source, block, lines) {
  const firstSpan = block.spans[0];
  if (
    block.kind !== "block" ||
    firstSpan === undefined ||
    !source.startsWith("/**", firstSpan.start)
  )
    return false;
  const text = lines.map((line) => line.body).join("\n");
  /** @type {number[]} */
  const offsets = [];
  let cursor = 0;
  for (const line of lines) {
    offsets.push(cursor);
    cursor += line.body.length + 1;
  }
  let sawTag = false;
  let consumedThrough = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const lineOffset = offsets[index];
    if (line === undefined || lineOffset === undefined) continue;
    const body = line.body;
    if (body === "" || lineOffset < consumedThrough) continue;
    if (body.startsWith("@")) {
      const end = typedJsDocTagEnd(text, lineOffset);
      if (end === null) return false;
      sawTag = true;
      consumedThrough = end;
    } else if (!sawTag) {
      return false;
    }
  }
  return sawTag;
}

/** @param {CommentLine[]} lines @returns {boolean} */
function isRequiredExplanation(lines) {
  const meaningful = lines.map((line) => line.body).filter((body) => body !== "");
  if (meaningful.length === 0) return false;
  const first = meaningful[0];
  if (first === undefined) return false;
  const labels = ["SAFETY:", "FFI:", "LIFETIME:", "LIFETIME INVARIANT:"];
  const label = labels.find((candidate) => first.startsWith(candidate));
  if (label !== undefined) {
    const next = first[label.length];
    return (
      (next === undefined || next.trim() === "") &&
      (first.slice(label.length).trim() !== "" || meaningful.length > 1)
    );
  }
  const headings = ["# Safety", "# FFI", "# Lifetime"];
  return headings.includes(first) && meaningful.length > 1;
}

/** @param {string} source @param {CommentBlock} block @param {CommentLine[]} lines @param {number} legalHeaderOffset @returns {boolean} */
function isExemptBlock(source, block, lines, legalHeaderOffset) {
  const firstSpan = block.spans[0];
  if (firstSpan === undefined) return false;
  return (
    (firstSpan.start === legalHeaderOffset && isLegalHeader(lines)) ||
    isRequiredExplanation(lines) ||
    isDirectiveBlock(lines) ||
    isFunctionalJsDoc(source, block, lines)
  );
}

/** @param {string} source Source text; result lines are 1-based.
 * @param {CommentSpan[]} spans Ordered UTF-16 [start,end) comment ranges.
 * @param {{tabWidth: number}} options Include indentation; tabs use tabWidth stops.
 * @returns {CommentViolation[]} Columns are 0-based UTF-16; code points count once. */
export function checkCommentBlocks(source, spans, options) {
  if (typeof source !== "string") throw new TypeError("source must be a string");
  const tabWidth = options?.tabWidth;
  if (typeof tabWidth !== "number" || !Number.isSafeInteger(tabWidth) || tabWidth < 1) {
    throw new RangeError("tabWidth must be a positive integer");
  }
  if (!Array.isArray(spans)) throw new TypeError("spans must be an array");

  let previousEnd = 0;
  for (const span of spans) {
    if (span === null || typeof span !== "object") {
      throw new TypeError("each comment span must have start and end offsets");
    }
    if (
      !Number.isSafeInteger(span.start) ||
      !Number.isSafeInteger(span.end) ||
      span.start < previousEnd ||
      span.end <= span.start ||
      span.end > source.length
    ) {
      throw new RangeError("comment spans must be valid, source-ordered, non-overlapping ranges");
    }
    if (!source.startsWith("//", span.start) && !source.startsWith("/*", span.start)) {
      throw new TypeError("comment spans must start at // or /* delimiters");
    }
    previousEnd = span.end;
  }
  if (spans.length === 0) return [];

  const physicalLines = getPhysicalLines(source);
  const legalHeaderOffset = getLegalHeaderOffset(source);
  /** @type {CommentViolation[]} */
  const violations = [];
  let spanIndex = 0;
  let lineCursor = 0;
  while (spanIndex < spans.length) {
    const first = spans[spanIndex];
    if (first === undefined) break;
    /** @type {"line" | "block"} */
    const kind = isLineComment(source, first) ? "line" : "block";
    let endIndex = spanIndex + 1;
    if (kind === "line") {
      while (endIndex < spans.length) {
        const previous = spans[endIndex - 1];
        const next = spans[endIndex];
        if (
          previous === undefined ||
          next === undefined ||
          !areAdjacentLineComments(source, previous, next)
        )
          break;
        endIndex++;
      }
    }
    /** @type {CommentBlock} */
    const block = { kind, spans: spans.slice(spanIndex, endIndex) };
    const result = getCommentLines(source, block.spans, kind, physicalLines, lineCursor, tabWidth);
    lineCursor = result.nextLineCursor;
    spanIndex = endIndex;
    if (isExemptBlock(source, block, result.lines, legalHeaderOffset)) continue;

    if (result.lines.length > MAX_COMMENT_LINES) {
      const firstLine = result.lines[0];
      if (firstLine !== undefined) {
        violations.push({
          line: firstLine.line,
          column: firstLine.column,
          message: `Comment block uses ${result.lines.length} physical lines; maximum is ${MAX_COMMENT_LINES}.`,
        });
      }
    }

    let firstContent = 0;
    while (firstContent < result.lines.length) {
      const line = result.lines[firstContent];
      if (line === undefined || line.body !== "") break;
      firstContent++;
    }
    let lastContent = result.lines.length - 1;
    while (lastContent >= firstContent) {
      const line = result.lines[lastContent];
      if (line === undefined || line.body !== "") break;
      lastContent--;
    }
    for (let index = firstContent + 1; index < lastContent; index++) {
      const line = result.lines[index];
      if (line !== undefined && line.body === "") {
        violations.push({
          line: line.line,
          column: line.column,
          message: "Comment block has a blank interior line; remove it or split the block.",
        });
      }
    }

    for (const line of result.lines) {
      if (line.visualWidth > MAX_COMMENT_COLUMNS) {
        violations.push({
          line: line.line,
          column: line.column,
          message: `Comment line is ${line.visualWidth} columns; maximum is ${MAX_COMMENT_COLUMNS} (tab stops: ${tabWidth}, code points count once).`,
        });
      }
    }
  }
  return violations;
}
