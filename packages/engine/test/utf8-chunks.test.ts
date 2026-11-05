// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { forEachUtf8Chunk } from "../src/utf8-chunks.ts";

const chunksOf = (text: string, units: number) => {
  const chunks: Uint8Array[] = [];
  forEachUtf8Chunk(text, units, (bytes) => chunks.push(bytes.slice()));
  return chunks;
};

const joined = (chunks: Uint8Array[]) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
};

describe("forEachUtf8Chunk", () => {
  // Pairs land on every chunk boundary; a lone surrogate still becomes U+FFFD as in encode().
  const text = "a\u{1f600}é\u{1f600}\u{1f600}b\ud800c𝔽\udc00".repeat(3);

  it("joins to TextEncoder.encode at every chunk size", () => {
    const whole = new TextEncoder().encode(text);
    for (const units of [1, 2, 3, 4, 5, 7, 64]) {
      expect(joined(chunksOf(text, units)), `chunks of ${units} units`).toEqual(whole);
    }
  });

  it("never splits a character", () => {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    for (const chunk of chunksOf(text, 3)) expect(() => decoder.decode(chunk)).not.toThrow();
  });

  it("calls nothing for an empty string", () => {
    expect(chunksOf("", 4)).toEqual([]);
  });
});
