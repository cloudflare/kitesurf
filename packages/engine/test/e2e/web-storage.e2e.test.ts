// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// localStorage belongs to the browser context, not the document: the engine keeps each origin's
// area and every navigate gets a copy (state/web-storage.ts, page-script web-storage.ts).
import type { Page } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";

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

test("localStorage outlives navigates, per origin; sessionStorage does not", async ({ page }) => {
  await page.goto(A, { waitUntil: "load" });
  await page.evaluate(() => {
    localStorage.setItem("k", "local");
    sessionStorage.setItem("k", "tab");
  });
  await page.goto(A2, { waitUntil: "load" });
  expect(await read(page)).toEqual({ k: "local" });
  expect(await page.evaluate(() => sessionStorage.getItem("k"))).toBe(null);
  await page.goto(OTHER, { waitUntil: "load" });
  expect(await read(page)).toEqual({}); // another origin has its own area
  await page.goto(A, { waitUntil: "load" });
  expect(await read(page)).toEqual({ k: "local" });
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
