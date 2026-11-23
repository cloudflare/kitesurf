// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// sessionStorage belongs to the tab, not the document: the engine keeps the tab's area for each
// origin and every navigation gets a copy (cdp/target.ts sessionStorageForTarget).
import type { Page } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";

const A_ORIGIN = "https://ks.invalid";
const A = `${A_ORIGIN}/__fixtures/lifecycle.html`;
const A2 = `${A_ORIGIN}/__fixtures/big-doc.html?rows=1&seed=1`;
const OTHER = "https://ks-other.invalid/__fixtures/lifecycle.html";

const read = (p: Page) =>
  p.evaluate(() => {
    const out: Record<string, string | null> = {};
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k !== null) out[k] = sessionStorage.getItem(k);
    }
    return out;
  });

test("sessionStorage outlives the tab's navigations, per origin", async ({ page }) => {
  await page.goto(A, { waitUntil: "load" });
  await page.evaluate(() => sessionStorage.setItem("step", "2"));
  await page.goto(A2, { waitUntil: "load" });
  expect(await read(page)).toEqual({ step: "2" });
  await page.goto(OTHER, { waitUntil: "load" });
  expect(await read(page)).toEqual({});
  await page.goto(A, { waitUntil: "load" });
  expect(await read(page)).toEqual({ step: "2" });
  await page.reload({ waitUntil: "load" });
  expect(await read(page)).toEqual({ step: "2" });
}, 120_000);

test("a write just before a page-started navigation reaches the next document", async ({
  page,
}) => {
  await page.goto(A, { waitUntil: "load" });
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    // The navigation can destroy the context before the evaluate replies, which rejects the
    // evaluate though the write and the navigation both happened.
    page
      .evaluate((next) => {
        sessionStorage.setItem("cart", "1");
        location.href = next;
      }, A2)
      .catch(() => {}),
  ]);
  expect(page.url()).toBe(A2);
  expect(await read(page)).toEqual({ cart: "1" });
}, 120_000);

test("each tab has its own sessionStorage, and a new tab starts empty", async ({
  browser,
  page,
}) => {
  const two = await browser.newPage();
  try {
    await page.goto(A, { waitUntil: "load" });
    await two.goto(A, { waitUntil: "load" });
    await page.evaluate(() => sessionStorage.setItem("k", "one"));
    await two.evaluate(() => sessionStorage.setItem("k", "two"));
    await page.reload({ waitUntil: "load" });
    await two.reload({ waitUntil: "load" });
    expect(await read(page)).toEqual({ k: "one" });
    expect(await read(two)).toEqual({ k: "two" });
  } finally {
    await two.close();
  }
  const three = await browser.newPage();
  try {
    await three.goto(A, { waitUntil: "load" });
    expect(await read(three)).toEqual({});
  } finally {
    await three.close();
  }
}, 120_000);

test("a DOMStorage write to sessionStorage reaches the tab's next document", async ({
  page,
  cdpSession,
}) => {
  await page.goto(A, { waitUntil: "load" });
  const storageId = { securityOrigin: A_ORIGIN, isLocalStorage: false } as never;
  await cdpSession.send("DOMStorage.setDOMStorageItem", { storageId, key: "set", value: "1" });
  expect(await read(page)).toEqual({ set: "1" });
  await page.goto(A2, { waitUntil: "load" });
  expect(await read(page)).toEqual({ set: "1" });
}, 120_000);

test("clearing an origin's local storage clears the tab's sessionStorage too", async ({
  page,
  cdpSession,
}) => {
  await page.goto(A, { waitUntil: "load" });
  await page.evaluate(() => sessionStorage.setItem("step", "2"));
  await cdpSession.send("Storage.clearDataForOrigin", {
    origin: A_ORIGIN,
    storageTypes: "local_storage",
  });
  expect(await read(page)).toEqual({});
  await page.goto(A2, { waitUntil: "load" });
  expect(await read(page)).toEqual({});
}, 120_000);
