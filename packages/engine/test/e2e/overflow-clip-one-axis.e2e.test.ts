// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// `overflow: clip` on one axis leaves the other axis `visible`, so the box
// clips sideways only. Paint used to clip both axes whenever either was
// non-visible, which hid everything below a page shell with
// `overflow-x: clip` (radar.cloudflare.com lost its footer).
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { bbox, decodePng } from "./png";

const isRed = (r: number, g: number, b: number) => r > 150 && g < 80 && b < 80;

const shell = (overflow: string) => `<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; background: #fff }
  .clip { width: 100px; height: 50px; ${overflow} }
  .child { width: 300px; height: 150px; background: #e00 }
</style>
<div class="clip"><div class="child"></div></div>`;

test("overflow: clip on one axis clips that axis only", async ({ page }) => {
  await page.setViewport({ width: 400, height: 200 });

  const paint = async (overflow: string) => {
    await setContent(page, shell(overflow), { waitUntil: "domcontentloaded" });
    const png = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));
    return bbox(png, 0, 200, isRed);
  };

  expect(await paint("overflow-x: clip")).toEqual({ x: 0, y: 0, w: 100, h: 150 });
  expect(await paint("overflow-y: clip")).toEqual({ x: 0, y: 0, w: 300, h: 50 });

  // Controls: both axes clipped, and hidden (which turns the other axis
  // into auto, so it clips both).
  expect(await paint("overflow: clip")).toEqual({ x: 0, y: 0, w: 100, h: 50 });
  expect(await paint("overflow-x: hidden")).toEqual({ x: 0, y: 0, w: 100, h: 50 });
  expect(await paint("")).toEqual({ x: 0, y: 0, w: 300, h: 150 });
});
