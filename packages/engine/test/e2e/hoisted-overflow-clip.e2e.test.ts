// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A z-indexed box paints with its stacking context, but the overflow clips
// between the two still apply to it. Paint skipped them, so a collapsed
// `overflow: hidden` panel leaked its z-indexed descendants. Values match
// Chrome.
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { bbox, decodePng } from "./png";

const isRed = (r: number, g: number, b: number) => r > 150 && g < 80 && b < 80;
const isBlue = (r: number, g: number, b: number) => r < 80 && g < 80 && b > 150;
const isGreen = (r: number, g: number, b: number) => r < 80 && g > 100 && b < 80;

const HTML = `<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; background: #fff }
  .z { position: absolute; z-index: 1 }
  .band { height: 120px; position: relative }
</style>
<div class="band">
  <div style="position: absolute; left: 20px; top: 20px; width: 60px; height: 60px; overflow: hidden">
    <div style="position: relative">
      <div class="z" style="left: 20px; top: 20px; width: 100px; height: 100px; background: #e00"></div>
    </div>
  </div>
</div>
<div class="band">
  <div id="scroller" style="position: absolute; left: 20px; top: 0; width: 120px; height: 80px; overflow: auto">
    <div style="height: 300px; position: relative">
      <div class="z" style="left: 10px; top: 50px; width: 50px; height: 200px; background: #00e"></div>
    </div>
  </div>
</div>
<div class="band">
  <div style="width: 20px; height: 20px; overflow: hidden">
    <div class="z" style="left: 40px; top: 0; width: 40px; height: 40px; background: #080"></div>
  </div>
</div>
<div style="height: 0; overflow: hidden">
  <div style="position: relative">
    <div class="z" style="left: 0; top: 0; width: 300px; height: 300px; background: #e00"></div>
  </div>
</div>
<script>document.getElementById("scroller").scrollTop = 40</script>`;

test("overflow clips between a stacking context and a hoisted box still clip it", async ({
  page,
}) => {
  await page.setViewport({ width: 400, height: 480 });
  await setContent(page, HTML, { waitUntil: "load" });
  const png = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));

  // Clipped to the overflow: hidden box at 20,20 60x60.
  expect(bbox(png, 0, 120, isRed)).toEqual({ x: 40, y: 40, w: 40, h: 40 });
  // Clipped to the scroller's padding box, scrolled 40px: 10..80 inside it.
  expect(bbox(png, 120, 240, isBlue)).toEqual({ x: 30, y: 10, w: 50, h: 70 });
  // Control: its containing block (the positioned band) sits outside the
  // clipping box, so that clip does not apply.
  expect(bbox(png, 240, 360, isGreen)).toEqual({ x: 40, y: 0, w: 40, h: 40 });
  // A zero-height overflow: hidden box (a collapsed disclosure panel)
  // hides it entirely; the only red left is the first band's.
  expect(bbox(png, 120, 480, isRed)).toBeNull();
});
