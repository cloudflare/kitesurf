// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Minting a boa proxy for a V8 value ran boa's Proxy constructor through the VM, whose stack
// check threw within a few slots of the limit, and the bridge panicked on that.
import { expect } from "vitest";

import { test } from "./harness";
import { setContent } from "./set-content";

test("deep boa recursion that mints V8 proxies hits the stack limit, never a panic", async ({
  page,
}) => {
  await setContent(page, "<script>window.mkObj = (i) => ({ i });</script>");
  const outcomes = new Map<string, number>();
  // Each pad shifts the starting stack height by one slot, so across them some
  // level's mint lands within the constructor's last few slots before the limit.
  for (let pad = 0; pad < 64; pad++) {
    const outcome = await page
      .evaluate((pad: number) => {
        const mkObj: unknown = Reflect.get(globalThis, "mkObj");
        if (typeof mkObj !== "function") throw new Error("missing mkObj");
        const names = Array.from({ length: 60 }, (_, k) => "a" + k);
        const body =
          "var " +
          names.map((n, k) => n + "=n+" + k).join(",") +
          ";" +
          "var o = mkObj(n); return rec(n + 1) + " +
          names.join("+") +
          ";";
        const make: unknown = new Function("mkObj", "return function rec(n){" + body + "}");
        if (typeof make !== "function") throw new Error("no recursion factory");
        const rec: unknown = Reflect.apply(make, undefined, [mkObj]);
        if (typeof rec !== "function") throw new Error("no recursion");
        Reflect.apply(() => Reflect.apply(rec, undefined, [0]), undefined, new Array(pad).fill(0));
        return "returned";
      }, pad)
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    const kind = /PanicError|cannot throw/.test(outcome)
      ? "panic: " + outcome.slice(0, 160)
      : /RuntimeLimit|stack size|call stack/i.test(outcome)
        ? "stack limit"
        : outcome.slice(0, 160);
    outcomes.set(kind, (outcomes.get(kind) ?? 0) + 1);
  }
  expect(Object.fromEntries(outcomes)).toEqual({ "stack limit": 64 });
  const after = await page.evaluate(() => {
    const mkObj: unknown = Reflect.get(globalThis, "mkObj");
    if (typeof mkObj !== "function") throw new Error("missing mkObj");
    return Reflect.apply(mkObj, undefined, [7]);
  });
  expect(after, "the page still crosses into V8 afterwards").toEqual({ i: 7 });
}, 180_000);
