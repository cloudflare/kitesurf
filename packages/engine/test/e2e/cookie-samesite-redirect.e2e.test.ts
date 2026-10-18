// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const PAGE = "https://ks.invalid/__fixtures/lifecycle.html";
const SAME_SITE_TARGET = "https://ks.invalid/__fixtures/echo-headers.json";
const CROSS_SITE_TARGET = "https://evil.invalid/__fixtures/echo-headers.json";
const HOP = "https://evil.invalid/__fixtures/cors-redirect";

test("SameSite survives a cross-site redirect back to the page's own site", async ({ page }) => {
  await page.goto(PAGE);

  await page.evaluate(`document.cookie = "lax=1; Path=/"`);

  const viaHop = await page.evaluate(
    `fetch("${HOP}?to=${encodeURIComponent(SAME_SITE_TARGET)}",` +
      ` { credentials: "include" }).then((r) => r.json()).then((h) => h.cookie ?? "")`,
  );
  expect(viaHop).toContain("lax=1");

  const crossSite = await page.evaluate(
    `fetch("${CROSS_SITE_TARGET}", { credentials: "include" })` +
      `.then((r) => r.json()).then((h) => h.cookie ?? "")`,
  );
  expect(crossSite).not.toContain("lax=1");
});
