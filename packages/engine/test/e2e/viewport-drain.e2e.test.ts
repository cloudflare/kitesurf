// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { decodePng } from "./png";

const FIXTURE = "https://ks.invalid/__fixtures/viewport-drain.html";

test("a viewport screenshot does not wait for below-fold images", async ({ page }) => {
  await page.setViewport({ width: 200, height: 200 });
  await page.goto(FIXTURE, { waitUntil: "load", timeout: 30000 });

  const shot = new Uint8Array((await page.screenshot()) as Uint8Array);

  const belowAtCapture = (await page.evaluate(
    `document.getElementById("below").complete`,
  )) as boolean;
  expect(belowAtCapture).toBe(false);

  const png = await decodePng(shot);
  const cx = Math.round((60 * png.width) / 200);
  const cy = Math.round((60 * png.height) / 200);
  const i = (cy * png.width + cx) * 4;
  const [r, g, b] = [png.data[i] ?? 0, png.data[i + 1] ?? 0, png.data[i + 2] ?? 0];
  expect(r).toBeGreaterThan(200);
  expect(g).toBeLessThan(80);
  expect(b).toBeLessThan(80);

  await page
    .waitForFunction(`document.getElementById("below").complete === true`, { timeout: 10_000 })
    .catch(() => {});
  const done = (await page.evaluate(
    `document.getElementById("below").complete === true`,
  )) as boolean;
  expect(done).toBe(true);
});

test("printToPDF keeps the document-scoped drain", async ({ page, cdpSession }) => {
  await page.setViewport({ width: 200, height: 200 });
  await page.goto(FIXTURE, { waitUntil: "load", timeout: 30000 });

  const pdf = (await cdpSession.send("Page.printToPDF", {})) as {
    data?: string;
  };
  expect((pdf.data ?? "").length).toBeGreaterThan(0);

  const below = (await page.evaluate(`document.getElementById("below").complete`)) as boolean;
  expect(below).toBe(true);
});
