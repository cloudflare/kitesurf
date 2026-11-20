// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// DOMStorage over the engine's localStorage areas (cdp/dom-storage.ts). Unlike Chrome,
// localStorage of an origin without an open page works too.
import type { CDPSession, Page } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";

const A_ORIGIN = "https://ks.invalid";
const A = `${A_ORIGIN}/__fixtures/lifecycle.html`;
const OTHER_ORIGIN = "https://ks-other.invalid";
const OTHER = `${OTHER_ORIGIN}/__fixtures/lifecycle.html`;

const local = (origin: string) => ({ securityOrigin: origin, isLocalStorage: true });
const session = (origin: string) => ({ securityOrigin: origin, isLocalStorage: false });

const items = async (cdp: CDPSession, storageId: object) =>
  (await cdp.send("DOMStorage.getDOMStorageItems", { storageId: storageId as never })).entries;

const recordStorageEvents = (page: Page) =>
  page.evaluate(() => {
    const events: unknown[] = [];
    Reflect.set(window, "__events", events);
    addEventListener("storage", (e) => {
      events.push([e.key, e.oldValue, e.newValue, e.storageArea === localStorage]);
    });
  });

const storageEvents = (page: Page) =>
  page.evaluate(() => JSON.stringify(Reflect.get(window, "__events") ?? []));

test("getDOMStorageItems reads a write the page just made", async ({ page, cdpSession }) => {
  await page.goto(A, { waitUntil: "load" });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("k", "v");
    localStorage.setItem("n", "1");
  });
  expect(await items(cdpSession, local(A_ORIGIN))).toEqual([
    ["k", "v"],
    ["n", "1"],
  ]);
  // A storage key names the same area.
  const byKey = { storageKey: `${A_ORIGIN}/`, isLocalStorage: true };
  expect(await items(cdpSession, byKey)).toEqual([
    ["k", "v"],
    ["n", "1"],
  ]);
}, 60_000);

test("set, remove and clear reach the open page and fire storage events", async ({
  page,
  cdpSession,
}) => {
  await page.goto(A, { waitUntil: "load" });
  await recordStorageEvents(page);
  const storageId = local(A_ORIGIN) as never;
  await cdpSession.send("DOMStorage.setDOMStorageItem", { storageId, key: "k", value: "1" });
  expect(await page.evaluate(() => localStorage.getItem("k"))).toBe("1");
  await cdpSession.send("DOMStorage.setDOMStorageItem", { storageId, key: "k", value: "2" });
  await cdpSession.send("DOMStorage.removeDOMStorageItem", { storageId, key: "k" });
  expect(await page.evaluate(() => localStorage.getItem("k"))).toBe(null);
  await cdpSession.send("DOMStorage.setDOMStorageItem", { storageId, key: "j", value: "3" });
  await cdpSession.send("DOMStorage.clear", { storageId });
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await expect
    .poll(() => storageEvents(page))
    .toBe(
      JSON.stringify([
        ["k", null, "1", true],
        ["k", "1", "2", true],
        ["k", "2", null, true],
        ["j", null, "3", true],
        [null, null, null, true],
      ]),
    );
}, 60_000);

test("localStorage of an origin with no open page can be read and written", async ({
  page,
  cdpSession,
}) => {
  await page.goto(A, { waitUntil: "load" });
  const storageId = local(OTHER_ORIGIN) as never;
  await cdpSession.send("DOMStorage.setDOMStorageItem", { storageId, key: "k", value: "far" });
  expect(await items(cdpSession, local(OTHER_ORIGIN))).toEqual([["k", "far"]]);
  expect(await page.evaluate(() => localStorage.getItem("k"))).toBe(null);
  await page.goto(OTHER, { waitUntil: "load" });
  expect(await page.evaluate(() => localStorage.getItem("k"))).toBe("far");
}, 60_000);

