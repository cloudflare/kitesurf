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

function probe(mode: "stable" | "volatile" | "gone" | "slow" | "hostile"): {
  key: string;
  src: string;
} {
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

async function probeHeaders(
  page: import("@cloudflare/puppeteer").Page,
  key: string,
): Promise<Array<string | null>> {
  const headers: unknown = await page.evaluate(
    `fetch("/__fixtures/inserted-probe-headers/${key}").then((r) => r.json()).then((b) => b.headers)`,
  );
  expect(Array.isArray(headers)).toBe(true);
  return headers as Array<string | null>;
}

// A page whose policy admits scripts by nonce alone, as runtime-inserted chunk loaders use it;
// the loader inserts `src` carrying `nonce`, or no nonce at all when it is empty.
async function loadNonced(
  page: import("@cloudflare/puppeteer").Page,
  src: string,
  nonce: string,
  policy = "script-src 'nonce-n0nce'",
): Promise<string> {
  const insert =
    `<script nonce="n0nce">var s = document.createElement("script");` +
    (nonce ? ` s.nonce = ${JSON.stringify(nonce)};` : "") +
    ` s.src = ${JSON.stringify(src)};` +
    ` s.onload = function () { document.title = "BAKE:" + JSON.stringify(` +
    `{ native: window.__insertedNative, runs: window.__insertedRuns }); };` +
    ` s.onerror = function () { document.title = "BAKE:error:" + (window.__insertedRuns || 0); };` +
    ` document.head.appendChild(s);</script>`;
  const doc =
    "https://ks.invalid/__fixtures/policy-doc.html?csp=" +
    encodeURIComponent(policy) +
    "&body=" +
    encodeURIComponent(insert);
  await page.goto(doc, { waitUntil: "domcontentloaded", timeout: 30000 });
  const title = await waitForTitle(page, "BAKE:", { prefix: true, timeout: 30000 });
  expect(title.startsWith("BAKE:"), "fixture never reported (title=" + title + ")").toBeTruthy();
  return title.slice("BAKE:".length);
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

test("a learned inserted script cannot import a private sibling", async ({ page }) => {
  const { src } = probe("hostile");
  await loadInserting(page, src);
  const baked = JSON.parse(await loadInserting(page, src));
  expect(baked.native).toBe(true);
  expect(baked.runs).toBe(1);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "__hostileResult")))
    .toBe("refused");
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

test("a speculative prefetch omits the session's extra headers", async ({ page }) => {
  for (const origin of ["http://127.0.0.1:8787", "http://ks-other.invalid"]) {
    const learned = probe("stable");
    const fresh = probe("stable");
    await page.setExtraHTTPHeaders({});
    await loadInserting(page, origin + learned.src);
    await page.setExtraHTTPHeaders({ "x-probe-secret": "session" });
    const title = await loadInserting(page, origin + fresh.src);
    expect(await probeHeaders(page, learned.key)).toEqual([null, null]);
    expect(await probeHeaders(page, fresh.key)).toEqual(["session"]);
    expect(JSON.parse(title)).toMatchObject({ runs: 1, hello: "hi" });
  }
}, 120_000);

test("a learned script carrying the page's nonce runs natively under a nonce policy", async ({
  page,
}) => {
  const { src } = probe("stable");
  expect(JSON.parse(await loadNonced(page, src, "n0nce"))).toEqual({ native: false, runs: 1 });
  expect(JSON.parse(await loadNonced(page, src, "n0nce"))).toEqual({ native: true, runs: 1 });
}, 90_000);

test("a learned script behind a redirect runs natively under a nonce policy", async ({ page }) => {
  const src = "/__fixtures/loud-redirect?to=" + encodeURIComponent(probe("stable").src);
  expect(JSON.parse(await loadNonced(page, src, "n0nce"))).toEqual({ native: false, runs: 1 });
  // A url with a query is learned on its second insertion. The prefetch's redirect hop carries
  // no nonce, so it must answer to the learned gate for the third load to bake.
  expect(JSON.parse(await loadNonced(page, src, "n0nce"))).toEqual({ native: false, runs: 1 });
  expect(JSON.parse(await loadNonced(page, src, "n0nce"))).toEqual({ native: true, runs: 1 });
}, 90_000);

test("a prefetched learned script without the page's nonce is still refused", async ({ page }) => {
  const { key, src } = probe("stable");
  expect(JSON.parse(await loadNonced(page, src, "n0nce"))).toEqual({ native: false, runs: 1 });
  expect(await loadNonced(page, src, "")).toBe("error:0");
  expect(await loadNonced(page, src, "other")).toBe("error:0");
  // The two refused navigates each prefetched and baked the script; only the first page fetched
  // it, so the bake existed both times and the policy still kept it from running.
  expect(await probeHits(page, key)).toBe(3);
}, 90_000);

// The learned store is per origin, and one origin's documents can carry different policies: a
// script learned under one must not be fetched for a document whose policy forbids its host.
test("a learned script is not prefetched for a document whose policy forbids its host", async ({
  page,
}) => {
  const { key, src } = probe("stable");
  const cross = "https://ks-other.invalid" + src;
  expect(JSON.parse(await loadNonced(page, cross, "n0nce"))).toEqual({ native: false, runs: 1 });
  expect(await probeHits(page, key)).toBe(1);
  // A 'self' policy names no nonce for the prefetch to assume, so the host rule decides. The
  // page's own insertion is refused before it fetches, and the probe is never asked again.
  expect(await loadNonced(page, cross, "", "script-src 'self' 'unsafe-inline'")).toBe("error:0");
  expect(await probeHits(page, key)).toBe(1);
}, 90_000);
