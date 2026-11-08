// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const FIRST = "https://ks.invalid/__fixtures/lifecycle.html";
const NEXT = "https://ks-other.invalid/__fixtures/lifecycle.html";

test("an outgoing document's unload cookies stay on its own host", async ({ page, cdpSession }) => {
  await page.goto(FIRST, { waitUntil: "load", timeout: 15_000 });
  await page.evaluate(() => {
    addEventListener("pagehide", () => {
      document.cookie = "ks_unload=1; Path=/";
    });
  });
  await page.goto(NEXT, { waitUntil: "load", timeout: 15_000 });

  const { cookies } = await cdpSession.send("Network.getAllCookies");
  expect(cookies.filter((c) => c.name === "ks_unload").map((c) => c.domain)).toEqual([
    "ks.invalid",
  ]);
});
