// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import {
  MAX_ENTRY_BYTES,
  dropConnectionImages,
  dropTargetImages,
  getFontBytes,
  getImageBytes,
  imageStoreStats,
  putAuthorFont,
  putOpaqueImage,
} from "../src/eval/resource-store.ts";

const ENGINE_KEY_MARKER = 1n << 63n;

function bytes(n: number, fill = 7): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

describe("resource-store", () => {
  it("mints distinct keys with the engine marker", () => {
    const a = putOpaqueImage(bytes(8), "conn-a", "frame-a");
    const b = putOpaqueImage(bytes(8), "conn-a", "frame-a");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a! & ENGINE_KEY_MARKER).toBe(ENGINE_KEY_MARKER);
    expect(a! <= 0xffffffffffffffffn).toBe(true);
    expect(a).not.toBe(b);
    dropConnectionImages("conn-a");
  });

  it("serves a payload only to the connection that fetched it", () => {
    const key = putOpaqueImage(bytes(16, 3), "conn-a", "frame-a")!;
    expect(getImageBytes(key, "conn-b")).toBeNull();
    expect(getImageBytes(key, "")).toBeNull();
    expect(getImageBytes(key, "conn-a")).toEqual(bytes(16, 3));
    dropConnectionImages("conn-a");
  });

  it("serves any target within the connection, since that is one client", () => {
    const key = putOpaqueImage(bytes(4), "conn-a", "frame-a")!;
    expect(getImageBytes(key, "conn-a")).not.toBeNull();
    dropConnectionImages("conn-a");
  });

  it("keeps the payload across reads, so a renderer eviction can re-pull", () => {
    const key = putOpaqueImage(bytes(32), "conn-a", "frame-a")!;
    expect(getImageBytes(key, "conn-a")).not.toBeNull();
    expect(getImageBytes(key, "conn-a")).not.toBeNull();
    dropConnectionImages("conn-a");
  });

  it("declines an entry over the per-entry ceiling", () => {
    const before = imageStoreStats().count;
    expect(putOpaqueImage(bytes(MAX_ENTRY_BYTES + 1), "conn-a", "f")).toBeNull();
    expect(putOpaqueImage(bytes(0), "conn-a", "f")).toBeNull();
    expect(imageStoreStats().count).toBe(before);
  });

  it("evicts least-recently-read entries over the total ceiling", () => {
    const mb = 1024 * 1024;
    const mustPut = (seed: number): bigint => {
      const key = putOpaqueImage(bytes(5 * mb, seed), "conn-a", "frame-a");
      if (key === null) throw new Error(`putOpaqueImage refused seed ${seed}`);
      return key;
    };
    const first = mustPut(0);
    const second = mustPut(1);
    mustPut(2);
    expect(getImageBytes(first, "conn-a")).not.toBeNull();
    putOpaqueImage(bytes(5 * mb, 9), "conn-a", "frame-a");
    expect(imageStoreStats().bytes).toBeLessThanOrEqual(16 * mb);
    expect(getImageBytes(second, "conn-a")).toBeNull();
    expect(getImageBytes(first, "conn-a")).not.toBeNull();
    dropConnectionImages("conn-a");
    expect(imageStoreStats()).toEqual({ bytes: 0, count: 0 });
  });

  it("charges per-entry overhead, so tiny payloads cannot be unbounded", () => {
    const before = imageStoreStats();
    const key = putOpaqueImage(bytes(10), "conn-a", "frame-a")!;
    const after = imageStoreStats();
    expect(after.bytes - before.bytes).toBeGreaterThan(10);
    dropConnectionImages("conn-a");
    expect(getImageBytes(key, "conn-a")).toBeNull();
    expect(imageStoreStats()).toEqual(before);
  });

  it("bounds the entry count via the charged budget", () => {
    for (let i = 0; i < 100_000; i++) putOpaqueImage(bytes(10), "conn-a", "f");
    const stats = imageStoreStats();
    expect(stats.bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(stats.count).toBeLessThan(100_000);
    dropConnectionImages("conn-a");
    expect(imageStoreStats()).toEqual({ bytes: 0, count: 0 });
  });

  it("retires one target's images on navigate and leaves siblings alone", () => {
    const a = putOpaqueImage(bytes(8), "conn-a", "frame-a")!;
    const b = putOpaqueImage(bytes(8), "conn-a", "frame-b")!;
    dropTargetImages("conn-a", "frame-a");
    expect(getImageBytes(a, "conn-a")).toBeNull();
    expect(getImageBytes(b, "conn-a")).not.toBeNull();
    dropConnectionImages("conn-a");
  });

  it("sweeps every target of a closing connection", () => {
    const a = putOpaqueImage(bytes(8), "conn-a", "frame-a")!;
    const b = putOpaqueImage(bytes(8), "conn-a", "frame-b")!;
    const other = putOpaqueImage(bytes(8), "conn-b", "frame-a")!;
    dropConnectionImages("conn-a");
    expect(getImageBytes(a, "conn-a")).toBeNull();
    expect(getImageBytes(b, "conn-a")).toBeNull();
    expect(getImageBytes(other, "conn-b")).not.toBeNull();
    dropConnectionImages("conn-b");
    expect(imageStoreStats()).toEqual({ bytes: 0, count: 0 });
  });

  it("keeps author fonts under their own key space and read function", () => {
    const img = putOpaqueImage(bytes(8), "conn-a", "frame-a")!;
    const font = putAuthorFont(bytes(16), "conn-a", "frame-a")!;
    expect(getFontBytes(font, "conn-a")).not.toBeNull();
    expect(getImageBytes(img, "conn-a")).not.toBeNull();
    expect(getFontBytes(img, "conn-a")).toBeNull();
    expect(getImageBytes(font, "conn-a")).toBeNull();
    expect(getFontBytes(font, "conn-b")).toBeNull();
    dropConnectionImages("conn-a");
    expect(imageStoreStats()).toEqual({ bytes: 0, count: 0 });
  });

  it("does not let image churn evict a font", () => {
    const font = putAuthorFont(bytes(1024), "conn-a", "frame-a")!;
    for (let i = 0; i < 40; i++) {
      putOpaqueImage(bytes(1024 * 1024), "conn-a", "frame-a");
    }
    expect(getFontBytes(font, "conn-a")).not.toBeNull();
    dropConnectionImages("conn-a");
    expect(imageStoreStats()).toEqual({ bytes: 0, count: 0 });
  });

  it("sweeps both kinds on navigate and on WS close", () => {
    const fontA = putAuthorFont(bytes(32), "conn-a", "frame-a")!;
    const fontB = putAuthorFont(bytes(32), "conn-a", "frame-b")!;
    dropTargetImages("conn-a", "frame-a");
    expect(getFontBytes(fontA, "conn-a")).toBeNull();
    expect(getFontBytes(fontB, "conn-a")).not.toBeNull();
    dropConnectionImages("conn-a");
    expect(getFontBytes(fontB, "conn-a")).toBeNull();
    expect(imageStoreStats()).toEqual({ bytes: 0, count: 0 });
  });

  it("declines a font past the per-entry ceiling", () => {
    expect(putAuthorFont(bytes(MAX_ENTRY_BYTES + 1), "conn-a", "f")).toBeNull();
    expect(imageStoreStats()).toEqual({ bytes: 0, count: 0 });
  });

  it("one connection's font churn does not evict another's", () => {
    const mine = putAuthorFont(bytes(4096), "conn-a", "frame-a")!;
    for (let i = 0; i < 24; i++) {
      putAuthorFont(bytes(1024 * 1024), "conn-b", "frame-b");
    }
    expect(getFontBytes(mine, "conn-a")).not.toBeNull();
    dropConnectionImages("conn-a");
    dropConnectionImages("conn-b");
    expect(imageStoreStats()).toEqual({ bytes: 0, count: 0 });
  });

  it("one connection's image churn does not evict another's", () => {
    const mine = putOpaqueImage(bytes(4096), "conn-a", "frame-a")!;
    for (let i = 0; i < 8; i++) {
      putOpaqueImage(bytes(MAX_ENTRY_BYTES), "conn-b", "frame-b");
    }
    expect(getImageBytes(mine, "conn-a")).not.toBeNull();
    expect(imageStoreStats().bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    dropConnectionImages("conn-a");
    dropConnectionImages("conn-b");
    expect(imageStoreStats()).toEqual({ bytes: 0, count: 0 });
  });

  it("a newcomer reclaims from the connection holding the most", () => {
    const mb = 1024 * 1024;
    const small = putOpaqueImage(bytes(2 * mb), "conn-a", "frame-a")!;
    const big = putOpaqueImage(bytes(6 * mb), "conn-b", "frame-b")!;
    putOpaqueImage(bytes(6 * mb), "conn-b", "frame-b");
    putOpaqueImage(bytes(4 * mb), "conn-c", "frame-c");
    expect(getImageBytes(small, "conn-a")).not.toBeNull();
    expect(getImageBytes(big, "conn-b")).toBeNull();
    for (const c of ["conn-a", "conn-b", "conn-c"]) dropConnectionImages(c);
    expect(imageStoreStats()).toEqual({ bytes: 0, count: 0 });
  });

  it("a single connection over the ceiling still evicts its own", () => {
    const first = putAuthorFont(bytes(1024 * 1024), "conn-a", "frame-a")!;
    for (let i = 0; i < 24; i++) {
      putAuthorFont(bytes(1024 * 1024), "conn-a", "frame-a");
    }
    expect(getFontBytes(first, "conn-a")).toBeNull();
    const stats = imageStoreStats();
    expect(stats.bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    dropConnectionImages("conn-a");
    expect(imageStoreStats()).toEqual({ bytes: 0, count: 0 });
  });

  it("bounds the font entry count, so eviction never walks far", () => {
    for (let i = 0; i < 5_000; i++) putAuthorFont(bytes(16), "conn-a", "f");
    expect(imageStoreStats().count).toBeLessThanOrEqual(256);
    dropConnectionImages("conn-a");
    expect(imageStoreStats()).toEqual({ bytes: 0, count: 0 });
  });
});
