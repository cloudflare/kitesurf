// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import countersHtml from "./html/counters.html?raw";
import countersRefHtml from "./html/counters-ref.html?raw";

test("counters, list numbering and attr() render like literal values", async ({ page }) => {
  await page.setViewport({ width: 600, height: 400 });

  await setContent(page, countersHtml, { waitUntil: "domcontentloaded" });
  const testShot = (await page.screenshot({ encoding: "base64" })) as string;

  await setContent(page, countersRefHtml, { waitUntil: "domcontentloaded" });
  const refShot = (await page.screenshot({ encoding: "base64" })) as string;

  expect(testShot).toBe(refShot);

  expect(testShot.length).toBeGreaterThan(2_000);
}, 120_000);
