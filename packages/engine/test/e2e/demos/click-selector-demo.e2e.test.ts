// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("click-selector-demo", async ({ page }) => {
  const FIXTURE_URL =
    process.env.KITESURF_FIXTURE ?? "http://127.0.0.1:8787/__fixtures/events.html";

  await page.goto(FIXTURE_URL, { timeout: 15000 });

  const handle = await page.$("#btn");
  expect(handle, "page.$ returned null").toBeTruthy();
  await handle.click();

  const log = await page.evaluate(() => globalThis.__ks_path ?? []);
  expect(Array.isArray(log) && log.length > 0, "no events captured").toBeTruthy();
  expect(log.includes("btn:target"), "btn:target listener didn't fire").toBeTruthy();
  expect(
    log.some((s) => s.startsWith("target=btn")),
    "e.target wasn't the #btn element",
  ).toBeTruthy();
});
