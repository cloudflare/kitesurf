// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("literal dynamic imports load their chunk", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/dynimport.html", {
    waitUntil: "load",
    timeout: 15_000,
  });

  await page
    .waitForFunction(() => document.getElementById("out")?.hasAttribute("data-compute") === true, {
      timeout: 15_000,
    })
    .catch(() => {});

  const output = await page.evaluate(() => {
    const element = document.getElementById("out");
    return {
      compute: element?.getAttribute("data-compute") ?? null,
      value: element?.textContent ?? null,
    };
  });

  expect(output.compute, "function export from dyn-imported chunk (compute)").toBe("42");
  expect(output.value, "value export from dyn-imported chunk").toBe("val=42");
});
