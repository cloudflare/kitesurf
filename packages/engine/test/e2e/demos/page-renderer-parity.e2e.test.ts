// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { decodePng, encodePng, near, sample } from "./png";

function countHeadingInk(png: ReturnType<typeof decodePng>): number {
  let ink = 0;
  for (let y = 25; y < 50; y++) {
    for (let x = 20; x < 400; x++) {
      if (!near(sample(png, x, y), [246, 247, 248], 24)) ink++;
    }
  }
  return ink;
}

function countPatternedPixels(png: ReturnType<typeof decodePng>): number {
  let patterned = 0;
  for (let y = 170; y < 340; y++) {
    for (let x = 15; x < 80; x++) {
      const px = sample(png, x, y);
      const spread = Math.max(px[0], px[1], px[2]) - Math.min(px[0], px[1], px[2]);
      if (spread > 40) patterned++;
    }
  }
  return patterned;
}

test("page-renderer-parity", async ({ page, cdpSession }) => {
  const SIDE = 48;
  const rgba = new Uint8Array(SIDE * SIDE * 4);
  for (let y = 0; y < SIDE; y++) {
    for (let x = 0; x < SIDE; x++) {
      const i = (y * SIDE + x) * 4;
      rgba[i] = (x * 7) % 256;
      rgba[i + 1] = (y * 11) % 256;
      rgba[i + 2] = ((x + y) * 5) % 256;
      rgba[i + 3] = 255;
    }
  }
  const imgB64 = Buffer.from(encodePng(SIDE, SIDE, rgba)).toString("base64");

  const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>parity</title>
<style>
  body { margin: 0; padding: 20px; font-family: sans-serif; background: #f6f7f8; color: #1c2733; }
  h1 { color: #b03030; font-size: 26px; margin: 0 0 10px 0; }
  .grad { width: 240px; height: 60px; background: linear-gradient(90deg, #2244cc, #22cc66); border-radius: 8px; }
  .boxes { display: flex; gap: 10px; margin-top: 14px; }
  .box { width: 90px; height: 56px; background: #e8b23a; border: 3px solid #444; box-shadow: 4px 4px 6px rgba(0,0,0,0.35); }
  .box.b { background: #3a8fe8; border-radius: 12px; }
  img { display: block; margin-top: 14px; image-rendering: auto; }
</style></head>
<body>
  <h1>pageRenderer parity fixture</h1>
  <p>Glyph runs, gradients, borders, shadows, and an out-of-band image.</p>
  <div class="grad"></div>
  <div class="boxes"><div class="box"></div><div class="box b"></div></div>
  <img id="pat" width="${SIDE}" height="${SIDE}" src="data:image/png;base64,${imgB64}">
</body></html>`;

  await page.goto(`data:text/html,${encodeURIComponent(HTML)}`, {
    timeout: 20_000,
  });
  await new Promise((r) => setTimeout(r, 500));

  const viaRenderer = new Uint8Array(await page.screenshot({ type: "png" }));

  const info = await cdpSession.send("Kitesurf.getRendererInfo");
  console.log("[parity] renderer info:", JSON.stringify(info));
  expect(info.enabled, "renderer path enabled").toBe(true);
  expect(info.framesRendered, "scene path produced the frame").toBeGreaterThanOrEqual(1);

  const clipShot = decodePng(
    new Uint8Array(
      await page.screenshot({
        type: "png",
        clip: { x: 10, y: 10, width: 200, height: 120 },
      }),
    ),
  );
  expect({ w: clipShot.width, h: clipShot.height }).toStrictEqual({
    w: 200,
    h: 120,
  });

  const a = decodePng(viaRenderer);
  expect({ w: a.width, h: a.height }).toStrictEqual({ w: 800, h: 600 });

  expect(countHeadingInk(a), "heading glyphs painted").toBeGreaterThan(200);
  const bg = sample(a, 780, 580);
  expect(near(bg, [246, 247, 248]), "background color").toBe(true);
  const gradLeft = sample(a, 30, 145);
  expect(gradLeft[2] > 120 && gradLeft[2] > gradLeft[1], "gradient left is blue-ish").toBe(true);

  expect(countPatternedPixels(a), "out-of-band image pattern painted").toBeGreaterThan(300);
});
