// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Every navigation told the server it came from the target's own origin: a first visit claimed a
// referrer it never had, and a link from another site hid the one it did have.
import type { CDPSession, Page } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";

const FROM = "https://ks.invalid/__fixtures/lifecycle.html";
const ECHO = "https://ks.invalid/__fixtures/echo-headers.html";
const OTHER_ECHO = "https://ks-other.invalid/__fixtures/echo-headers.html";
const SILENT = "https://ks.invalid/__fixtures/iframe-referrer-host.html?policy=no-referrer";

interface Landed {
  header: string | null;
  referrer: string;
}

async function landed(page: Page, url: string): Promise<Landed> {
  await expect.poll(() => page.url(), { timeout: 15_000 }).toBe(url);
  await page.waitForFunction("globalThis.__ks_doc_headers !== undefined", { timeout: 15_000 });
  return (await page.evaluate(
    "({ header: globalThis.__ks_doc_headers.referer ?? null, referrer: document.referrer })",
  )) as Landed;
}

async function clickLink(
  page: Page,
  cdp: CDPSession,
  href: string,
  attributes: Record<string, string> = {},
): Promise<void> {
  await page.evaluate(
    (to: string, extra: Record<string, string>) => {
      const a = document.createElement("a");
      a.id = "go";
      a.href = to;
      a.textContent = "go";
      a.style.cssText = "display:block;width:120px;height:40px";
      for (const [name, value] of Object.entries(extra)) a.setAttribute(name, value);
      document.body.prepend(a);
    },
    href,
    attributes,
  );
  const box = await (await page.$("#go"))?.boundingBox();
  if (!box) throw new Error("#go has no layout box");
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2, button: "left" as const };
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, clickCount: 1 });
}

test("a navigation the client starts names no referrer", async ({ page }) => {
  await page.goto(ECHO, { waitUntil: "load" });
  expect(await landed(page, ECHO)).toEqual({ header: null, referrer: "" });
}, 60_000);

test("a link to the same origin names the page it was on", async ({ page, cdpSession }) => {
  await page.goto(FROM, { waitUntil: "load" });
  await clickLink(page, cdpSession, ECHO);
  expect(await landed(page, ECHO)).toEqual({ header: FROM, referrer: FROM });
}, 60_000);

test("a link to another origin names only the origin it left", async ({ page, cdpSession }) => {
  await page.goto(FROM, { waitUntil: "load" });
  await clickLink(page, cdpSession, OTHER_ECHO);
  expect(await landed(page, OTHER_ECHO)).toEqual({
    header: "https://ks.invalid/",
    referrer: "https://ks.invalid/",
  });
}, 60_000);

test("a rel=noreferrer link names nobody", async ({ page, cdpSession }) => {
  await page.goto(FROM, { waitUntil: "load" });
  await clickLink(page, cdpSession, ECHO, { rel: "noopener noreferrer" });
  expect(await landed(page, ECHO)).toEqual({ header: null, referrer: "" });
}, 60_000);

test("a link's referrerpolicy overrides its page's", async ({ page, cdpSession }) => {
  await page.goto(FROM, { waitUntil: "load" });
  await clickLink(page, cdpSession, ECHO, { referrerpolicy: "origin" });
  expect(await landed(page, ECHO)).toEqual({
    header: "https://ks.invalid/",
    referrer: "https://ks.invalid/",
  });
}, 60_000);

test("a navigation a script starts names the script's page", async ({ page }) => {
  await page.goto(FROM, { waitUntil: "load" });
  await page.evaluate((to: string) => {
    setTimeout(() => {
      location.href = to;
    }, 50);
  }, ECHO);
  expect(await landed(page, ECHO)).toEqual({ header: FROM, referrer: FROM });
}, 60_000);

test("a page whose policy is no-referrer is not named", async ({ page }) => {
  await page.goto(SILENT, { waitUntil: "load" });
  await page.evaluate((to: string) => {
    setTimeout(() => {
      location.href = to;
    }, 50);
  }, ECHO);
  expect(await landed(page, ECHO)).toEqual({ header: null, referrer: "" });
}, 60_000);

test("a reload the client asks for repeats the referrer the page was loaded with", async ({
  page,
}) => {
  const referer = "https://www.example.com/";
  await page.goto(ECHO, { referer, waitUntil: "load" });
  expect(await landed(page, ECHO)).toEqual({ header: referer, referrer: referer });
  await page.reload({ waitUntil: "load" });
  expect(await landed(page, ECHO)).toEqual({ header: referer, referrer: referer });
}, 60_000);
