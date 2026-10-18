// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { setContent } from "./set-content";
import { expect, test } from "./harness";
import { decodePng } from "./png";

test("hidden inline text, ::after content and span backgrounds do not paint", async ({ page }) => {
  await page.setViewport({ width: 600, height: 120 });
  await setContent(
    page,
    `<style>
      body { margin: 10px; font: 40px sans-serif; color: rgb(255, 0, 0); }
      .pe::after { content: "PE"; visibility: hidden; }
    </style>
    <div>
      <span id="text" style="visibility:hidden">HH</span>
      <span class="pe"></span>
      <span style="visibility:hidden;background:rgb(0,255,0)">BG</span>
      <span style="visibility:hidden"><b style="visibility:visible;color:rgb(0,0,255)">V</b></span>
      <span style="color:rgb(255,0,255)">C</span>
    </div>`,
    { waitUntil: "domcontentloaded" },
  );

  const screenshot = await page.screenshot();
  if (!(screenshot instanceof Uint8Array)) {
    throw new TypeError("expected page.screenshot() to return PNG bytes");
  }
  const png = await decodePng(screenshot);
  const count = (match: (r: number, g: number, b: number) => boolean) => {
    let n = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      if (match(png.data[i] ?? 0, png.data[i + 1] ?? 0, png.data[i + 2] ?? 0)) n++;
    }
    return n;
  };

  expect(
    count((r, g, b) => r > 200 && g < 80 && b < 80),
    "red hidden text",
  ).toBe(0);
  expect(
    count((r, g, b) => g > 200 && r < 80 && b < 80),
    "green hidden background",
  ).toBe(0);
  expect(
    count((r, g, b) => b > 200 && r < 80 && g < 80),
    "blue visible child",
  ).toBeGreaterThan(20);
  expect(
    count((r, g, b) => r > 200 && b > 200 && g < 80),
    "magenta control",
  ).toBeGreaterThan(20);

  const width = await page.evaluate(() => {
    const el = document.getElementById("text");
    if (!el) throw new Error("missing element #text");
    return el.getBoundingClientRect().width;
  });
  expect(width).toBeGreaterThan(40);
});
