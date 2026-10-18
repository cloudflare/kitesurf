// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("a boa function round-trips through the DOM to the same object (I3)", async ({ page }) => {
  await setContent(page, "<button id=b>b</button>");
  const same = await page.evaluate(() => {
    const el = document.getElementById("b");
    if (!el) throw new Error("missing #b");
    const f = function () {};
    el.onclick = f;
    return el.onclick === f;
  });
  expect(same).toBe(true);
});

test("the same V8 object yields the same boa proxy (I2)", async ({ page }) => {
  await setContent(page, "<p>i2</p>");
  const same = await page.evaluate(() => document.body === document.body);
  expect(same).toBe(true);
});

test("repeated method reads yield the same boa proxy (Chrome parity)", async ({ page }) => {
  await setContent(page, "<p>m</p>");
  const same = await page.evaluate(() => document.createElement === document.createElement);
  expect(same).toBe(true);
});

test("the same boa function yields one V8 wrapper across crossings (I2)", async ({ page }) => {
  await setContent(page, "<p>wrap</p>");
  const same = await page.evaluate(() => {
    const f = function () {};
    // Object.is runs on the V8 side; each argument crossing must reuse
    // the stamped wrapper or the comparison sees two distinct minted fns.
    const win: unknown = Reflect.get(globalThis, "window");
    const ctor: unknown =
      typeof win === "object" && win !== null ? Reflect.get(win, "Object") : undefined;
    const objectIs: unknown = typeof ctor === "function" ? Reflect.get(ctor, "is") : undefined;
    if (typeof objectIs !== "function") throw new Error("window.Object.is is not a function");
    return objectIs(f, f);
  });
  expect(same).toBe(true);
});

test("removeEventListener with the same boa handler removes it", async ({ page }) => {
  await setContent(page, "<button id=b>b</button>");
  const calls = await page.evaluate(() => {
    let n = 0;
    const el = document.getElementById("b");
    if (!el) throw new Error("missing #b");
    const h = () => {
      n++;
    };
    el.addEventListener("click", h);
    el.click();
    el.removeEventListener("click", h);
    el.click();
    return n;
  });
  expect(calls).toBe(1);
});

test("a V8 function stored in a boa object reads back as itself in V8", async ({ page }) => {
  // React compares props with ===. A boa-built props object holding a V8
  // setState must hand V8 the same function on every read, or effects
  // that depend on it re-run forever (Radar's stuck navigation).
  await setContent(
    page,
    `<script>
      window.f = function () {}.bind(null, 1);
      // Read through a call, not window.f: the window proxy hands out
      // its own bound shadow for prototype-less globals.
      window.getF = () => [f];
      window.inObj = (o) => o.x === f && o.x === o.x;
      window.inArr = (a) => a[0] === f;
    </script>`,
  );
  const same = await page.evaluate(() => {
    const getF: unknown = Reflect.get(globalThis, "getF");
    const inObj: unknown = Reflect.get(globalThis, "inObj");
    const inArr: unknown = Reflect.get(globalThis, "inArr");
    if (typeof getF !== "function") throw new Error("window.getF is missing");
    if (typeof inObj !== "function") throw new Error("window.inObj is missing");
    if (typeof inArr !== "function") throw new Error("window.inArr is missing");
    const [f] = getF();
    return [inObj({ x: f }), inArr([f])];
  });
  expect(same).toEqual([true, true]);
});
