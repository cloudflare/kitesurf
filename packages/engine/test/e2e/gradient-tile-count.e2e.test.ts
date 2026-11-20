// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A small repeating gradient over a large box is thousands of tiles, and
// paint dropped the whole layer past 500 of them, so 8px dot patterns over
// any box taller than ~180px vanished. Only tiles that reach the viewport
// count now.
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { bbox, decodePng } from "./png";

const isBlack = (r: number, g: number, b: number) => r < 60 && g < 60 && b < 60;

const HTML = `<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; background: #fff }
  .dots { height: 3000px; width: 400px;
          background: radial-gradient(#000 2px, transparent 2px) 0 0 / 8px 8px }
</style>
<div class="dots"></div>`;

test("a repeating gradient with thousands of tiles still paints", async ({ page }) => {
  await page.setViewport({ width: 400, height: 200 });
  await setContent(page, HTML, { waitUntil: "domcontentloaded" });

  // 50 x 375 tiles; the viewport shows 50 x 25 of them.
  const top = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));
  const dots = bbox(top, 0, 200, isBlack);
  if (!dots) throw new Error("no dots painted in the first frame");
  expect(dots.w).toBeGreaterThan(390);
  expect(dots.h).toBeGreaterThan(190);

  // Tiles culled at the first frame must come back once scrolled to.
  await page.evaluate(() => window.scrollTo(0, 2000));
  const scrolled = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));
  const later = bbox(scrolled, 0, 200, isBlack);
  if (!later) throw new Error("no dots painted after the scroll");
  expect(later.h).toBeGreaterThan(190);
});

// A dot pattern behind a whole page is ~20k visible tiles at 1440x900, so the tile cap sits above
// that. With a hard stop each tile built its own 4096-entry colour table, and the renderer's wasm
// grew to ~430 MB. Local workerd does not enforce the isolate's 128 MB, so check the wasm size;
// with one shared table it stays near 60 MB.
const RENDERER_WASM_LIMIT = 96 * 1024 * 1024;

test("a dot pattern across the whole viewport paints in bounded memory", async ({
  page,
  cdpSession,
}) => {
  await page.setViewport({ width: 1440, height: 900 });
  await setContent(
    page,
    `<!doctype html><style>
      html, body { margin: 0; height: 100% }
      body { background: #fff radial-gradient(#000 2px, transparent 2px) 0 0 / 8px 8px }
    </style>`,
    { waitUntil: "domcontentloaded" },
  );

  const png = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));
  const dots = bbox(png, 0, 900, isBlack);
  if (!dots) throw new Error("no dots painted across the viewport");
  expect(dots.w).toBeGreaterThan(1430);
  expect(dots.h).toBeGreaterThan(890);

  // Wasm memory never shrinks, so its size is the renderer's peak.
  const info = await cdpSession.send("Kitesurf.getRendererInfo");
  expect(info.framesRendered).toBeGreaterThanOrEqual(1);
  expect(info.rendererWasmBytes).not.toBeNull();
  expect(info.rendererWasmBytes).toBeLessThan(RENDERER_WASM_LIMIT);
});
