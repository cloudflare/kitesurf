// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { decodePng } from "./png";

const HTML = `<!doctype html>
<html><body style="margin:0;background:#fff">
<div style="font-size:64px;line-height:80px;color:#000" id="row">
数学の賞フィールズ賞は数学者に授与される
</div>
</body></html>`;

function isInk(r: number, g: number, b: number): boolean {
  return r < 100 && g < 100 && b < 100;
}

function inkPixels(png: { width: number; height: number; pixels: Uint8Array | number[] }): number {
  let ink = 0;
  const rows = Math.min(180, png.height);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.pixels[i] as number;
      const g = png.pixels[i + 1] as number;
      const b = png.pixels[i + 2] as number;
      if (isInk(r, g, b)) ink += 1;
    }
  }
  return ink;
}

test("page-renderer-cjk-stripped-fonts", async ({ page, cdpSession }) => {
  await page.goto(`data:text/html,${encodeURIComponent(HTML)}`, {
    timeout: 20_000,
  });
  const viaRenderer = decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
  const info = await cdpSession.send("Kitesurf.getRendererInfo");
  expect(info.framesRendered, "scene path produced the frame").toBeGreaterThanOrEqual(1);
  expect(inkPixels(viaRenderer), "renderer path paints CJK glyphs").toBeGreaterThan(2000);
});
