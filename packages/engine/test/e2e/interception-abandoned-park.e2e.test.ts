// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const FIXTURE = "https://ks.invalid/__fixtures/lifecycle.html";

interface PptrRequest {
  url(): string;
  continue(): Promise<void>;
}

test("pages closed with a paused request keep the session usable", async ({ browser }) => {
  for (let i = 0; i < 3; i++) {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    let abandoned = false;
    page.on("request", (req: PptrRequest) => {
      if (req.url().endsWith("/abandoned.json")) abandoned = true;
      else void req.continue();
    });
    await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
    await page.evaluate(`fetch("/abandoned.json").catch(() => {}); null`);
    await expect.poll(() => abandoned, { timeout: 10_000 }).toBe(true);
    await page.close();
  }

  const page = await browser.newPage();
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  expect(await page.evaluate("1+1")).toBe(2);
}, 120_000);

test("a route handler that never answers continues instead of hanging", async ({ page }) => {
  await page.setRequestInterception(true);
  page.on("request", (_req: PptrRequest) => {});
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded", timeout: 60_000 });
  expect(await page.evaluate("1+1")).toBe(2);
}, 120_000);
