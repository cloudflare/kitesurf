// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// localStorage belongs to the browser context, not the document: the engine keeps each origin's
// area and every navigation gets a copy (state/local-storage.ts, page-script web-storage.ts).
import type { Page } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";
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

test("pages share localStorage from their next navigation on", async ({ browser, page }) => {
  // Each page works on a copy of the area taken at navigation.
  const two = await browser.newPage();
  try {
    await page.goto(A, { waitUntil: "load" });
    await two.goto(A, { waitUntil: "load" });
    await page.evaluate(() => {
      localStorage.setItem("a", "1");
      localStorage.setItem("b", "2");
    });
    expect(await read(two)).toEqual({});
    // remove and clear reach keys this page's copy never had.
    await two.evaluate(() => localStorage.removeItem("a"));
    await page.reload({ waitUntil: "load" });
    expect(await read(page)).toEqual({ b: "2" });
    await two.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "load" });
    expect(await read(page)).toEqual({});
  } finally {
    await two.close();
  }
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
  await cdpSession.send("Storage.clearDataForOrigin", {
    origin,
    storageTypes: "cookies,local_storage",
  });
  await page.reload({ waitUntil: "load" });
  expect(await read(page)).toEqual({});
  await page.goto(OTHER, { waitUntil: "load" });
  expect(await read(page)).toEqual({ k: "other" });
  const storageKey = `${new URL(OTHER).origin}/`;
  await cdpSession.send("Storage.clearDataForStorageKey", { storageKey, storageTypes: "all" });
  await page.reload({ waitUntil: "load" });
  expect(await read(page)).toEqual({});
}, 120_000);
