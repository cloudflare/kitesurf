// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

test("a blank page can fetch, and sends Origin: null", async ({ page }) => {
  const body = await page.evaluate(`
    fetch("https://ks.invalid/__fixtures/echo-headers.json").then((r) => r.text())
  `);
  const headers = JSON.parse(String(body)) as Record<string, string>;
  expect(headers["user-agent"]).toBeTruthy();
  expect(headers.origin).toBe("null");
}, 120_000);
