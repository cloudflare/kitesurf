// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("an asset import's url does not run as module code", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><title>start</title><script type="module">
      import "./style.css?*/document.title=1;/*";
      document.body.dataset.done = "1";
    </script>`,
  );
  await expect.poll(() => page.evaluate(() => document.body.dataset.done)).toBe("1");
  expect(await page.evaluate(() => document.title)).toBe("start");
});
