// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { decodePng } from "./png";
import html from "./html/text-fill-color.html?raw";

const ROW_BAND = {
  plain: [0, 50],
  filled: [50, 100],
  hidden: [100, 150],
  decorated: [150, 200],
  gradient: [200, 250],
  multilayer: [250, 300],
} as const;

function b64Bytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

test("-webkit-text-fill-color paints the glyph fill", async ({ page, cdpSession }) => {
  await page.setViewport({ width: 300, height: 320 });
  await setContent(page, html, { waitUntil: "load", timeout: 30000 });

  const shot = (await cdpSession.send("Page.captureScreenshot", {
    format: "png",
  })) as { data: string };
  const png = await decodePng(b64Bytes(shot.data));

  const scanBand = ([y0, y1]: readonly [number, number]) => {
    let best: [number, number, number] = [255, 255, 255];
    let bestScore = -1;
    for (let y = y0; y < Math.min(y1, png.height); y++) {
      for (let x = 2; x < Math.min(png.width - 2, 220); x++) {
        const i = (y * png.width + x) * 4;
        const px: [number, number, number] = [
          png.data[i] ?? 0,
          png.data[i + 1] ?? 0,
          png.data[i + 2] ?? 0,
        ];
        const score = 765 - (px[0] + px[1] + px[2]);
        if (score > bestScore) {
          bestScore = score;
          best = px;
        }
      }
    }
    return { px: best, ink: bestScore };
  };

  const plain = scanBand(ROW_BAND.plain);
  const filled = scanBand(ROW_BAND.filled);
  const hidden = scanBand(ROW_BAND.hidden);
  const decorated = scanBand(ROW_BAND.decorated);
  const gradient = scanBand(ROW_BAND.gradient);

  const countRed = ([y0, y1]: readonly [number, number]) => {
    let reddish = 0;
    for (let y = y0; y < Math.min(y1, png.height); y++) {
      for (let x = 2; x < Math.min(png.width - 2, 220); x++) {
        const i = (y * png.width + x) * 4;
        if ((png.data[i] ?? 0) > 150 && (png.data[i + 2] ?? 0) < 110) reddish++;
      }
    }
    return reddish;
  };

  expect(plain.px[0], `plain row red (got ${plain.px})`).toBeGreaterThan(150);
  expect(plain.px[1], `plain row green (got ${plain.px})`).toBeLessThan(110);

  expect(filled.px[1], `filled row green (got ${filled.px})`).toBeGreaterThan(150);
  expect(filled.px[0], `filled row red (got ${filled.px})`).toBeLessThan(110);

  expect(hidden.ink, `hidden row should have no ink (got ${hidden.px})`).toBeLessThan(60);

  expect(
    decorated.ink,
    `decorated row should still paint its underline (got ${decorated.px})`,
  ).toBeGreaterThan(60);
  expect(decorated.px[2], `decorated underline blue (got ${decorated.px})`).toBeGreaterThan(120);

  expect(gradient.ink, `gradient text should paint (got ${gradient.px})`).toBeGreaterThan(60);

  const multilayer = scanBand(ROW_BAND.multilayer);
  expect(multilayer.px[2], `multilayer row blue (got ${multilayer.px})`).toBeGreaterThan(150);
  expect(countRed(ROW_BAND.multilayer), "multilayer row must not reveal red glyphs").toBe(0);
  expect(countRed(ROW_BAND.plain), "plain row should be red").toBeGreaterThan(0);
});
