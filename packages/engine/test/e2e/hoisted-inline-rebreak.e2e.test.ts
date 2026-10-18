// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { bbox, decodePng } from "./png";

const isRed = (r: number, g: number, b: number) => r > 150 && g < 100 && b < 100;

const HTML = `<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; background: #fff; font: 20px/1.4 monospace }
  #far { height: 40px; color: #888 }
  #host { position: relative; width: 400px }
  #para { margin: 0; color: #e00 }
  /* Absolute, and #para is not positioned, so it hoists to #host. */
  #para::before { content: '*'; position: absolute; top: 0; left: 0; color: #00e }
</style>
<div id="far">far</div>
<div id="host"><p id="para">red red red red red</p></div>
<script>
  window.repaintFar = function () {
    document.getElementById('far').style.color = '#777';
  };
</script>`;

test("a paragraph that hoists an abspos child keeps its glyphs across a repaint", async ({
  page,
}) => {
  await page.setViewport({ width: 500, height: 200 });
  await setContent(page, HTML, { waitUntil: "domcontentloaded", timeout: 30000 });

  const inkNow = async () => {
    const shot = new Uint8Array(await page.screenshot({ type: "png" }));
    return bbox(await decodePng(shot), 0, 200, isRed);
  };

  const before = await inkNow();
  expect(before, "fixture painted no red text at all").not.toBeNull();

  await page.evaluate(() => (window as typeof window & { repaintFar(): void }).repaintFar());
  const after = await inkNow();

  expect(after, "the paragraph went blank after an unrelated repaint").not.toBeNull();
  expect(after).toEqual(before);
});
