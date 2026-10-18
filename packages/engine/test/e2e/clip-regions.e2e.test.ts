// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { bbox, decodePng } from "./png";

const isRed = (r: number, g: number, b: number) => r > 150 && g < 80 && b < 80;

const HTML = `<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; background: #fff; font: 16px/1 monospace }
  .band { position: relative; height: 60px }
  .c { position: absolute; left: 8px; top: 10px; width: 200px; height: 30px;
       background: #e00 }
  #inset50 { clip-path: inset(50%) }
  #legacy-zero { clip: rect(0, 0, 0, 0) }
  #inset0 { clip-path: inset(0) }
  #rect-topleft { clip: rect(0, 60px, 20px, 0) }
  #both { clip: rect(0, 60px, 20px, 0); clip-path: inset(0 0 0 20px) }
  /* Box-relative 100,14 -> 1x1: the smallest non-empty region there is. */
  #one-pixel { clip: rect(14px, 101px, 15px, 100px) }
  /* Empty region, so only the outline can contribute red pixels. */
  #outline-only { clip-path: inset(50%); outline: 2px solid #e00 }
</style>
<div class="band"><div class="c" id="inset50"></div></div>
<div class="band"><div class="c" id="legacy-zero"></div></div>
<div class="band"><div class="c" id="inset0"></div></div>
<div class="band"><div class="c" id="rect-topleft"></div></div>
<div class="band"><div class="c" id="both"></div></div>
<div class="band"><div class="c" id="one-pixel"></div></div>
<div class="band"><div class="c" id="outline-only"></div></div>`;

test("empty clip regions hide the box and partial ones keep their extent", async ({ page }) => {
  await page.setViewport({ width: 400, height: 480 });
  await setContent(page, HTML, { waitUntil: "domcontentloaded" });

  const png = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));
  const band = (i: number) => bbox(png, i * 60, (i + 1) * 60, isRed);

  expect(band(0)).toBeNull();
  expect(band(1)).toBeNull();

  const unclipped = band(2);
  expect(unclipped).not.toBeNull();
  expect(unclipped!.x).toBe(8);
  expect(unclipped!.w).toBe(200);
  expect(unclipped!.h).toBe(30);

  expect(band(3)).toEqual({ x: 8, y: 10, w: 60, h: 20 });

  expect(band(4)).toEqual({ x: 28, y: 10, w: 40, h: 20 });

  expect(band(5)).toEqual({ x: 108, y: 24, w: 1, h: 1 });
}, 120_000);

// Outline is painted before the clip-path layer is pushed, so it survives a
// region that hides everything else. Clipping it would be the spec behaviour,
// which the legacy `clip` property follows: it wraps the outline too.

test("an empty clip region still leaves the outline ring", async ({ page }) => {
  await page.setViewport({ width: 400, height: 480 });
  await setContent(page, HTML, { waitUntil: "domcontentloaded" });

  const png = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));

  expect(bbox(png, 360, 420, isRed)).toEqual({ x: 6, y: 8, w: 204, h: 34 });
}, 120_000);
