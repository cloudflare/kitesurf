// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

test("a loading=lazy image does not delay the load event", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/lazy-load-event.html", {
    waitUntil: "load",
    timeout: 30000,
  });

  const atLoad = (await page.evaluate(`
    ({
      lazy: document.getElementById("lazy").complete,
      eager: document.getElementById("eager").complete,
    })
  `)) as { lazy: boolean; eager: boolean };
  expect(atLoad.eager).toBe(true);
  expect(atLoad.lazy).toBe(false);

  await page
    .waitForFunction(`document.getElementById("lazy").complete === true`, { timeout: 10_000 })
    .catch(() => {});
  const lazyDone = (await page.evaluate(
    `document.getElementById("lazy").complete === true`,
  )) as boolean;
  expect(lazyDone).toBe(true);
});

test("the same tarpit WITHOUT loading=lazy still delays load", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/eager-slow-load.html", {
    waitUntil: "load",
    timeout: 30000,
  });
  const complete = (await page.evaluate(`document.getElementById("slow").complete`)) as boolean;
  expect(complete).toBe(true);
});
