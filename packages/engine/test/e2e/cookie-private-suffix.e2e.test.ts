// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

test("a tenant of a shared hosting suffix cannot set a cookie for its siblings", async ({
  page,
  cdpSession,
}) => {
  await page.goto("https://a.github.io/__fixtures/lifecycle.html", { waitUntil: "load" });
  await page.evaluate(() => {
    document.cookie = "shared=1; Domain=github.io; Path=/";
    document.cookie = "own=1; Path=/";
  });
  const { cookies } = await cdpSession.send("Network.getAllCookies");
  expect(cookies.map((c) => `${c.name}@${c.domain}`).sort()).toEqual(["own@a.github.io"]);
});
