// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A screenshot taken while a reload replaces the document captures a document, as in Chrome. The
// capture awaits a resource drain, and a navigation that retired the isolate during that drain
// failed the render with "no PageScript loaded" (Playwright's "fullPage screenshots during
// navigation").

import { expect, test } from "./harness";

const PAGE = "https://ks.invalid/__fixtures/events.html";

test("fullPage screenshots during reloads succeed", async ({ page }) => {
  await page.setViewport({ width: 500, height: 500 });
  await page.goto(PAGE, { waitUntil: "load" });
  const reloads = async () => {
    for (let i = 0; i < 5; i++) await page.reload();
  };
  const shots = async () => {
    for (let i = 0; i < 5; i++) {
      const png = await page.screenshot({ fullPage: true });
      expect(png.length).toBeGreaterThan(0);
    }
  };
  await Promise.all([reloads(), shots()]);
}, 120_000);
