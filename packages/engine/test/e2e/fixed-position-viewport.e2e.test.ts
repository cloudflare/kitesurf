// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { decodePng } from "./png";

const html = `<!doctype html>
<style>
  body { margin: 0; }
  div { position: fixed; }
</style>
<p style="margin:0;height:20px">short document</p>
<div id="overlay" style="inset:0"></div>
<div id="footer" style="left:0;right:0;bottom:0;height:30px"></div>
<div id="pct" style="top:50%;left:25%;width:10px;height:10px"></div>
<div id="margins" style="top:0;bottom:0;left:0;width:10px;margin:10px 0"></div>`;

async function rects(page: Page) {
  return page.evaluate(() => {
    const out: Record<string, number[]> = {};
    for (const el of document.querySelectorAll("div[id]")) {
      const b = el.getBoundingClientRect();
      out[el.id] = [b.x, b.y, b.width, b.height].map(Math.round);
    }
    return out;
  });
}

test("position:fixed insets resolve against the viewport, not the html box", async ({ page }) => {
  await page.setViewport({ width: 600, height: 300 });
  await setContent(page, html, { waitUntil: "domcontentloaded" });

  expect(await rects(page)).toEqual({
    overlay: [0, 0, 600, 300],
    footer: [0, 270, 600, 30],
    pct: [150, 150, 10, 10],
    margins: [0, 10, 10, 280],
  });

  await page.setViewport({ width: 400, height: 500 });
  expect(await rects(page)).toEqual({
    overlay: [0, 0, 400, 500],
    footer: [0, 470, 400, 30],
    pct: [100, 250, 10, 10],
    margins: [0, 10, 10, 480],
  });
}, 120_000);

test("a fixed overflow:hidden body fills the viewport and paints", async ({ page }) => {
  await page.setViewport({ width: 400, height: 300 });
  await setContent(
    page,
    `<!doctype html>
    <body style="position:fixed;inset:0;margin:0;overflow:hidden">
      <div style="position:absolute;inset:0;background:rgb(255,0,0)"></div>
    </body>`,
    { waitUntil: "domcontentloaded" },
  );

  const body = await page.evaluate(() => {
    const b = document.body.getBoundingClientRect();
    return [b.width, b.height, document.documentElement.getBoundingClientRect().height];
  });
  expect(body).toEqual([400, 300, 0]);

  const screenshot = await page.screenshot();
  if (!(screenshot instanceof Uint8Array)) {
    throw new TypeError("expected page.screenshot() to return PNG bytes");
  }
  const png = await decodePng(screenshot);
  const at = (x: number, y: number) => {
    const i = (y * png.width + x) * 4;
    return [png.data[i], png.data[i + 1], png.data[i + 2]];
  };
  expect(at(200, 150)).toEqual([255, 0, 0]);
  expect(at(399, 299)).toEqual([255, 0, 0]);
}, 120_000);
