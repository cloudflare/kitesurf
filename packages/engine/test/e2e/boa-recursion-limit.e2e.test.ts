// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// x.com's React commit recursed a few hundred frames deep on boa from an event listener and hit
// a recursion limit of 256 that counted plain call frames with runs nested on the native stack.
import { expect } from "vitest";

import { test } from "./harness";
import { setContent } from "./set-content";

test("boa recursion far deeper than 256 frames runs from an event listener", async ({ page }) => {
  await setContent(page, "<!doctype html><title>t</title>");
  const depth = await page.evaluate(() => {
    const down = (n: number): number => (n === 0 ? 0 : 1 + across(n - 1));
    const across = (n: number): number => (n === 0 ? 0 : 1 + down(n - 1));
    let got = -1;
    document.addEventListener("deep", () => {
      got = down(4000);
    });
    document.dispatchEvent(new Event("deep"));
    return got;
  });
  expect(depth).toBe(4000);
});

test("runs nested on the native stack stay bounded", async ({ page }) => {
  await setContent(page, "<script>globalThis.__apply = (fn) => fn();</script>");
  const viaCallback = await page
    .evaluate(() => {
      const f = (): void => [0].forEach(f);
      f();
      return "returned";
    })
    .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
  expect(viaCallback).toMatch(/RuntimeLimit/);
  const viaV8 = await page
    .evaluate(() => {
      const apply: unknown = Reflect.get(globalThis, "__apply");
      if (typeof apply !== "function") throw new Error("missing __apply");
      const f = (): unknown => Reflect.apply(apply, undefined, [f]);
      f();
      return "returned";
    })
    .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
  expect(viaV8).toMatch(/RuntimeLimit|call stack/i);
  expect(await page.evaluate(() => [1, 2, 3].map((n) => n * 2).join())).toBe("2,4,6");
}, 60_000);
