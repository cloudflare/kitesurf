// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// localStorage belongs to the browser context, not the document: the engine keeps each origin's
// area and every navigation gets a copy (state/local-storage.ts, page-script web-storage.ts).
import type { Page } from "@cloudflare/puppeteer";
import { engine, expect, test } from "./harness";
import { openCdpWireSession } from "./cdp-wire";
import { setContent } from "./set-content";

const A = "https://ks.invalid/__fixtures/lifecycle.html";
const A2 = "https://ks.invalid/__fixtures/big-doc.html?rows=1&seed=1";
const OTHER = "https://ks-other.invalid/__fixtures/lifecycle.html";

const read = (p: Page) =>
  p.evaluate(() => {
    const out: Record<string, string | null> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k !== null) out[k] = localStorage.getItem(k);
    }
    return out;
  });

test("localStorage outlives navigations, per origin; sessionStorage does not", async ({ page }) => {
  await page.goto(A, { waitUntil: "load" });
  await page.evaluate(() => {
    localStorage.setItem("k", "local");
    sessionStorage.setItem("k", "tab");
  });
  await page.goto(A2, { waitUntil: "load" });
  expect(await read(page)).toEqual({ k: "local" });
  expect(await page.evaluate(() => sessionStorage.getItem("k"))).toBe(null);
  // Another origin sees its own, empty area; coming back finds ours.
  await page.goto(OTHER, { waitUntil: "load" });
  expect(await read(page)).toEqual({});
  await page.goto(A, { waitUntil: "load" });
  expect(await read(page)).toEqual({ k: "local" });
}, 120_000);

test("a write just before a page-started navigation reaches the next document", async ({
  page,
}) => {
  await page.goto(A, { waitUntil: "load" });
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    // The navigation can destroy the context before the evaluate replies.
    page
      .evaluate((next) => {
        localStorage.setItem("late", "1");
        location.href = next;
      }, A2)
      .catch(() => {}),
  ]);
  expect(page.url()).toBe(A2);
  expect(await read(page)).toEqual({ late: "1" });
}, 120_000);

test("open pages of one origin share localStorage live, with storage events", async ({
  browser,
  page,
}) => {
  const two = await browser.newPage();
  try {
    await page.goto(A, { waitUntil: "load" });
    await two.goto(A, { waitUntil: "load" });
    await two.evaluate(() => {
      const events: unknown[] = [];
      Reflect.set(window, "__events", events);
      addEventListener("storage", (e) => {
        events.push([e.key, e.oldValue, e.newValue, e.url, e.storageArea === localStorage]);
      });
    });
    await page.evaluate(() => {
      localStorage.setItem("a", "1");
      localStorage.setItem("b", "2");
      localStorage.setItem("a", "3");
    });
    await expect.poll(() => read(two)).toEqual({ a: "3", b: "2" });
    await expect
      .poll(() => two.evaluate(() => JSON.stringify(Reflect.get(window, "__events"))))
      .toBe(
        JSON.stringify([
          ["a", null, "1", A, true],
          ["b", null, "2", A, true],
          ["a", "1", "3", A, true],
        ]),
      );
    await two.evaluate(() => localStorage.removeItem("a"));
    await expect.poll(() => read(page)).toEqual({ b: "2" });
    await two.evaluate(() => localStorage.clear());
    await expect.poll(() => read(page)).toEqual({});
    // The writer gets no event for its own changes.
    expect(await page.evaluate(() => Reflect.get(window, "__events") ?? null)).toBe(null);
  } finally {
    await two.close();
  }
}, 120_000);

test("storage events do not depend on the page's StorageEvent or dispatchEvent", async ({
  browser,
  page,
}) => {
  const two = await browser.newPage();
  try {
    await page.goto(A, { waitUntil: "load" });
    await two.goto(A, { waitUntil: "load" });
    await two.evaluate(() => {
      const events: unknown[] = [];
      Reflect.set(window, "__events", events);
      addEventListener("storage", (e) => events.push([e.key, e.isTrusted]));
      Reflect.set(window, "StorageEvent", 1);
      Reflect.set(window, "dispatchEvent", () => true);
    });
    await page.evaluate(() => localStorage.setItem("k", "v"));
    await expect
      .poll(() => two.evaluate(() => JSON.stringify(Reflect.get(window, "__events"))))
      .toBe(JSON.stringify([["k", true]]));
  } finally {
    await two.close();
  }
}, 120_000);

