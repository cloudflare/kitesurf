// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// localStorage belongs to the browser context and sessionStorage to the tab, not the document:
// the engine keeps each origin's areas and every navigate gets copies (state/web-storage.ts).
import type { Page } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";
import { setContent } from "./set-content";

const A = "https://ks.invalid/__fixtures/lifecycle.html";
const A2 = "https://ks.invalid/__fixtures/big-doc.html?rows=1&seed=1";
const OTHER = "https://ks-other.invalid/__fixtures/lifecycle.html";
const LEAVES = "https://ks.invalid/__fixtures/web-storage-a.html";
const LANDS = "https://ks.invalid/__fixtures/web-storage-b.html";

const read = (p: Page, name: "localStorage" | "sessionStorage" = "localStorage") =>
  p.evaluate((n) => {
    const storage = n === "localStorage" ? localStorage : sessionStorage;
    const out: Record<string, string | null> = {};
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k !== null) out[k] = storage.getItem(k);
    }
    return out;
  }, name);

test("localStorage and sessionStorage outlive navigates, per origin", async ({ page }) => {
  await page.goto(A, { waitUntil: "load" });
  await page.evaluate(() => {
    localStorage.setItem("k", "local");
    sessionStorage.setItem("k", "tab");
  });
  await page.goto(A2, { waitUntil: "load" });
  expect(await read(page)).toEqual({ k: "local" });
  expect(await read(page, "sessionStorage")).toEqual({ k: "tab" });
  await page.goto(OTHER, { waitUntil: "load" });
  expect(await read(page)).toEqual({}); // another origin has its own areas
  expect(await read(page, "sessionStorage")).toEqual({});
  await page.goto(A, { waitUntil: "load" });
  expect(await read(page)).toEqual({ k: "local" });
  expect(await read(page, "sessionStorage")).toEqual({ k: "tab" });
}, 120_000);

test("writes made just before a page navigates itself reach the next document", async ({
  browser,
  page,
}) => {
  // web-storage-a.html writes both areas and sets location.href in its load handler;
  // web-storage-b.html reports what it reads while parsing in its title.
  await page.goto(LEAVES, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForFunction(() => document.title.startsWith("{"), { timeout: 15_000 });
  expect(page.url()).toBe(LANDS);
  expect(JSON.parse(await page.title())).toEqual({
    local: "local",
    session: "session",
    keys: ["cart"],
  });
  const two = await browser.newPage();
  try {
    await two.goto(LANDS, { waitUntil: "load" });
    expect(JSON.parse(await two.title())).toEqual({
      local: "local",
      session: null,
      keys: ["cart"],
    });
  } finally {
    await two.close();
  }
}, 120_000);

test("each tab has its own sessionStorage", async ({ browser, page }) => {
  const two = await browser.newPage();
  try {
    await page.goto(A, { waitUntil: "load" });
    await two.goto(A, { waitUntil: "load" });
    await page.evaluate(() => sessionStorage.setItem("k", "one"));
    await two.evaluate(() => sessionStorage.setItem("k", "two"));
    await page.reload({ waitUntil: "load" });
    await two.reload({ waitUntil: "load" });
    expect(await read(page, "sessionStorage")).toEqual({ k: "one" });
    expect(await read(two, "sessionStorage")).toEqual({ k: "two" });
  } finally {
    await two.close();
  }
  const three = await browser.newPage(); // a new tab starts empty
  try {
    await three.goto(A, { waitUntil: "load" });
    expect(await read(three, "sessionStorage")).toEqual({});
  } finally {
    await three.close();
  }
}, 120_000);

test("pages share localStorage from their next navigate on", async ({ browser, page }) => {
  const two = await browser.newPage();
  try {
    await page.goto(A, { waitUntil: "load" });
    await two.goto(A, { waitUntil: "load" });
    await page.evaluate(() => {
      localStorage.setItem("a", "1");
      localStorage.setItem("b", "2");
    });
    expect(await read(two)).toEqual({}); // each page works on the copy it took at navigate
    // remove and clear reach keys this page's copy never had: the engine's area got them
    // from the other page after this copy was taken.
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

// about:blank and setContent documents get one stand-in base URL. It is not an origin: two
// such documents are unrelated, and the second must not read what the first stored.
test("documents with no URL of their own do not share storage", async ({ browser, page }) => {
  await setContent(page, "<p>first</p>");
  await page.evaluate(() => {
    localStorage.setItem("cart", "customer-a");
    sessionStorage.setItem("step", "2");
  });
  await setContent(page, "<p>second</p>");
  expect(await read(page)).toEqual({});
  expect(await read(page, "sessionStorage")).toEqual({});
  const other = await browser.newPage();
  await setContent(other, "<p>third</p>");
  expect(await read(other)).toEqual({});
  await other.close();
});

test("a Storage shows its keys as properties, and a named write is kept", async ({ page }) => {
  await page.goto(A, { waitUntil: "load" });
  const shape = await page.evaluate(() => {
    localStorage.foo = "bar";
    localStorage[9] = 1;
    localStorage.setItem("length", "shadowed");
    localStorage.gone = "x";
    delete localStorage.gone;
    return {
      keys: Object.keys(localStorage),
      length: localStorage.length,
      shadowed: localStorage.getItem("length"),
      has: ["foo" in localStorage, "gone" in localStorage],
      tag: Object.prototype.toString.call(localStorage),
      json: JSON.stringify(localStorage),
    };
  });
  expect(shape).toEqual({
    keys: ["foo", "9"],
    length: 3,
    shadowed: "shadowed",
    has: [true, false],
    tag: "[object Storage]",
    json: '{"foo":"bar","9":"1"}',
  });
  await page.goto(A2, { waitUntil: "load" });
  expect(await read(page)).toEqual({ foo: "bar", 9: "1", length: "shadowed" });
}, 120_000);
