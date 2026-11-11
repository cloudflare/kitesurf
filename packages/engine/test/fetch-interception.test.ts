// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import { handleFetch } from "../src/cdp/fetch.ts";
import {
  ensureInterception,
  getInterception,
  interceptionMatches,
  MAX_GLOB_PATTERNS,
  unregisterInterception,
} from "../src/cdp/fetch-interception.ts";

// The exact expression Fetch.enable used to compile each urlPattern with.
const oldGlobToRegExp = (pattern: string): RegExp => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
};

// oxlint-disable-next-line kitesurf/no-chained-type-assertions -- partial dispatch context fixture.
const ctx = { connectionId: "glob-test", emit: () => {} } as unknown as DispatchCtx;

const enable = (urlPattern: string) =>
  handleFetch(ctx, { id: 1, method: "Fetch.enable", params: { patterns: [{ urlPattern }] } });

const enabled = () => {
  const st = getInterception(ctx.connectionId);
  if (!st) throw new Error("Fetch.enable did not register interception");
  return st;
};

// Old regex vs production matcher: star, question mark, backslash, CR and LF.
const cases: Array<[pattern: string, url: string]> = [
  ["*", "https://ks.invalid/a.js"],
  ["https://ks.invalid/*.js", "https://ks.invalid/a.js"],
  ["https://ks.invalid/a?c", "https://ks.invalid/a/c"],
  ["a\\b", "a\\b"],
  ["a*b", "a\rb"],
  ["a*\nb", "a\nb"],
];

describe("fetch urlPattern matching", () => {
  it("agrees with the previous regex on representative patterns", async () => {
    const matched: boolean[] = [];
    for (const [pattern, url] of cases) {
      await enable(pattern);
      matched.push(interceptionMatches(enabled(), url, "XHR"));
    }
    expect(matched).toEqual(cases.map(([pattern, url]) => oldGlobToRegExp(pattern).test(url)));
    unregisterInterception(ctx.connectionId);
  });

  it("rejects a urlPattern over the 1024-character cap", async () => {
    await expect(enable("a".repeat(1025))).rejects.toThrow(/urlPattern/);
    expect(getInterception(ctx.connectionId)).toBeUndefined();
  });

  it("rejects more patterns than the per-call cap", async () => {
    const patterns = Array.from({ length: MAX_GLOB_PATTERNS + 1 }, () => ({ urlPattern: "*" }));
    await expect(
      handleFetch(ctx, { id: 1, method: "Fetch.enable", params: { patterns } }),
    ).rejects.toThrow(/pattern limit/);
    expect(getInterception(ctx.connectionId)).toBeUndefined();
    unregisterInterception(ctx.connectionId);
  });

  it("checks resourceType before running the url glob", () => {
    const connectionId = "resource-type-first";
    const st = ensureInterception(connectionId);
    // A sentinel pattern that throws if the glob matcher reads it: a mismatched resourceType
    // must skip the glob entirely, and this sentinel is reachable only through that path.
    const sentinel = new String("a");
    sentinel.charCodeAt = () => {
      throw new Error("glob ran");
    };
    const url = "https://ks.invalid/a";
    try {
      st.patterns = [{ pattern: sentinel as string, resourceType: "Image" }];
      expect(interceptionMatches(st, url, "XHR")).toBe(false);
      st.patterns = [{ pattern: "https://ks.invalid/*", resourceType: "Image" }];
      expect(interceptionMatches(st, url, "Image")).toBe(true);
    } finally {
      unregisterInterception(connectionId);
    }
  });

  it("does not backtrack exponentially on repeated stars", async () => {
    await enable("*a".repeat(10) + "*b");
    const url = "https://ks.invalid/" + "a".repeat(34) + "!";
    const started = performance.now();
    expect(interceptionMatches(enabled(), url, "XHR")).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
    unregisterInterception(ctx.connectionId);
  }, 30_000);
});
