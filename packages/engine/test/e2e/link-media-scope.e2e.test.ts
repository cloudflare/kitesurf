// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

test("<link media> scopes external stylesheets to the device", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/link-media.html", {
    waitUntil: "domcontentloaded",
  });

  const probe = (await page.evaluate(() => {
    const el = document.getElementById("masthead")!;
    const cs = getComputedStyle(el);
    return { display: cs.display, bg: cs.backgroundColor };
  })) as { display: string; bg: string };

  expect(probe.display).toBe("block");
  expect(probe.bg).toBe("rgb(140, 45, 25)");
}, 120_000);
