// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { bbox, decodePng } from "./png";

test("inline SVG fills its box and paints text", async ({ page }) => {
  await page.setViewport({ width: 420, height: 500 });
  await setContent(
    page,
    `<style>body { margin: 0; background: #fff }</style>
     <div style="width:400px"><svg id="css-sized" viewBox="0 0 100 50" style="width:400px"><rect width="100" height="50" fill="#00aa00"/></svg></div>
     <div style="width:400px"><svg id="ratio-only" viewBox="0 0 100 50"><rect width="100" height="50" fill="#0000cc"/></svg></div>
     <div style="width:400px"><svg id="with-text" viewBox="0 0 200 40" style="width:400px"><text x="0" y="30" font-size="30" fill="#cc0000">TEXT</text></svg></div>`,
    { waitUntil: "domcontentloaded" },
  );

  const boxes = await page.evaluate(() =>
    ["css-sized", "ratio-only", "with-text"].map((id) => {
      const r = document.getElementById(id)!.getBoundingClientRect();
      return [id, Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    }),
  );
  expect(boxes).toEqual([
    ["css-sized", 0, 400, 200],
    ["ratio-only", 205, 400, 200],
    ["with-text", 410, 400, 80],
  ]);

  const shot = (await page.screenshot()) as Uint8Array;
  const png = await decodePng(new Uint8Array(shot));

  expect(bbox(png, 0, 200, (r, g, b) => g > 120 && r < 100 && b < 100)).toEqual({
    x: 0,
    y: 0,
    w: 400,
    h: 200,
  });
  expect(bbox(png, 205, 405, (r, g, b) => b > 120 && r < 100 && g < 100)).toEqual({
    x: 0,
    y: 0,
    w: 400,
    h: 200,
  });

  const red = bbox(png, 410, 490, (r, g, b) => r > 120 && g < 100 && b < 100);
  expect(red).not.toBeNull();
  expect(red!.w).toBeGreaterThan(60);
  expect(red!.h).toBeGreaterThan(20);
  expect(red!.h).toBeLessThan(80);
}, 120_000);
