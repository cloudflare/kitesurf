// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { waitForTitle } from "../waits";
import { decodePng, sample, near } from "./png";
import { setContent } from "../set-content";
import html from "../html/canvas-aspect-ratio-hack.html?raw";

test("canvas-aspect-ratio-hack", async ({ page }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded", timeout: 30000 });

  const title = await waitForTitle(page, "CANVASASPECT:", {
    prefix: true,
    timeout: 20000,
  });
  expect(title.startsWith("CANVASASPECT:"), "fixture never reported").toBeTruthy();
  const rect = JSON.parse(title.slice("CANVASASPECT:".length));

  expect(rect.w, `canvas laid out at container width, got ${rect.w}`).toBe(200);
  expect(rect.h, `canvas has non-zero height, got ${rect.h}`).toBeGreaterThan(100);

  await new Promise((r) => setTimeout(r, 400));
  const png = decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
  const mid = sample(png, 100, 60);
  expect(near(mid, [255, 0, 0]), `canvas center red, got ${mid.join(",")}`).toBeTruthy();
});
