// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A challenge page stores its token with document.cookie and reloads; the reload went out without
// the token and was challenged again. A handler's cookie never reached the jar at all.
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

test("a cookie a script stores right before it navigates is sent with that navigation", async ({
  page,
}) => {
  await page.goto(FROM, { waitUntil: "load" });
  await page.evaluate((to: string) => {
    setTimeout(() => {
      document.cookie = "ks_token=solved; Path=/";
      location.href = to;
    }, 50);
  }, ECHO);
  expect(await documentCookie(page)).toContain("ks_token=solved");
}, 60_000);

test("a cookie a script stores right before it submits a form is sent with the submission", async ({
  page,
}) => {
  await page.goto(FROM, { waitUntil: "load" });
  await page.evaluate((to: string) => {
    const form = document.createElement("form");
    form.action = to;
    document.body.prepend(form);
    setTimeout(() => {
      document.cookie = "ks_form=sent; Path=/";
      form.submit();
    }, 50);
  }, ECHO);
  expect(await documentCookie(page)).toContain("ks_form=sent");
}, 60_000);

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
