// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { forEachUtf8Chunk } from "../src/utf8-chunks.ts";

const chunksOfText = (text: string, maxUnits: number) => {
  const chunks: Uint8Array[] = [];
  forEachUtf8Chunk(text, maxUnits, (bytes) => chunks.push(bytes.slice()));
  return chunks;
};

const joinedChunks = (chunks: Uint8Array[]) => {
  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
};

describe("forEachUtf8Chunk", () => {
  // Chunk boundaries land inside pairs; a lone surrogate still becomes U+FFFD as in encode().
  const text = "a\u{1f600}é\u{1f600}\u{1f600}b\ud800c𝔽\udc00".repeat(3);

  it("joins to TextEncoder.encode at every chunk size", () => {
    const whole = new TextEncoder().encode(text);

    for (const maxUnits of [1, 2, 3, 4, 5, 7, 64]) {
      expect(joinedChunks(chunksOfText(text, maxUnits)), `chunks of ${maxUnits} units`).toEqual(
        whole,
      );
    }
  });

  it("never splits a character", () => {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

    for (const chunk of chunksOfText(text, 3)) expect(() => decoder.decode(chunk)).not.toThrow();
  });

  it("calls nothing for an empty string", () => {
    expect(chunksOfText("", 4)).toEqual([]);
  });
});
