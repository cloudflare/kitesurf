// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Scripts feature-check the Navigation API with `"navigation" in window`,
// then call navigation.addEventListener. A partial stub passed that check and
// threw (radar.cloudflare.com's Web Analytics beacon), so there is none.
import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("a Navigation API feature check finds no partial stub", async ({ page }) => {
  await setContent(
    page,
    `<script>
      window.__checked = "skipped";
      if ("navigation" in window && window.navigation) {
        window.navigation.addEventListener("navigate", function () {});
        window.__checked = "listened";
      }
    </script>`,
    { waitUntil: "domcontentloaded" },
  );
  const checked = await page.evaluate(() => Reflect.get(globalThis, "__checked"));
  expect(checked).toBe("skipped");
});
