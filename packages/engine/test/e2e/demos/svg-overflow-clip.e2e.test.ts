// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { decodePng, sample, near } from "./png";

test("svg-overflow-clip", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/svg-overflow-clip.html", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await new Promise((r) => setTimeout(r, 600));
  const png = decodePng(new Uint8Array(await page.screenshot({ type: "png" })));

  const red: [number, number, number] = [255, 0, 0];
  const blue: [number, number, number] = [0, 0, 255];
  const white: [number, number, number] = [255, 255, 255];

  expect(near(sample(png, 120, 120), red), "img content inside the box").toBe(true);
  expect(near(sample(png, 150, 120), white), "img bled right").toBe(true);
  expect(near(sample(png, 120, 150), white), "img bled below").toBe(true);

  expect(near(sample(png, 420, 120), blue), "inline svg inside").toBe(true);
  expect(near(sample(png, 500, 120), blue), "author overflow:visible clipped").toBe(true);
});
