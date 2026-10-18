// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { decodePng } from "./png";

const HTML = `<!doctype html>
<html><body style="margin:0;background:#fff">
<div style="font-size:64px;line-height:80px;font-family:sans-serif" id="row">
😀🔥🍕❤️
</div>
</body></html>`;

function colorfulPixels(png: {
  width: number;
  height: number;
  pixels: Uint8Array | number[];
}): number {
  let colorful = 0;
  const rows = Math.min(90, png.height);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.pixels[i] as number;
      const g = png.pixels[i + 1] as number;
      const b = png.pixels[i + 2] as number;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max - min > 60) colorful += 1;
    }
  }
  return colorful;
}

test("page-renderer-emoji-stripped-fonts", async ({ page, cdpSession }) => {
  await page.goto(`data:text/html,${encodeURIComponent(HTML)}`, {
    timeout: 20_000,
  });
  await new Promise((r) => setTimeout(r, 800));

  const viaRenderer = decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
  const info = await cdpSession.send("Kitesurf.getRendererInfo");
  expect(info.framesRendered, "scene path produced the frame").toBeGreaterThanOrEqual(1);
  expect(colorfulPixels(viaRenderer), "renderer path paints color emoji").toBeGreaterThan(500);
});
