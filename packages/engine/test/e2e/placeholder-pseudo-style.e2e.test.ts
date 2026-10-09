// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A text control paints its placeholder in the `::placeholder` colour:
// Chromium's UA #757575 unless an author rule overrides it. Paint used to
// draw it italic at 40% of the input's own colour. Expected colours match
// Chrome.
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { bbox, decodePng } from "./png";

const HTML = `<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; background: #fff }
  input { display: block; margin: 0 0 20px; width: 300px; height: 40px; border: 0; padding: 0;
          font: 24px sans-serif; color: rgb(0, 0, 200); background: #fff }
  .author { --ph: rgb(220, 0, 0) }
  .author::placeholder { color: var(--ph) }
  .webkit::-webkit-input-placeholder { color: rgb(0, 150, 0) }
</style>
<input placeholder="WWWWWW">
<input class="author" placeholder="WWWWWW">
<input value="WWWWWW">
<input class="webkit" placeholder="WWWWWW">`;

// Glyph edges are antialiased, but the cores of 24px glyphs hit the colour.
const near = (target: [number, number, number]) => (r: number, g: number, b: number) =>
  Math.abs(r - target[0]) < 12 && Math.abs(g - target[1]) < 12 && Math.abs(b - target[2]) < 12;

test("placeholder text paints in its ::placeholder colour", async ({ page }) => {
  await page.setViewport({ width: 400, height: 240 });
  await setContent(page, HTML, { waitUntil: "domcontentloaded" });
  const png = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));

  // UA default, not the input's blue at reduced alpha.
  expect(bbox(png, 0, 40, near([117, 117, 117]))).not.toBeNull();
  expect(bbox(png, 0, 40, near([0, 0, 200]))).toBeNull();
  // An author ::placeholder rule, resolving a custom property set on the input.
  expect(bbox(png, 60, 100, near([220, 0, 0]))).not.toBeNull();
  // Control: a real value keeps the input's own colour.
  expect(bbox(png, 120, 160, near([0, 0, 200]))).not.toBeNull();
  // Chromium still matches the WebKit spelling, and todomvc-era sheets
  // use nothing else.
  expect(bbox(png, 180, 220, near([0, 150, 0]))).not.toBeNull();
});
