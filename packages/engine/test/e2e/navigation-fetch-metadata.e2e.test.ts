// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A top-level navigation went out with none of the Sec-Fetch-* headers every browser sends, so a
// server's bot and CSRF checks had only the user agent's word that a browser was asking.
import type { CDPSession, Page } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";

const FROM = "https://ks.invalid/__fixtures/lifecycle.html";
const ECHO = "https://ks.invalid/__fixtures/echo-headers.html";
const OTHER_ECHO = "https://ks-other.invalid/__fixtures/echo-headers.html";
const via = (host: string, to: string) =>
  `https://${host}/__fixtures/cors-redirect?to=${encodeURIComponent(to)}`;

const SENT = `(() => {
  const h = globalThis.__ks_doc_headers;
  return [
    h["sec-fetch-dest"] ?? null,
    h["sec-fetch-mode"] ?? null,
    h["sec-fetch-site"] ?? null,
    h["sec-fetch-user"] ?? null,
    h["upgrade-insecure-requests"] ?? null,
  ];
})()`;

async function sent(page: Page, url: string): Promise<Array<string | null>> {
  await expect.poll(() => page.url(), { timeout: 15_000 }).toBe(url);
  await page.waitForFunction("globalThis.__ks_doc_headers !== undefined", { timeout: 15_000 });
  return (await page.evaluate(SENT)) as Array<string | null>;
}

async function clickLink(page: Page, cdp: CDPSession, href: string): Promise<void> {
  await page.evaluate((to: string) => {
    const a = document.createElement("a");
    a.id = "go";
    a.href = to;
    a.textContent = "go";
    a.style.cssText = "display:block;width:120px;height:40px";
    document.body.prepend(a);
  }, href);
  const box = await (await page.$("#go"))?.boundingBox();
  if (!box) throw new Error("#go has no layout box");
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2, button: "left" as const };
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, clickCount: 1 });
}

test("a navigation the client starts is nobody's, and a person's", async ({ page }) => {
  await page.goto(ECHO, { waitUntil: "load" });
  expect(await sent(page, ECHO)).toEqual(["document", "navigate", "none", "?1", "1"]);
}, 60_000);

test("it stays nobody's through a redirect from another site", async ({ page }) => {
  await page.goto(via("evil.invalid", ECHO), { waitUntil: "load" });
  expect(await sent(page, ECHO)).toEqual(["document", "navigate", "none", "?1", "1"]);
}, 60_000);

test("a link to the same origin is same-origin, and a person's", async ({ page, cdpSession }) => {
  await page.goto(FROM, { waitUntil: "load" });
  await clickLink(page, cdpSession, ECHO);
  expect(await sent(page, ECHO)).toEqual(["document", "navigate", "same-origin", "?1", "1"]);
}, 60_000);

test("a link to another site is cross-site", async ({ page, cdpSession }) => {
  await page.goto(FROM, { waitUntil: "load" });
  await clickLink(page, cdpSession, OTHER_ECHO);
  expect(await sent(page, OTHER_ECHO)).toEqual(["document", "navigate", "cross-site", "?1", "1"]);
}, 60_000);

test("a same-origin link that redirects to another site arrives cross-site", async ({
  page,
  cdpSession,
}) => {
  await page.goto(FROM, { waitUntil: "load" });
  await clickLink(page, cdpSession, via("ks.invalid", OTHER_ECHO));
  expect(await sent(page, OTHER_ECHO)).toEqual(["document", "navigate", "cross-site", "?1", "1"]);
}, 60_000);

test("a navigation a script starts carries no Sec-Fetch-User", async ({ page }) => {
  await page.goto(FROM, { waitUntil: "load" });
  await page.evaluate((to: string) => {
    setTimeout(() => {
      location.href = to;
    }, 50);
  }, ECHO);
  expect(await sent(page, ECHO)).toEqual(["document", "navigate", "same-origin", null, "1"]);
}, 60_000);