test("an area too large for the navigate call reaches the next document whole", async ({
  page,
}) => {
  await page.goto(A, { waitUntil: "load" });
  // Past the inline seed budget (storage-copies.ts SEED_INLINE_BYTES), so most goes ahead.
  await page.evaluate(() => {
    for (let i = 0; i < 40_000; i++) localStorage.setItem(`k${i}`, String(i));
  });
  await page.goto(A2, { waitUntil: "load" });
  const summary = () =>
    page.evaluate(() => [localStorage.length, localStorage.getItem("k0"), localStorage.k39999]);
  expect(await summary()).toEqual([40_000, "0", "39999"]);
}, 120_000);

test("each browser context has its own localStorage", async ({ browser, page }) => {
  const context = await browser.createBrowserContext();
  try {
    const other = await context.newPage();
    await page.goto(A, { waitUntil: "load" });
    await page.evaluate(() => localStorage.setItem("k", "default"));
    await other.goto(A, { waitUntil: "load" });
    expect(await read(other)).toEqual({});
    await other.evaluate(() => localStorage.setItem("k", "context"));
    await page.reload({ waitUntil: "load" });
    await other.reload({ waitUntil: "load" });
    expect(await read(page)).toEqual({ k: "default" });
    expect(await read(other)).toEqual({ k: "context" });
  } finally {
    await context.close();
  }
}, 120_000);

test("blank documents keep localStorage to themselves", async ({ page, cdpSession }) => {
  // about:blank and a blank page's setDocumentContent render under a stand-in https URL, but
  // their origins are opaque.
  await page.goto("about:blank");
  await page.evaluate(() => localStorage.setItem("k", "blank"));
  const { frameTree } = await cdpSession.send("Page.getFrameTree");
  await cdpSession.send("Page.setDocumentContent", { frameId: frameTree.frame.id, html: "<p>" });
  expect(await read(page)).toEqual({});
  await page.evaluate(() => localStorage.setItem("k", "content"));
  await page.goto("about:blank");
  expect(await read(page)).toEqual({});
}, 120_000);

// Storage is a legacy platform object with named properties: stored keys are its own properties,
// and the methods stay on Storage.prototype.
const NAMED_PROPERTIES_PROBE = `(() => {
  const s = localStorage;
  s.clear();
  s.setItem("k", "v");
  s.b = "2";
  s.setItem("getItem", "hidden");
  const forIn = [];
  for (const key in s) forIn.push(key);
  const r = {
    keys: Object.keys(s),
    spread: { ...s },
    json: JSON.stringify(s),
    forIn,
    named: s.k,
    has: ["k" in s, "missing" in s],
    getItem: typeof s.getItem,
    hidden: s.getItem("getItem"),
    length: s.length,
    proto: Object.getPrototypeOf(s) === Storage.prototype,
    tag: Object.prototype.toString.call(s),
  };
  delete s.k;
  r.deleted = [s.getItem("k"), s.length];
  Object.defineProperty(s, "d", { value: 3 });
  r.defined = s.getItem("d");
  try { new Storage(); r.ctor = "constructed"; } catch (e) { r.ctor = e.name; }
  try { Storage.prototype.getItem.call({}, "k"); r.illegal = "ok"; } catch (e) { r.illegal = e.name; }
  try { s.getItem(); r.noArgs = "ok"; } catch (e) { r.noArgs = e.name; }
  s.clear();
  return JSON.stringify(r);
})()`;

const NAMED_PROPERTIES_EXPECTED = {
  keys: ["k", "b"],
  spread: { k: "v", b: "2" },
  json: '{"k":"v","b":"2"}',
  forIn: ["k", "b", "length", "key", "getItem", "setItem", "removeItem", "clear"],
  named: "v",
  has: [true, false],
  getItem: "function",
  hidden: "hidden",
  length: 3,
  proto: true,
  tag: "[object Storage]",
  deleted: [null, 2],
  defined: "3",
  ctor: "TypeError",
  illegal: "TypeError",
  noArgs: "TypeError",
};

test("stored keys are Storage's own properties, in page scripts and CDP evaluation", async ({
  page,
}) => {
  await setContent(
    page,
    `<script>window.__probe = ${NAMED_PROPERTIES_PROBE};</script><p>storage</p>`,
  );
  const fromScript = await page.evaluate(() => Reflect.get(window, "__probe") as string);
  expect(JSON.parse(fromScript)).toEqual(NAMED_PROPERTIES_EXPECTED);
  const fromEvaluate = (await page.evaluate(NAMED_PROPERTIES_PROBE)) as string;
  // On boa, a for-in over this bridged object visits only its own keys, not Storage.prototype's.
  expect(JSON.parse(fromEvaluate)).toEqual({ ...NAMED_PROPERTIES_EXPECTED, forIn: ["k", "b"] });
}, 60_000);

