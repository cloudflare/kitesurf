// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("waitForSelector resolves for existing and later elements", async ({ page }) => {
  await setContent(page, "<p id=early>early</p>");

  const early = await page.waitForSelector("#early", { timeout: 5000 });
  expect(early).not.toBeNull();

  const late = page.waitForSelector("#late", { timeout: 5000 });
  await page.evaluate(() => {
    const element = document.createElement("p");
    element.id = "late";
    element.textContent = "late";
    document.body.appendChild(element);
  });
  const lateHandle = await late;
  expect(lateHandle).not.toBeNull();
});
