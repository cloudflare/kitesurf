// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { decodePng } from "./png";

const HTML = `<!doctype html><html><body style="margin:0;background:#fff">
<div id="stack" style="position:relative;margin:10px;height:200px;background:#ff5e1f;border-radius:12px;
  box-shadow: 1px 6px 6px 0 #fff3 inset, 0 0 0px 0 #ffffff59 inset, 0 4px 12px 0 #00000005, 0 0 0px 0 #00000005, 0 2px 12px 0 #00000008"></div>
<div id="single" style="position:relative;margin:10px;height:200px;background:#ff5e1f;border-radius:12px;
  box-shadow: 1px 6px 6px 0 #fff3 inset"></div>
<div id="control" style="position:relative;margin:10px;height:100px;background:#ff5e1f;border-radius:12px"></div>
</body></html>`;

test("inset box-shadow keeps the element background painted", async ({ page }) => {
  await page.setViewport({ width: 800, height: 640 });
  await page.goto(`data:text/html,${encodeURIComponent(HTML)}`, { timeout: 15000 });

  const png = await decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
  const px = (x: number, y: number) => {
    const i = (y * png.width + x) * 4;
    return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
  };
  for (const [name, y] of [
    ["shadow-stack", 110],
    ["single-inset", 320],
    ["control", 480],
  ] as const) {
    const [r, g, b, a] = px(400, y);
    expect(a, `${name} alpha`).toBe(255);
    expect(
      Math.abs(r! - 255) + Math.abs(g! - 94) + Math.abs(b! - 31),
      `${name} rgb(${r},${g},${b})`,
    ).toBeLessThan(30);
  }
});
