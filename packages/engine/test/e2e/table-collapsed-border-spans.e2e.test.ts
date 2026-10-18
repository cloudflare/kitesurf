// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { decodePng, type DecodedPng } from "./png";
import { setContent } from "./set-content";

const HTML = `<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; background: #fff }
  table { border-collapse: collapse; border: 2px solid #e00;
          table-layout: fixed; width: 200px }
  td { border: 2px solid #e00; height: 40px; padding: 0 }
</style>
<table><tbody>
  <tr><td colspan="2" id="span2"></td></tr>
  <tr><td id="a"></td><td id="b"></td></tr>
  <tr><td rowspan="2" id="tall"></td><td id="b1"></td></tr>
  <tr><td id="b2"></td></tr>
</tbody></table>`;

const isRed = (r: number, g: number, b: number) => r > 150 && g < 80 && b < 80;

const redAt = (png: DecodedPng, x: number, y: number) => {
  const i = (Math.round(y) * png.width + Math.round(x)) * 4;
  return isRed(png.data[i] ?? 0, png.data[i + 1] ?? 0, png.data[i + 2] ?? 0);
};

function redRuns(png: DecodedPng, y: number): number {
  let runs = 0;
  let inRun = false;
  for (let x = 0; x < png.width; x++) {
    const red = redAt(png, x, y);
    if (red && !inRun) runs++;
    inRun = red;
  }
  return runs;
}

test("collapsed borders skip the gridlines a colspan/rowspan cell covers", async ({ page }) => {
  await page.setViewport({ width: 300, height: 300 });
  await setContent(page, HTML, { waitUntil: "domcontentloaded" });

  const box = await page.evaluate(() => {
    const r = (id: string) => {
      const element = document.getElementById(id);
      if (!element) throw new Error(`missing fixture element #${id}`);
      const b = element.getBoundingClientRect();
      return { cx: b.x + b.width / 2, cy: b.y + b.height / 2, top: b.y, left: b.x };
    };
    return { span2: r("span2"), a: r("a"), tall: r("tall"), b1: r("b1"), b2: r("b2") };
  });

  const screenshot = await page.screenshot({ type: "png" });
  if (!(screenshot instanceof Uint8Array)) {
    throw new TypeError("expected page.screenshot() to return PNG bytes");
  }
  const png = await decodePng(screenshot);

  expect(redRuns(png, box.span2.cy)).toBe(2);
  expect(redRuns(png, box.a.cy)).toBe(3);

  const gutterY = box.b2.top - 1;
  expect(redAt(png, box.tall.cx, gutterY)).toBe(false);
  expect(redAt(png, box.b1.cx, gutterY)).toBe(true);
}, 120_000);
