// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// HTML §fetch-a-classic-script: parser-time classic scripts without `crossorigin` use no-CORS.
import { expect, test, type BrowserFactory } from "./harness";

const PAGE = "https://ks.invalid/__fixtures/corp-script-page.html";

async function ranCount(browserFactory: BrowserFactory, query: string): Promise<number> {
  const browser = await browserFactory();
  const page = await browser.newPage();
  await page.goto(`${PAGE}${query}`, { waitUntil: "load" });
  const n: unknown = await page.evaluate(`(() => globalThis.__ks_corp_ran || 0)()`);
  return Number(n);
}

test("no CORP header executes", async ({ browserFactory }) => {
  expect(await ranCount(browserFactory, "")).toBe(1);
});

test("CORP same-origin blocks a cross-origin classic script", async ({ browserFactory }) => {
  expect(await ranCount(browserFactory, "?policy=same-origin")).toBe(0);
});

test("CORP same-site blocks across sites", async ({ browserFactory }) => {
  expect(await ranCount(browserFactory, "?policy=same-site")).toBe(0);
});

// Fetch §cross-origin-resource-policy-header: unknown values are ignored.
test("an unrecognized CORP value is ignored", async ({ browserFactory }) => {
  expect(await ranCount(browserFactory, "?policy=SAME-ORIGIN")).toBe(1);
  expect(await ranCount(browserFactory, "?policy=cross-origin")).toBe(1);
  expect(await ranCount(browserFactory, "?policy=" + encodeURIComponent("same-origin, x"))).toBe(1);
});

test("a crossorigin script is governed by ACAO, not CORP", async ({ browserFactory }) => {
  expect(await ranCount(browserFactory, "?crossorigin=1&policy=cross-origin")).toBe(0);
});
