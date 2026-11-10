// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Splits selector lists at top-level commas without breaking nested syntax.

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
      out.push(text.slice(segStart, i));
      segStart = i + 1;
    }
  }
  out.push(text.slice(segStart));
  return out;
}
