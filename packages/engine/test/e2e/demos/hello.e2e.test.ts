// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("hello", async ({ page }) => {
  const TARGET = process.env.KITESURF_URL ?? "https://example.com/__fixtures/inline-script.html";

  await page.goto(TARGET, { timeout: 15000 }).catch((e) => {
    console.log("[hello] goto rejected:", e.message);
  });

  const url = page.url();
  expect(
    url.startsWith(TARGET) || url.startsWith(new URL(TARGET).origin),
    `navigation did not update URL: ${url}`,
  ).toBeTruthy();
});
