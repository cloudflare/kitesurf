// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Finds markup tag spans with monotone cursors, so page-controlled documents cost linear work.
// The result intentionally keeps the byte-level behavior of the regexes it replaces (literal ">"
// inside quotes, removal inside comments, nonnested pairing) rather than HTML tree-building.

type HtmlTagName = "script" | "noscript" | "meta";

const WORD = /[A-Za-z0-9_]/;
const SPACE = /\s/;

/** End offset just past a `</name ...>` close tag at or after `from`, or -1 when there is none. */
function closingTagEnd(text: string, name: HtmlTagName, from: number): number {
  let cursor = from;
  while (cursor < text.length) {
    const close = text.indexOf("<", cursor);
    if (close < 0) return -1;
    const closeNameEnd = close + 2 + name.length;
    if (text[close + 1] !== "/" || text.slice(close + 2, closeNameEnd).toLowerCase() !== name) {
      cursor = close + 1;
      continue;
    }
    let next = closeNameEnd;
    while (next < text.length && SPACE.test(text[next] ?? "")) next++;
    if (text[next] === ">") return next + 1;
    cursor = next;
  }
  return -1;
}

/** Tag spans as `[start, end)` offsets into `text`, in document order and non-overlapping. */
export function htmlTagSpans(
  text: string,
  name: HtmlTagName,
  paired: boolean,
): Array<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf("<", pos);
    if (start < 0) break;
    const endName = start + 1 + name.length;
    // A trailing word character means this is a longer name (`<scripts>`), like a `\b` boundary.
    if (text.slice(start + 1, endName).toLowerCase() !== name || WORD.test(text[endName] ?? "")) {
      pos = start + 1;
      continue;
    }
    const gt = text.indexOf(">", endName);
    if (gt < 0) break;
    let end = gt + 1;
    if (paired) {
      const closeEnd = closingTagEnd(text, name, end);
      // An opener with no close tag removes nothing, matching the lazy regex it replaces.
      if (closeEnd < 0) break;
      end = closeEnd;
    }
    spans.push([start, end]);
    pos = end;
  }
  return spans;
}

/** Removes `spans` from `text` with one join instead of repeated growing-prefix concatenation. */
export function removeHtmlTagSpans(
  text: string,
  spans: ReadonlyArray<readonly [number, number]>,
): string {
  if (spans.length === 0) return text;
  const parts: string[] = [];
  let previousEnd = 0;
  for (const [start, end] of spans) {
    parts.push(text.slice(previousEnd, start));
    previousEnd = end;
  }
  parts.push(text.slice(previousEnd));
  return parts.join("");
}
