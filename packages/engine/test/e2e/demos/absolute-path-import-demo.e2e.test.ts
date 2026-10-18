// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

declare global {
  interface Window {
    __abspath?: { value: string };
  }
}

test("absolute-path-import-demo", async ({ page }) => {
  const BASE = "http://127.0.0.1:8787";

  const errors = [];
  page.on("pageerror", (e) => errors.push((e.message || "").slice(0, 200)));

  await page.goto(BASE + "/__fixtures/absolute-path-import.html");
  await page
    .waitForFunction(() => window.__abspath?.value === "absolute-path-target loaded", {
      timeout: 15_000,
    })
    .catch(() => {});

  const probe = await page.evaluate(() => window.__abspath);
  expect(
    errors.length === 0,
    "import resolved (no 'No such module' error): pageerrors: " + JSON.stringify(errors),
  ).toBeTruthy();
  expect(
    probe?.value === "absolute-path-target loaded",
    "imported value reached the inline module: got: " + JSON.stringify(probe),
  ).toBeTruthy();
});
