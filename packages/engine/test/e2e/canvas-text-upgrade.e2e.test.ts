// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { bbox, decodePng } from "./png";
import { waitForTitle } from "./waits";
import html from "./html/canvas-text.html?raw";

test("canvas fillText rasterizes with ink on a paint session", async ({ page }) => {
  await page.setViewport({ width: 600, height: 300 });
  await setContent(page, html, { waitUntil: "domcontentloaded", timeout: 30000 });

  const title = await waitForTitle(page, "DRAWN", { timeout: 20000 });
  expect(title, "fixture never drew").toBe("DRAWN");
  await new Promise((r) => setTimeout(r, 500));

  const shot = new Uint8Array(await page.screenshot({ type: "png" }));
  const png = await decodePng(shot);

  const red = bbox(png, 0, 100, (r, g, b) => r > 150 && g < 100 && b < 100);
  expect(red, "no red canvas-text ink found").not.toBeNull();
  if (!red) throw new Error("unreachable");
  expect(red.w).toBeGreaterThan(60);
  expect(red.w).toBeLessThan(300);
  expect(red.h).toBeGreaterThan(10);
  expect(red.h).toBeLessThan(60);
});
