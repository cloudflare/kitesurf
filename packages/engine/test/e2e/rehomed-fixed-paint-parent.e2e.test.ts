// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Keep re-homed fixed paint attached to its flow parent.
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { bbox, decodePng } from "./png";

const isGreen = (r: number, g: number, b: number) => r < 40 && g > 100 && b < 40;
const isRed = (r: number, g: number, b: number) => r > 200 && g < 40 && b < 40;

test("a fixed box inside a scrolled fixed box stays put", async ({ page }) => {
  await page.setViewport({ width: 300, height: 300 });
  await setContent(
    page,
    `<!doctype html>
<div id="outer" style="position: fixed; width: 100px; height: 100px; overflow: auto; background: #e00">
  <div id="inner" style="position: fixed; width: 200px; height: 100px; background: rgb(0, 128, 0)"></div>
  <div style="height: 500px"></div>
</div>
<div style="height: 5000px"></div>
<script>outer.scrollTop = 200;</script>`,
  );
  const png = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));
  expect(bbox(png, 0, 300, isGreen)).toEqual({ x: 8, y: 8, w: 200, h: 100 });
  expect(bbox(png, 0, 300, isRed)).toBeNull();
  // Hit-testing must agree with paint, inside and outside the scroller.
  const hits = await page.evaluate(() => [
    document.elementFromPoint(50, 50)?.id,
    document.elementFromPoint(150, 100)?.id,
  ]);
  expect(hits).toEqual(["inner", "inner"]);
});

test("a fixed box follows the fixed ancestor it is statically placed in", async ({ page }) => {
  await page.setViewport({ width: 300, height: 300 });
  await setContent(
    page,
    `<!doctype html>
<style>
  .ancestor, .child { position: fixed; width: 100px; height: 100px; background: rgb(0, 128, 0) }
  .ancestor { left: 0; top: 0; background: #e00 }
</style>
<div class="ancestor"><div class="child" id="child"></div></div>`,
  );
  await page.evaluate(() => {
    const ancestor = document.querySelector<HTMLElement>(".ancestor")!;
    ancestor.getBoundingClientRect();
    ancestor.style.left = "100px";
  });
  const png = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));
  expect(bbox(png, 0, 300, isGreen)).toEqual({ x: 100, y: 0, w: 100, h: 100 });
  expect(bbox(png, 0, 300, isRed)).toBeNull();
  expect(await page.evaluate(() => document.elementFromPoint(150, 50)?.id)).toBe("child");
});