test("DOMStorage events report another page's changes", async ({ browser, page, cdpSession }) => {
  await page.goto(A, { waitUntil: "load" });
  const events: Array<[string, unknown]> = [];
  for (const name of [
    "domStorageItemAdded",
    "domStorageItemUpdated",
    "domStorageItemRemoved",
    "domStorageItemsCleared",
  ] as const) {
    cdpSession.on(`DOMStorage.${name}`, (params) => events.push([name, params]));
  }
  await cdpSession.send("DOMStorage.enable");
  const two = await browser.newPage();
  try {
    await two.goto(A, { waitUntil: "load" });
    await two.evaluate(() => {
      localStorage.setItem("k", "1");
      localStorage.setItem("k", "2");
      localStorage.removeItem("k");
      localStorage.setItem("j", "3");
    });
    // A clear drops the earlier ops of its batch (page-script web-storage.ts), so it gets its own.
    await two.evaluate(() => localStorage.clear());
    const storageId = {
      securityOrigin: A_ORIGIN,
      storageKey: `${A_ORIGIN}/`,
      isLocalStorage: true,
    };
    await expect.poll(() => events.length).toBe(5);
    expect(events).toEqual([
      ["domStorageItemAdded", { storageId, key: "k", newValue: "1" }],
      ["domStorageItemUpdated", { storageId, key: "k", oldValue: "1", newValue: "2" }],
      ["domStorageItemRemoved", { storageId, key: "k" }],
      ["domStorageItemAdded", { storageId, key: "j", newValue: "3" }],
      ["domStorageItemsCleared", { storageId }],
    ]);
    await cdpSession.send("DOMStorage.disable");
    await two.evaluate(() => localStorage.setItem("after", "disable"));
    await expect.poll(() => items(cdpSession, local(A_ORIGIN))).toEqual([["after", "disable"]]);
    expect(events).toHaveLength(5);
  } finally {
    await two.close();
  }
}, 60_000);

test("sessionStorage is reachable for the page's own origin only", async ({ page, cdpSession }) => {
  await page.goto(A, { waitUntil: "load" });
  await page.evaluate(() => sessionStorage.setItem("tab", "1"));
  expect(await items(cdpSession, session(A_ORIGIN))).toEqual([["tab", "1"]]);
  const storageId = session(A_ORIGIN) as never;
  await cdpSession.send("DOMStorage.setDOMStorageItem", { storageId, key: "set", value: "2" });
  expect(await page.evaluate(() => sessionStorage.getItem("set"))).toBe("2");
  // localStorage is a separate area.
  expect(await items(cdpSession, local(A_ORIGIN))).not.toContainEqual(["set", "2"]);
  await expect(items(cdpSession, session(OTHER_ORIGIN))).rejects.toThrow(
    "Frame not found for the given storage id",
  );
}, 60_000);

test("a bad StorageId is an error", async ({ page, cdpSession }) => {
  await page.goto(A, { waitUntil: "load" });
  await expect(items(cdpSession, { isLocalStorage: true })).rejects.toThrow(
    "Invalid storageId format",
  );
  await expect(items(cdpSession, { securityOrigin: A_ORIGIN })).rejects.toThrow(
    "Invalid storageId format",
  );
  await expect(items(cdpSession, local("data:text/html,x"))).rejects.toThrow(
    "Frame not found for the given storage id",
  );
  const partitioned = { storageKey: `${A_ORIGIN}/^0${OTHER_ORIGIN}`, isLocalStorage: true };
  await expect(items(cdpSession, partitioned)).rejects.toThrow("Partitioned storage keys");
}, 60_000);

test("each browser context's DOMStorage acts on its own localStorage", async ({
  browser,
  page,
}) => {
  const context = await browser.createBrowserContext();
  try {
    const other = await context.newPage();
    await page.goto(A, { waitUntil: "load" });
    await other.goto(A, { waitUntil: "load" });
    const cdp = await other.createCDPSession();
    const storageId = local(A_ORIGIN) as never;
    await cdp.send("DOMStorage.setDOMStorageItem", { storageId, key: "k", value: "context" });
    expect(await other.evaluate(() => localStorage.getItem("k"))).toBe("context");
    expect(await page.evaluate(() => localStorage.getItem("k"))).toBe(null);
  } finally {
    await context.close();
  }
}, 60_000);
