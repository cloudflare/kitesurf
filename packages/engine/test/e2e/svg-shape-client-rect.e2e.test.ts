// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const PAGE = `<!doctype html>
<style>body { margin: 8px }</style>
<svg width="8000" height="8000">
  <rect width="100" height="100" fill="blue" y="1950" id="geometry"/>
  <rect width="100" height="100" fill="blue" transform="translate(0, 2950)" id="translated"/>
  <g transform="translate(300, 400)"><circle cx="50" cy="50" r="40"/></g>
</svg>`;

test("svg shapes report their bbox and scrollIntoView lands on it", async ({ page }) => {
  await page.setViewport({ width: 800, height: 600 });
  await setContent(page, PAGE);

  const out = await page.evaluate(() => {
    const rect = (el: Element) => {
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    };
    const geometry = rect(document.getElementById("geometry")!);
    const translated = rect(document.getElementById("translated")!);
    const circle = rect(document.querySelector("circle")!);
    const group = rect(document.querySelector("g")!);

    window.scrollTo(0, 0);
    document.getElementById("translated")!.scrollIntoView({ block: "start", inline: "start" });
    const scrolled = { x: window.scrollX, y: window.scrollY };
    const after = rect(document.getElementById("translated")!);
    return { geometry, translated, circle, group, scrolled, after };
  });

  expect(out.geometry).toEqual({ x: 8, y: 1958, w: 100, h: 100 });
  expect(out.translated).toEqual({ x: 8, y: 2958, w: 100, h: 100 });
  expect(out.circle).toEqual({ x: 318, y: 418, w: 80, h: 80 });
  expect(out.group).toEqual(out.circle);
  expect(out.scrolled).toEqual({ x: 8, y: 2958 });
  expect(out.after.x).toBeCloseTo(0, 3);
  expect(out.after.y).toBeCloseTo(0, 3);
});
