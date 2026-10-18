// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("cookies-demo", async ({ page }) => {
  const URL1 = process.env.KITESURF_FIXTURE ?? "http://127.0.0.1:8787/__fixtures/cookies.html";
  const URL2 = URL1;

  await page.goto(URL1, { timeout: 15000 });

  const initialDocCookie = await page.evaluate(() => globalThis.__ks_initial_cookie);
  expect(
    initialDocCookie.includes("server_cookie=hello"),
    `page 1 sees server_cookie: expected server_cookie=hello, got ${initialDocCookie}`,
  ).toBeTruthy();
  expect(
    initialDocCookie.includes("session_only=keep"),
    `page 1 sees session_only: expected session_only=keep, got ${initialDocCookie}`,
  ).toBeTruthy();

  const afterSetDocCookie = await page.evaluate(() => globalThis.__ks_after_set_cookie);
  expect(
    afterSetDocCookie.includes("page_set=v1"),
    `page 1 sees page_set after write: expected page_set=v1, got ${afterSetDocCookie}`,
  ).toBeTruthy();

  const queried = await page.cookies(URL1);
  const names = queried.map((c) => c.name).sort();
  for (const want of ["server_cookie", "session_only", "page_set", "another"]) {
    expect(names.includes(want), `getCookies includes ${want}: missing ${want}`).toBeTruthy();
  }

  await page.goto(URL2, { timeout: 15000 });

  const initial2 = await page.evaluate(() => globalThis.__ks_initial_cookie);
  for (const want of ["server_cookie=hello", "session_only=keep", "page_set=v1"]) {
    expect(
      initial2.includes(want),
      `page 2 sees ${want}: expected ${want} in ${initial2}`,
    ).toBeTruthy();
  }

  await page.deleteCookie({ name: "page_set", url: URL1 });
  const afterDelete = await page.cookies(URL1);
  const namesAfter = afterDelete.map((c) => c.name).sort();
  expect(
    !namesAfter.includes("page_set"),
    `deleteCookies removed page_set: page_set still present: ${namesAfter}`,
  ).toBeTruthy();
});
