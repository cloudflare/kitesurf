// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Splits selector lists at top-level commas without breaking nested syntax.

function quotedCharacter(
  text: string,
  index: number,
  quote: '"' | "'",
): { index: number; quote: '"' | "'" | null } {
  if (text[index] === "\\") return { index: index + 1, quote };
  return { index, quote: text[index] === quote ? null : quote };
}

function isQuote(character: string | undefined): character is '"' | "'" {
  return character === '"' || character === "'";
}

function isOpeningBracket(character: string | undefined): boolean {
  return character === "(" || character === "[";
}

function isClosingBracket(character: string | undefined): boolean {
  return character === ")" || character === "]";
}

function closeDepth(depth: number): number {
  return depth > 0 ? depth - 1 : depth;
}

function updateBracketDepth(
  character: string | undefined,
  depth: number,
): { depth: number; handled: boolean } {
  if (isOpeningBracket(character)) return { depth: depth + 1, handled: true };
  if (isClosingBracket(character)) return { depth: closeDepth(depth), handled: true };
  return { depth, handled: false };
}

function splitAtComma(
  out: string[],
  text: string,
  character: string | undefined,
  depth: number,
  index: number,
  segmentStart: number,
): number {
  if (character !== "," || depth !== 0) return segmentStart;
  out.push(text.slice(segmentStart, index));
  return index + 1;
}

export function splitSelectorList(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let segStart = 0;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quote) {
      const quoted = quotedCharacter(text, i, quote);
      i = quoted.index;
      quote = quoted.quote;
      continue;
    }
    if (isQuote(character)) {
      quote = character;
      continue;
    }
    const bracket = updateBracketDepth(character, depth);
    depth = bracket.depth;
    if (bracket.handled) continue;
    segStart = splitAtComma(out, text, character, depth, i, segStart);
  }
  out.push(text.slice(segStart));
  return out;
}
