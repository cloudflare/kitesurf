// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const FIXTURE = "https://ks.invalid/__fixtures/cookies.html";

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
}

test("Storage cookie round-trip: get, set, next-nav visibility, clear", async ({
  page,
  cdpSession: cdp,
}) => {
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  let res = (await cdp.send("Storage.getCookies")) as { cookies: CdpCookie[] };
  const server = res.cookies.find((c) => c.name === "server_cookie");
  expect(server?.value).toBe("hello");

  await cdp.send("Storage.setCookies", {
    cookies: [{ name: "ks_e2e", value: "wave3", domain: "ks.invalid", path: "/" }],
  });
  res = (await cdp.send("Storage.getCookies")) as { cookies: CdpCookie[] };
  expect(res.cookies.some((c) => c.name === "ks_e2e" && c.value === "wave3")).toBe(true);

  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  const docCookie = (await page.evaluate("document.cookie")) as string;
  expect(docCookie).toContain("ks_e2e=wave3");

  await cdp.send("Storage.clearCookies");
  res = (await cdp.send("Storage.getCookies")) as { cookies: CdpCookie[] };
  expect(res.cookies.length).toBe(0);
}, 120_000);
