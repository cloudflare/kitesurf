// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { bbox, decodePng } from "./png";
import html from "./html/fixed-position.html?raw";

async function setup(page: Page) {
  await page.setViewport({ width: 600, height: 300 });
  await setContent(page, html, { waitUntil: "domcontentloaded" });
}

test("position:fixed stays pinned to the viewport while the document scrolls", async ({ page }) => {
  await setup(page);

  const rects = await page.evaluate(() => {
    const r = (id: string) => {
      const b = document.getElementById(id)!.getBoundingClientRect();
      return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
    };
    const before = r("bar");
    window.scrollTo(0, 500);
    return {
      before,
      scrollY: window.pageYOffset,
      bar: r("bar"),
      inbar: r("inbar"),
      abs: r("abs"),
      stick: r("stick"),
    };
  });

  expect(rects).toEqual({
    before: [20, 10, 200, 40],
    scrollY: 500,
    bar: [20, 10, 200, 40],
    inbar: [25, 15, 50, 10],
    abs: [30, -440, 80, 20],
    stick: [0, 15, 100, 30],
  });
}, 120_000);

test("position:fixed stays pinned after wheel-scrolling to the document end", async ({ page }) => {
  await setup(page);

  await page.mouse.move(300, 150);
  for (let i = 0; i < 20; i++) {
    await page.mouse.wheel({ deltaY: 200 });
  }

  const state = await page.evaluate(() => {
    const b = document.getElementById("bar")!.getBoundingClientRect();
    const s = document.getElementById("stick")!.getBoundingClientRect();
    return {
      scrollY: Math.round(window.pageYOffset),
      bar: [Math.round(b.x), Math.round(b.y)],
      stick: [Math.round(s.x), Math.round(s.y)],
    };
  });

  expect(state.scrollY).toBeGreaterThan(1000);
  expect(state.bar).toEqual([20, 10]);
  expect(state.stick).toEqual([0, 15]);

  const png = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));
  const magenta = (r: number, g: number, b: number) => r > 150 && g < 80 && b > 150;
  expect(bbox(png, 0, png.height, magenta)).toBeNull();
}, 120_000);
