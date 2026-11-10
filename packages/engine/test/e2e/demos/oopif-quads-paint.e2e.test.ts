// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { decodePng, sample, near } from "./png";

test("oopif-quads-paint", async ({ page }) => {
  await page.goto("http://localhost:8787/__fixtures/oopif-host-quads.html", {
    waitUntil: "load",
    timeout: 60000,
  });

  const shot = new Uint8Array(await page.screenshot({ type: "png" }));
  const png = decodePng(shot);

  const cases: Array<[string, number, number, [number, number, number]]> = [
    ["TL red center", 120, 95, [255, 0, 0]],
    ["TR green center", 320, 95, [0, 255, 0]],
    ["BL blue center", 120, 245, [0, 0, 255]],
    ["BR yellow center", 320, 245, [255, 255, 0]],
    ["TL near-corner", 25, 25, [255, 0, 0]],
    ["BR near-corner", 415, 315, [255, 255, 0]],
    ["outside iframe (right)", 500, 100, [255, 255, 255]],
    ["outside iframe (below)", 200, 350, [255, 255, 255]],
  ];
  for (const [label, x, y, want] of cases) {
    const got = sample(png, x, y);
    expect(
      near(got, want),
      `${label} @(${x},${y}): got rgb(${got.join(",")}) want rgb(${want.join(",")})`,
    ).toBe(true);
  }
});

test("foreign frame pixels bypass a shadowed DOM method", async ({ page }) => {
  await page.evaluateOnNewDocument(`(() => {
    const dom = globalThis[Symbol.for("kitesurf.internals")].domDebug;
    const real = dom.setIframeImage;
    globalThis.__bitmapCaptured = false;
    dom.setIframeImage = function (...args) {
      globalThis.__bitmapCaptured = true;
      return Reflect.apply(real, dom, args);
    };
    globalThis.__restoreBitmap = () => { delete dom.setIframeImage; };
  })()`);
  try {
    await page.goto("http://localhost:8787/__fixtures/oopif-host-quads.html", {
      waitUntil: "load",
      timeout: 60000,
    });
    const png = decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
    expect(near(sample(png, 120, 95), [255, 0, 0])).toBe(true);
    expect(await page.evaluate("globalThis.__bitmapCaptured")).toBe(false);
  } finally {
    await page.evaluate("globalThis.__restoreBitmap()");
  }
}, 120_000);
