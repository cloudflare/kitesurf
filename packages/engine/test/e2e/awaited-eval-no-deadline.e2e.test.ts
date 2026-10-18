// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

test.concurrent("an awaited promise past the old 10s cap settles normally", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/events.html", {
    waitUntil: "domcontentloaded",
  });

  const started = Date.now();
  const value = await page.evaluate(
    () => new Promise((resolve) => setTimeout(() => resolve("late"), 11_000)),
  );
  expect(value).toBe("late");
  expect(Date.now() - started).toBeGreaterThan(10_500);
}, 120_000);

test.concurrent("a wait past the old cap fails with the client's own timeout", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/events.html", {
    waitUntil: "domcontentloaded",
  });

  const started = Date.now();
  const err = await page
    .waitForFunction(() => false, { timeout: 11_000 })
    .then(
      () => null,
      (e: Error) => e,
    );
  expect(err?.name).toBe("TimeoutError");
  expect(err?.message).toMatch(/11000ms exceeded/);
  expect(Date.now() - started).toBeGreaterThan(10_500);
}, 120_000);
