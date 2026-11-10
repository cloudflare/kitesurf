// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { afterEach, describe, expect, it } from "vitest";
import {
  RetainedText,
  parseRetainedTextCodec,
  setRetainedTextCodec,
} from "../src/retained-text.ts";

// Non-Latin-1 text and an astral character, repeated past the size below which text stays plain.
const PAGE = "<p>caf\u00e9 \u4e2d\u6587 \ud83d\ude00</p>\n".repeat(2_000);
// An emoji whose surrogate pair straddles the 32 Ki-unit stream chunk boundary.
const STRADDLE = "a".repeat(32 * 1024 - 1) + "\ud83d\ude00" + PAGE;

afterEach(() => setRetainedTextCodec({ kind: "none" }));

describe("RetainedText", () => {
  for (const codec of ["gzip:1", "gzip", "brotli:4", "brotli:9"]) {
    it(`round-trips through ${codec} and keeps fewer bytes than the string`, () => {
      setRetainedTextCodec(parseRetainedTextCodec(codec));
      const kept = new RetainedText(PAGE);
      expect(kept.text()).toBe(PAGE);
      expect(kept.length).toBe(PAGE.length);
      expect(kept.retainedBytes).toBeLessThan(PAGE.length / 10);
    });
  }

  for (const codec of ["gzip-stream", "brotli-stream"]) {
    it(`${codec} keeps the string until the background pack lands, then round-trips`, async () => {
      setRetainedTextCodec(parseRetainedTextCodec(codec));
      const kept = new RetainedText(STRADDLE);
      expect(kept.retainedBytes).toBe(STRADDLE.length * 2);
      expect(kept.text()).toBe(STRADDLE);
      await kept.settled;
      expect(kept.retainedBytes).toBeLessThan(STRADDLE.length / 10);
      expect(kept.text()).toBe(STRADDLE);
    });
  }

  it("brotli-stream lets timers run between slices of a large pack", async () => {
    setRetainedTextCodec(parseRetainedTextCodec("brotli-stream"));
    const big = "<li>row</li>\n".repeat(256 * 1024);
    let ticks = 0;
    let done = false;
    const tick = () => {
      ticks++;
      if (!done) setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
    const kept = new RetainedText(big);
    await kept.settled;
    done = true;
    // 3.25 MiB of input is six 512 KiB slices, each followed by a yield.
    expect(ticks).toBeGreaterThanOrEqual(6);
    expect(kept.text()).toBe(big);
  });

  it("keeps short text and text marked incompressible as the original string", () => {
    setRetainedTextCodec(parseRetainedTextCodec("brotli"));
    expect(new RetainedText("<p>hi</p>").retainedBytes).toBe(18);
    expect(new RetainedText(PAGE, false).retainedBytes).toBe(PAGE.length * 2);
  });

  it("keeps the codec a value was packed with after the setting changes", () => {
    setRetainedTextCodec(parseRetainedTextCodec("brotli"));
    const kept = new RetainedText(PAGE);
    setRetainedTextCodec(parseRetainedTextCodec("gzip"));
    expect(kept.text()).toBe(PAGE);
  });
});

describe("parseRetainedTextCodec", () => {
  it("falls back to the default level and to none for unknown input", () => {
    expect(parseRetainedTextCodec("gzip:3")).toEqual({ kind: "gzip", level: 3, stream: false });
    expect(parseRetainedTextCodec("gzip:42")).toEqual({ kind: "gzip", level: 6, stream: false });
    expect(parseRetainedTextCodec(" Brotli-Stream:0 ")).toEqual({
      kind: "brotli",
      level: 0,
      stream: true,
    });
    expect(parseRetainedTextCodec("brotli")).toEqual({ kind: "brotli", level: 4, stream: false });
    expect(parseRetainedTextCodec("zstd")).toEqual({ kind: "none" });
    expect(parseRetainedTextCodec("-stream")).toEqual({ kind: "none" });
    expect(parseRetainedTextCodec("none")).toEqual({ kind: "none" });
  });

  it("treats an unset or empty setting as background brotli 4", () => {
    const brotliStream = { kind: "brotli", level: 4, stream: true };
    expect(parseRetainedTextCodec(undefined)).toEqual(brotliStream);
    expect(parseRetainedTextCodec(" ")).toEqual(brotliStream);
  });
});
