// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A cookie a click or key handler stored with document.cookie came back on the event's reply and
// was dropped there, so neither the jar nor the navigation the event started ever had it.
import type { CDPSession, Page } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";

const FROM = "https://ks.invalid/__fixtures/lifecycle.html";
const ECHO = "https://ks.invalid/__fixtures/echo-headers.html";

// Polls the URL, not the page: an evaluate's reply would carry the pending writes to the jar.
async function documentCookie(page: Page): Promise<string> {
  await expect.poll(() => page.url(), { timeout: 15_000 }).toBe(ECHO);
  await page.waitForFunction("globalThis.__ks_doc_headers !== undefined", { timeout: 15_000 });
  return (await page.evaluate("globalThis.__ks_doc_headers.cookie ?? ''")) as string;
}

async function click(page: Page, cdp: CDPSession, selector: string): Promise<void> {
  const box = await (await page.$(selector))?.boundingBox();
  if (!box) throw new Error(`${selector} has no layout box`);
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2, button: "left" as const };
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, clickCount: 1 });
}

test("a cookie a click handler stores is sent with the navigation the click starts", async ({
  page,
  cdpSession,
}) => {
  await page.goto(FROM, { waitUntil: "load" });
  await page.evaluate((to: string) => {
    const a = document.createElement("a");
    a.id = "go";
    a.href = to;
    a.textContent = "go";
    a.style.cssText = "display:block;width:120px;height:40px";
    a.addEventListener("click", () => {
      document.cookie = "ks_click=followed; Path=/";
    });
    document.body.prepend(a);
  }, ECHO);
  await click(page, cdpSession, "#go");
  expect(await documentCookie(page)).toContain("ks_click=followed");
}, 60_000);

test("a cookie a click handler stores reaches the jar without a navigation", async ({
  page,
  cdpSession,
}) => {
  await page.goto(FROM, { waitUntil: "load" });
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.id = "accept";
    button.textContent = "accept";
    button.style.cssText = "display:block;width:120px;height:40px";
    button.addEventListener("click", () => {
      document.cookie = "ks_consent=yes; Path=/";
    });
    document.body.prepend(button);
  });
  await click(page, cdpSession, "#accept");
  const { cookies } = await cdpSession.send("Network.getAllCookies");
  expect(cookies.filter((c) => c.name === "ks_consent").map((c) => c.value)).toEqual(["yes"]);
}, 60_000);

test("a cookie a key handler stores reaches the jar", async ({ page, cdpSession }) => {
  await page.goto(FROM, { waitUntil: "load" });
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "field";
    input.addEventListener("keydown", () => {
      document.cookie = "ks_typed=1; Path=/";
    });
    document.body.prepend(input);
    input.focus();
  });
  await cdpSession.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA" });
  await cdpSession.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA" });
  const { cookies } = await cdpSession.send("Network.getAllCookies");
  expect(cookies.filter((c) => c.name === "ks_typed").map((c) => c.value)).toEqual(["1"]);
}, 60_000);
