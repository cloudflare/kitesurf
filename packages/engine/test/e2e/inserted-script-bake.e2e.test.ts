// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { waitForTitle } from "./waits";

const URL = "http://127.0.0.1:8787/__fixtures/inserted-bake.html";

async function load(page: import("@cloudflare/puppeteer").Page) {
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  const title = await waitForTitle(page, "BAKE:", { prefix: true, timeout: 30000 });
  expect(title.startsWith("BAKE:{"), "fixture never reported (title=" + title + ")").toBeTruthy();
  return JSON.parse(title.slice("BAKE:".length));
}

async function loadInserting(
  page: import("@cloudflare/puppeteer").Page,
  src: string,
): Promise<string> {
  await page.goto(URL + "?src=" + encodeURIComponent(src), {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  const title = await waitForTitle(page, "BAKE:", { prefix: true, timeout: 30000 });
  expect(title.startsWith("BAKE:"), "fixture never reported (title=" + title + ")").toBeTruthy();
  return title.slice("BAKE:".length);
}

function probe(mode: "stable" | "volatile" | "gone" | "slow"): { key: string; src: string } {
  const key = mode + "-" + Math.random().toString(36).slice(2);
  return { key, src: `/__fixtures/inserted-probe/${mode}/${key}.js` };
}

async function probeHits(page: import("@cloudflare/puppeteer").Page, key: string): Promise<number> {
  const hits: unknown = await page.evaluate(
    `fetch("/__fixtures/inserted-probe-hits/${key}").then((r) => r.json()).then((b) => b.hits)`,
  );
  expect(typeof hits).toBe("number");
  return typeof hits === "number" ? hits : NaN;
}

test("a script the origin inserted before runs natively on the next navigate", async ({ page }) => {
  const first = await load(page);
  expect(first).toEqual({
    native: false,
    runs: 1,
    hello: "hi",
    current: "/__fixtures/inserted-bake.js",
    strict: [true, true],
  });
  const second = await load(page);
  expect(second).toEqual({
    native: true,
    runs: 1,
    hello: "hi",
    current: "/__fixtures/inserted-bake.js",
    strict: [true, true],
  });
}, 90_000);

test("a learned script whose bytes change under the page stops being prefetched", async ({
  page,
}) => {
  const { key, src } = probe("volatile");
  await loadInserting(page, src);
  await loadInserting(page, src);
  expect(await probeHits(page, key)).toBe(3);
  await loadInserting(page, src);
  expect(await probeHits(page, key)).toBe(4);
}, 90_000);

test("a learned script that no longer loads stops being prefetched", async ({ page }) => {
  const { key, src } = probe("gone");
  await loadInserting(page, src);
  await loadInserting(page, "none");
  expect(await probeHits(page, key)).toBe(2);
  await loadInserting(page, "none");
  expect(await probeHits(page, key)).toBe(2);
}, 90_000);

test("a script learned in one browser context is not baked in another", async ({ browser }) => {
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  expect((await load(page)).native).toBe(false);
  const isolated = await browser.createBrowserContext();
  try {
    const other = await isolated.newPage();
    expect((await load(other)).native).toBe(false);
    expect((await load(page)).native).toBe(true);
  } finally {
    await isolated.close();
  }
}, 90_000);

test("a slow learned script does not hold up the next navigate", async ({ page }) => {
  const { src } = probe("slow");
  await loadInserting(page, src);
  const started = Date.now();
  await loadInserting(page, "none");
  expect(Date.now() - started).toBeLessThan(3_000);
}, 90_000);

test("a speculative prefetch is not reported as a page request", async ({ page }) => {
  const { key, src } = probe("stable");
  await loadInserting(page, src);
  const seen: string[] = [];
  page.on("request", (req) => {
    seen.push(req.url());
  });
  await loadInserting(page, "none");
  expect((await page.cookies()).map((c) => c.name)).not.toContain("probe_" + key);
  expect(seen.filter((u) => u.includes("/inserted-probe/"))).toEqual([]);
  expect(await probeHits(page, key)).toBe(2);
}, 90_000);

test("a speculative prefetch does not go around Fetch interception", async ({ page }) => {
  const { key, src } = probe("stable");
  await loadInserting(page, src);
  await page.setRequestInterception(true);
  const paused: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/inserted-probe/")) paused.push(req.url());
    else void req.continue();
  });
  await loadInserting(page, "none");
  expect(paused).toEqual([]);
  expect(await probeHits(page, key)).toBe(1);
}, 90_000);
