// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

test("an iso-8859-15 stylesheet still applies", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/latin1-sheet.html", {
    waitUntil: "domcontentloaded",
  });

  const bg = (await page.evaluate(
    () => getComputedStyle(document.getElementById("legacy")!).backgroundColor,
  )) as string;
  expect(bg).toBe("rgb(9, 87, 65)");
}, 120_000);
