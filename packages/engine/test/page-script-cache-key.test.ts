// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import { pageScriptCacheKey } from "../src/eval/page-script.ts";

describe("pageScriptCacheKey — lazy-vs-real namespace separation", () => {
  const conn = "conn-uuid";
  const target = "target-hex";
  const gen = 1;

  it("emits the canonical name for a non-lazy (Page.navigate) call", () => {
    expect(
      pageScriptCacheKey({
        connectionId: conn,
        targetId: target,
        navigateGeneration: gen,
      }),
    ).toBe(`page-${conn}-${target}-${gen}`);
  });

  it("emits the canonical name when lazy is explicitly false", () => {
    expect(
      pageScriptCacheKey({
        connectionId: conn,
        targetId: target,
        navigateGeneration: gen,
        lazy: false,
      }),
    ).toBe(`page-${conn}-${target}-${gen}`);
  });

  it("emits a `-lazy` suffix for the ensurePageScript lazy spawn", () => {
    expect(
      pageScriptCacheKey({
        connectionId: conn,
        targetId: target,
        navigateGeneration: gen,
        lazy: true,
      }),
    ).toBe(`page-${conn}-${target}-${gen}-lazy`);
  });

  it("lazy and non-lazy keys are distinct for the same (conn, target, gen)", () => {
    const real = pageScriptCacheKey({
      connectionId: conn,
      targetId: target,
      navigateGeneration: gen,
    });
    const lazy = pageScriptCacheKey({
      connectionId: conn,
      targetId: target,
      navigateGeneration: gen,
      lazy: true,
    });
    expect(real).not.toBe(lazy);
  });

  it("lazy keys at the same gen are stable across calls (cache-hit-able)", () => {
    const k1 = pageScriptCacheKey({
      connectionId: conn,
      targetId: target,
      navigateGeneration: gen,
      lazy: true,
    });
    const k2 = pageScriptCacheKey({
      connectionId: conn,
      targetId: target,
      navigateGeneration: gen,
      lazy: true,
    });
    expect(k1).toBe(k2);
  });

  it("frameId suffix distinguishes an OOPIF child from the main-frame isolate", () => {
    const main = pageScriptCacheKey({
      connectionId: conn,
      targetId: target,
      navigateGeneration: gen,
    });
    const child = pageScriptCacheKey({
      connectionId: conn,
      targetId: target,
      navigateGeneration: gen,
      frameId: "abcdef0123456789",
    });
    expect(main).not.toBe(child);
    expect(child).toBe(`page-${conn}-${target}-${gen}-oopif-abcdef01`);
    const child2 = pageScriptCacheKey({
      connectionId: conn,
      targetId: target,
      navigateGeneration: gen,
      frameId: "fedcba9876543210",
    });
    expect(child).not.toBe(child2);
  });

  it("different generations produce different keys (both lazy and non-lazy)", () => {
    const a = pageScriptCacheKey({
      connectionId: conn,
      targetId: target,
      navigateGeneration: 1,
      lazy: true,
    });
    const b = pageScriptCacheKey({
      connectionId: conn,
      targetId: target,
      navigateGeneration: 2,
      lazy: true,
    });
    expect(a).not.toBe(b);
  });
});
