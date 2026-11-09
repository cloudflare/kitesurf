// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Encodes a string to UTF-8 a bounded chunk at a time, for streaming it into wasm.

const encoder = new TextEncoder();

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;

/**
 * Calls `onChunk` with `text` as UTF-8, `chunkUnits` at a time, in one reused buffer that is valid
 * only during the call; the chunks join to `TextEncoder.encode(text)` and never split a character.
 */
export function forEachUtf8Chunk(
  text: string,
  chunkUnits: number,
  onChunk: (bytes: Uint8Array) => void,
): void {
  const units = Math.max(2, Math.floor(chunkUnits));
  // Each UTF-16 unit encodes to at most three bytes.
  const buffer = new Uint8Array(units * 3);
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + units, text.length);
    // A surrogate pair split across chunks would encode as two replacement characters.
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end--;
    const { written } = encoder.encodeInto(text.slice(start, end), buffer);
    onChunk(buffer.subarray(0, written));
    start = end;
  }
}
