// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("anchor and area protocol return ':' when href is invalid", async ({ page }) => {
  await setContent(page, "<p>Invalid URL components</p>");

  const protocols = await page.evaluate(() => {
    const href = "http://example.com:80:";
    const anchor = document.createElement("a");
    const area = document.createElement("area");
    anchor.setAttribute("href", href);
    area.setAttribute("href", href);
    return [anchor.protocol, area.protocol];
  });

  expect(protocols).toEqual([":", ":"]);
});
