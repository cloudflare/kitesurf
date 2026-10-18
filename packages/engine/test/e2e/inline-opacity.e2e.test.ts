// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { bbox, decodePng } from "./png";
import { setContent } from "./set-content";

const isRed = (r: number, g: number, b: number) => r > 150 && g < 80 && b < 80;
const isPink = (r: number, g: number, b: number) =>
  r > 200 && g > 120 && g < 220 && b > 120 && b < 220;

test("inline opacity hides and fades text and span backgrounds", async ({ page }) => {
  await page.setViewport({ width: 400, height: 200 });
  await setContent(
    page,
    `<style>
      body { margin: 0; background: #fff; font: 40px/50px sans-serif; color: #e00 }
      p { margin: 0; height: 50px }
    </style>
    <p><span style="opacity: 0">HIDDEN</span></p>
    <p><b style="opacity: 0"><i>nested <u>deco</u></i></b></p>
    <p><span style="opacity: 0; background: #e00; padding: 0 10px">bg</span></p>
    <p><span style="opacity: 0.4">faint</span></p>`,
  );
  const png = await decodePng(new Uint8Array(await page.screenshot()));

  expect(bbox(png, 0, 150, isRed)).toBeNull();
  expect(bbox(png, 0, 150, isPink)).toBeNull();
  expect(bbox(png, 150, 200, isRed)).toBeNull();
  expect(bbox(png, 150, 200, isPink)).not.toBeNull();
});
