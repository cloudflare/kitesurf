// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

test("an external classic script's dynamic import seeds the module walk", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/classic-seed.html", {
    waitUntil: "load",
    timeout: 30000,
  });
  await page
    .waitForFunction(() => document.getElementById("out")?.getAttribute("data-done") === "1", {
      timeout: 20_000,
    })
    .catch(() => {});
  const done = await page
    .evaluate(() => document.getElementById("out")?.getAttribute("data-done") ?? "0")
    .catch(() => "0");
  expect(done, "the classic bootstrap ran and its import settled").toBe("1");
  const label = await page.evaluate(() => document.getElementById("out")?.textContent ?? "");
  expect(label).toBe("chunk+dep");
});
