// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { bbox, decodePng } from "./png";

const isLight = (r: number, g: number, b: number) => r > 180 && g > 180 && b > 180;

const PAGE = `<!doctype html><html><head><style>
  :root { --ink: #101010 }
  html.dark { --ink: #f0f0f0 }
  body { margin: 0; background: #000; font: 28px sans-serif }
  .themed { color: var(--ink) }
  .row { display: flex }
</style></head><body>
  <div class="themed row" id="flex">FLEXTEXT</div>
  <svg class="themed" id="icon" width="40" height="40" viewBox="0 0 40 40">
    <rect x="0" y="0" width="40" height="40" fill="currentColor" />
    <svg x="5" y="5" width="30" height="30" viewBox="0 0 30 30">
      <rect x="0" y="0" width="30" height="30" fill="currentColor" />
    </svg>
  </svg>
</body></html>`;

const STRUCTURAL_PAGE = `<!doctype html><html><body style="margin:0;background:#000">
  <svg id="icon" width="80" height="40" viewBox="0 0 80 40">
    <rect id="shape" x="0" y="0" width="10" height="40" fill="#f0f0f0" />
  </svg>
</body></html>`;

test("a theme flip repaints flex text and inline svg currentColor", async ({ page }) => {
  await page.setViewport({ width: 320, height: 120 });
  await page.goto("data:text/html," + encodeURIComponent(PAGE), {
    waitUntil: "domcontentloaded",
  });

  const flexBand = await page.evaluate(() => {
    const rect = document.getElementById("flex")!.getBoundingClientRect();
    return [Math.floor(rect.top), Math.ceil(rect.bottom)] as [number, number];
  });
  const iconBand = await page.evaluate(() => {
    const rect = document.getElementById("icon")!.getBoundingClientRect();
    return [Math.floor(rect.top), Math.ceil(rect.bottom)] as [number, number];
  });

  const before = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));
  expect(bbox(before, flexBand[0], flexBand[1], isLight)).toBeNull();
  expect(bbox(before, iconBand[0], iconBand[1], isLight)).toBeNull();

  await page.evaluate(() => document.getElementById("icon")!.setAttribute("opacity", "0.99"));
  await page.screenshot();

  const computed = await page.evaluate(() => {
    document.documentElement.className = "dark";
    return [
      getComputedStyle(document.getElementById("flex")!).color,
      getComputedStyle(document.getElementById("icon")!).color,
    ];
  });
  expect(computed).toEqual(["rgb(240, 240, 240)", "rgb(240, 240, 240)"]);

  const after = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));
  const flexInk = bbox(after, flexBand[0], flexBand[1], isLight);
  expect(flexInk, "flex-container text must repaint on a theme flip").not.toBeNull();
  expect(flexInk!.w).toBeGreaterThan(40);

  const iconInk = bbox(after, iconBand[0], iconBand[1], isLight);
  expect(iconInk, "inline svg currentColor must repaint on a theme flip").not.toBeNull();
  expect(iconInk!.w).toBeGreaterThan(30);
});

test("an SVG mutation after first paint rebuilds its snapshot", async ({ page }) => {
  await page.setViewport({ width: 120, height: 80 });
  await page.goto("data:text/html," + encodeURIComponent(STRUCTURAL_PAGE), {
    waitUntil: "domcontentloaded",
  });

  const band = await page.evaluate(() => {
    const rect = document.getElementById("icon")!.getBoundingClientRect();
    return [Math.floor(rect.top), Math.ceil(rect.bottom)] as [number, number];
  });
  const before = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));
  const beforeInk = bbox(before, band[0], band[1], isLight);
  expect(beforeInk).not.toBeNull();
  expect(beforeInk!.w).toBeLessThan(20);

  await page.evaluate(() => document.getElementById("shape")!.setAttribute("width", "40"));
  const after = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));
  const afterInk = bbox(after, band[0], band[1], isLight);
  expect(afterInk).not.toBeNull();
  expect(afterInk!.w).toBeGreaterThan(30);
});
