// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import { StyleCache } from "../src/cdp/style-cache.ts";

const sheet = (chars: number) => ({ css: "a".repeat(chars), fetchedAt: 0 });

describe("StyleCache", () => {
  it("evicts the least recently used sheets once retained text passes the cap", () => {
    const cache = new StyleCache(10);
    cache.set("a", sheet(4));
    cache.set("b", sheet(4));
    expect(cache.get("a")).toBeDefined();
    cache.set("c", sheet(4));
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.retainedChars).toBe(8);
  });

  it("replaces an entry without double-counting it, and skips a sheet over the cap", () => {
    const cache = new StyleCache(10);
    cache.set("a", sheet(4));
    cache.set("a", sheet(6));
    expect(cache.retainedChars).toBe(6);
    cache.set("big", sheet(11));
    expect(cache.get("big")).toBeUndefined();
    expect(cache.get("a")?.css.length).toBe(6);
  });
});
