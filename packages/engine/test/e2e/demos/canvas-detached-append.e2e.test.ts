// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { waitForTitle } from "../waits";
import { decodePng, sample, near } from "./png";
import { setContent } from "../set-content";
import html from "../html/canvas-detached-append.html?raw";

test("canvas-detached-append", async ({ page }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded", timeout: 30000 });

  const title = await waitForTitle(page, "CANVASDETACHED:", {
    prefix: true,
    timeout: 20000,
  });
  expect(title.startsWith("CANVASDETACHED:"), "fixture never reported").toBeTruthy();

  await new Promise((r) => setTimeout(r, 500));
  const shot = new Uint8Array(await page.screenshot({ type: "png" }));
  const png = decodePng(shot);

  const center = sample(png, 40 + 50, 30 + 50);
  expect(near(center, [255, 0, 0]), `canvas center is red, got ${center.join(",")}`).toBeTruthy();
  const bg = sample(png, 40 + 150, 30 + 50);
  expect(near(bg, [128, 128, 128]), "page background still grey").toBeTruthy();
});
