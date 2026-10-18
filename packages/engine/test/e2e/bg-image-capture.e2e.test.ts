// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { decodePng } from "./png";

const FIXTURE = "https://ks.invalid/__fixtures/bg-image-capture.html";

test("a screenshot from DCL waits for a style-driven background image", async ({ page }) => {
  await page.setViewport({ width: 200, height: 200 });
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded", timeout: 30000 });

  const png = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));
  const cx = Math.round((60 * png.width) / 200);
  const cy = Math.round((60 * png.height) / 200);
  const i = (cy * png.width + cx) * 4;
  const [r, g, b] = [png.data[i] ?? 0, png.data[i + 1] ?? 0, png.data[i + 2] ?? 0];
  expect(r).toBeGreaterThan(200);
  expect(g).toBeLessThan(80);
  expect(b).toBeLessThan(80);
});
