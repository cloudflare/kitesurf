// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Splits selector lists at top-level commas without breaking nested syntax.

// A sheet's selector text can be secret (a sheet the page cannot read), so splitting it must not
// call anything the page can replace. Capture the natives before page code runs.
const nativeApply = Reflect.apply;
const nativePush = Array.prototype.push;
const nativeSlice = String.prototype.slice;
const nativeTrim = String.prototype.trim;

export function splitSelectorList(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let segStart = 0;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quote) {
      if (character === "\\") {
        i++;
        continue;
      }
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "\\") {
      i++;
      continue;
    }
    if (character === "(" || character === "[") {
      depth++;
      continue;
    }
    if (character === ")" || character === "]") {
      if (depth > 0) depth--;
      continue;
    }
    if (character === "," && depth === 0) {
      nativeApply(nativePush, out, [nativeApply(nativeSlice, text, [segStart, i])]);
      segStart = i + 1;
    }
  }
  nativeApply(nativePush, out, [nativeApply(nativeSlice, text, [segStart])]);
  return out;
}

export function trimSelector(text: string): string {
  return nativeApply(nativeTrim, text, []);
}
