// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { CDPSession, Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";

const PAGE = "https://ks.invalid/__fixtures/lifecycle.html";
const EVIL_HOST = "https://evil.invalid";

async function viaRedirect(page: Page, cdpSession: CDPSession, cookie: string): Promise<string[]> {
  const target = `${EVIL_HOST}/__fixtures/set-cookie?v=${encodeURIComponent(cookie)}`;
  const status = await page.evaluate(
    `fetch("/__fixtures/loud-redirect?to=${encodeURIComponent(target)}",` +
      ` { credentials: "include" }).then((r) => r.status)`,
  );
  expect(status).toBe(200);
  const all = await cdpSession.send("Network.getAllCookies");
  return all.cookies.map((c) => `${c.name}@${c.domain}`);
}

test("a redirect hop's own cookie is stored under the hop's host", async ({ page, cdpSession }) => {
  await page.goto(PAGE, { waitUntil: "load" });
  const jar = await viaRedirect(page, cdpSession, "own=1; Path=/");
  expect(jar).toContain("own@evil.invalid");
  expect(jar).not.toContain("own@ks.invalid");
});

test("a redirect hop cannot claim the requesting page's domain", async ({ page, cdpSession }) => {
  await page.goto(PAGE, { waitUntil: "load" });
  const jar = await viaRedirect(page, cdpSession, "planted=evil; Domain=ks.invalid; Path=/");
  expect(jar).not.toContain("planted@ks.invalid");
  expect(jar.some((e) => e.startsWith("planted@"))).toBe(false);
});
