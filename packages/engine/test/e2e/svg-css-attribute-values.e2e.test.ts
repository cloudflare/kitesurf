// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { bbox, decodePng } from "./png";

const isRed = (r: number, g: number, b: number) => r > 140 && g < 90 && b < 90;
const isBlack = (r: number, g: number, b: number) => r < 90 && g < 90 && b < 90;

test("CSS values in SVG presentation attributes resolve", async ({ page }) => {
  await page.setViewport({ width: 420, height: 240 });
  await page.goto("https://ks.invalid/__fixtures/svg-css-attrs.html", {
    waitUntil: "domcontentloaded",
  });
  const png = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));

  const varFill = bbox(png, 8, 44, isRed);
  expect(varFill).not.toBeNull();
  expect(varFill!.w).toBeGreaterThan(40);

  const varStroke = bbox(png, 20, 36, (r, g, b) => isRed(r, g, b) && true);
  expect(varStroke).not.toBeNull();
  expect(varStroke!.w).toBeGreaterThan(100);

  const arial = bbox(png, 56, 96, isBlack);
  expect(arial).not.toBeNull();
  expect(arial!.w).toBeGreaterThan(20);

  const rem = bbox(png, 112, 150, isBlack);
  expect(rem).not.toBeNull();
  expect(rem!.h).toBeGreaterThan(6);
  expect(rem!.h).toBeLessThan(18);

  const noneRect = bbox(png, 60, 100, (r, g, b) => isBlack(r, g, b) && true);
  expect(noneRect).not.toBeNull();
  const gradRect = bbox(png, 60, 100, (r, g, b) => b > 140 && r < 90 && g < 90);
  expect(gradRect).not.toBeNull();
  expect(gradRect!.w).toBeGreaterThan(40);
}, 120_000);