test("Storage.clearDataForOrigin clears an origin's localStorage", async ({ page, cdpSession }) => {
  await page.goto(A, { waitUntil: "load" });
  await page.evaluate(() => localStorage.setItem("k", "v"));
  await page.goto(OTHER, { waitUntil: "load" });
  await page.evaluate(() => localStorage.setItem("k", "other"));
  const origin = new URL(A).origin;
  // Another storage type leaves localStorage alone.
  await cdpSession.send("Storage.clearDataForOrigin", { origin, storageTypes: "cookies" });
  await page.goto(A, { waitUntil: "load" });
  expect(await read(page)).toEqual({ k: "v" });
  await page.evaluate(() => {
    const events: unknown[] = [];
    Reflect.set(window, "__events", events);
    addEventListener("storage", (e) => events.push(e.key));
  });
  // The open page's copy clears too, and clearing site data fires no storage event.
  await cdpSession.send("Storage.clearDataForOrigin", {
    origin,
    storageTypes: "cookies,local_storage",
  });
  expect(await read(page)).toEqual({});
  expect(await page.evaluate(() => Reflect.get(window, "__events"))).toEqual([]);
  await page.goto(OTHER, { waitUntil: "load" });
  expect(await read(page)).toEqual({ k: "other" });
  const storageKey = `${new URL(OTHER).origin}/`;
  await cdpSession.send("Storage.clearDataForStorageKey", { storageKey, storageTypes: "all" });
  expect(await read(page)).toEqual({});
  await page.reload({ waitUntil: "load" });
  expect(await read(page)).toEqual({});
}, 120_000);

test("Storage.clearDataForOrigin clears an origin's cookies for cookies and all", async ({
  page,
  cdpSession,
}) => {
  const cookieNames = async () =>
    (await cdpSession.send("Storage.getCookies")).cookies
      .map((c) => `${c.domain}:${c.name}`)
      .sort();
  await page.goto(A, { waitUntil: "load" });
  await page.evaluate(() => {
    document.cookie = "a=1; path=/";
    document.cookie = "deep=1; path=/__fixtures";
  });
  await page.goto(OTHER, { waitUntil: "load" });
  await page.evaluate(() => {
    document.cookie = "o=1; path=/";
  });
  const a = new URL(A);
  const other = new URL(OTHER);
  const all = [`${a.hostname}:a`, `${a.hostname}:deep`, `${other.hostname}:o`].sort();
  expect(await cookieNames()).toEqual(all);
  await cdpSession.send("Storage.clearDataForOrigin", {
    origin: a.origin,
    storageTypes: "local_storage",
  });
  expect(await cookieNames()).toEqual(all);
  await cdpSession.send("Storage.clearDataForOrigin", {
    origin: a.origin,
    storageTypes: "cookies",
  });
  expect(await cookieNames()).toEqual([`${other.hostname}:o`]);
  await cdpSession.send("Storage.clearDataForStorageKey", {
    storageKey: `${other.origin}/`,
    storageTypes: "all",
  });
  expect(await cookieNames()).toEqual([]);
}, 120_000);

test("Storage.clearDataForOrigin rejects what it cannot act on", async ({ cdpSession }) => {
  const origin = new URL(A).origin;
  for (const storageTypes of [undefined, "", "bogus", "bogus, other_typo"]) {
    await expect(
      cdpSession.send("Storage.clearDataForOrigin", { origin, storageTypes } as never),
    ).rejects.toThrow("No valid storage type specified");
  }
  await expect(
    cdpSession.send("Storage.clearDataForOrigin", { origin: "not a url", storageTypes: "all" }),
  ).rejects.toThrow("not a url is not a valid URL");
  await expect(
    cdpSession.send("Storage.clearDataForStorageKey", { storageKey: "nope", storageTypes: "all" }),
  ).rejects.toThrow("Invalid Storage Key given.");
  // A partitioned key names data Kitesurf never keeps: valid, and nothing to clear.
  await cdpSession.send("Storage.clearDataForStorageKey", {
    storageKey: `${origin}/^0https://b.test`,
    storageTypes: "all",
  });
}, 60_000);

test("Storage.clearDataForOrigin refuses a session it does not know", async () => {
  // A closed page's session must not fall back to the default context.
  const { ws, next } = await openCdpWireSession(engine);
  ws.send(
    JSON.stringify({
      id: 1,
      sessionId: "no-such-session",
      method: "Storage.clearDataForOrigin",
      params: { origin: new URL(A).origin, storageTypes: "local_storage" },
    }),
  );
  expect(await next()).toEqual({
    id: 1,
    sessionId: "no-such-session",
    error: { code: -32000, message: "Session with given id not found." },
  });
  ws.close();
});
