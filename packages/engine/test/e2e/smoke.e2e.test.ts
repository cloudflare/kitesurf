// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

test("navigate + evaluate (boa eval path in-pool)", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/lifecycle.html", {
    waitUntil: "domcontentloaded",
  });
  const title = await page.evaluate(() => document.title);
  expect(String(title).toLowerCase()).toContain("kitesurf");
}, 120_000);

test("navigate a self-served fixture (outboundService loopback)", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/lifecycle.html", {
    waitUntil: "domcontentloaded",
  });
  const title = await page.title();
  expect(title.toLowerCase()).toContain("kitesurf");
}, 120_000);
