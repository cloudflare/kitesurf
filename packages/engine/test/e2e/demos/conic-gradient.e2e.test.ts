// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { waitForTitle } from "../waits";
import { decodePng, sample } from "./png";
import { setContent } from "../set-content";
import html from "../html/conic-gradient.html?raw";

const FIRST_STOP: [number, number, number] = [188, 193, 205];

function chan(png: ReturnType<typeof decodePng>, x: number, y: number, ch: 0 | 1 | 2) {
  return png.pixels[(y * png.width + x) * 4 + ch];
}

test("conic-gradient-brush-transform", async ({ page }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded", timeout: 30000 });

  await waitForTitle(page, "CONICGRADIENT:ready", { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 300));

  const shot = new Uint8Array(await page.screenshot({ type: "png" }));
  const png = decodePng(shot);

  const topRight = sample(png, 780, 20);
  expect(
    topRight[0] > 240 && topRight[1] > 240 && topRight[2] > 240,
    `top-right samples last-stop white, got rgb(${topRight.join(",")})`,
  ).toBe(true);

  let firstStopMatches = 0;
  let minLum = 255;
  let maxLum = 0;
  const step = 40;
  for (let y = step; y < 600; y += step) {
    for (let x = step; x < 800; x += step) {
      const s = sample(png, x, y);
      const dr = Math.abs(s[0] - FIRST_STOP[0]);
      const dg = Math.abs(s[1] - FIRST_STOP[1]);
      const db = Math.abs(s[2] - FIRST_STOP[2]);
      if (dr <= 5 && dg <= 5 && db <= 5) firstStopMatches += 1;
      const lum = (s[0] + s[1] + s[2]) / 3;
      if (lum < minLum) minLum = lum;
      if (lum > maxLum) maxLum = lum;
    }
  }

  expect(
    firstStopMatches,
    `no interior pixel should match the first stop tightly (bug: entire box collapses to it)`,
  ).toBe(0);

  expect(maxLum - minLum, `sweep produces a luminance spread across the box`).toBeGreaterThan(10);

  const centerBias = chan(png, 400, 300, 0) + chan(png, 400, 300, 1) + chan(png, 400, 300, 2);
  expect(centerBias, `mid-box brighter than 3× first-stop channel avg (~587)`).toBeGreaterThan(
    3 * 210,
  );
});
