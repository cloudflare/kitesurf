// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("clicking an SVG anchor with only xlink:href follows the link", async ({ page }) => {
  await setContent(
    page,
    '<svg xmlns:xlink="http://www.w3.org/1999/xlink" width="300" height="200"><a xlink:href="#target"><rect width="300" height="200" fill="red"></rect></a></svg><p id="target">target</p>',
  );

  await page.mouse.click(100, 100);
  await page.waitForFunction(() => location.hash === "#target", { timeout: 5_000 });

  expect(await page.evaluate(() => location.hash)).toBe("#target");
});
