// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A data: URL has basic response tainting, so crossorigin and type=module apply no CORS check to
// it. The page needs a real origin: setContent would commit an opaque data: document.
import type { Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";

const ORIGIN = "https://ks.invalid";

const data = (marker: string): string => `data:text/javascript,window.${marker}=1`;

const docUrl = (body: string, csp = ""): string => {
  const u = new URL(`${ORIGIN}/__fixtures/policy-doc.html`);
  if (csp) u.searchParams.set("csp", csp);
  u.searchParams.set("body", body);
  return u.toString();
};

async function markers(page: Page, names: string[]): Promise<Record<string, unknown>> {
  return await page.evaluate(
    (keys: string[]) =>
      Object.fromEntries(
        keys.map((k): [string, unknown] => [k, Reflect.get(globalThis, k) ?? null]),
      ),
    names,
  );
}

async function waitFor(page: Page, name: string): Promise<void> {
  await page.waitForFunction(
    (key: string) => Reflect.get(globalThis, key) !== undefined,
    { timeout: 20_000 },
    name,
  );
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((r) => setTimeout(r, 1000)));
}

test("crossorigin, module and import() data: scripts all run", async ({ page }) => {
  const body = `
    <script src="${data("PLAIN")}"></script>
    <script crossorigin src="${data("ANON")}"></script>
    <script crossorigin="use-credentials" src="${data("CRED")}"></script>
    <script type="module" src="${data("MODULE")}"></script>
    <script type="module">import("${data("DYN_IMPORT")}").then(() => { window.DONE = 1; });</script>`;
  await page.goto(docUrl(body), { waitUntil: "load" });
  await waitFor(page, "DONE");
  expect(await markers(page, ["PLAIN", "ANON", "CRED", "MODULE", "DYN_IMPORT"])).toEqual({
    PLAIN: 1,
    ANON: 1,
    CRED: 1,
    MODULE: 1,
    DYN_IMPORT: 1,
  });
}, 60_000);

test("SRI applies to a data: script without crossorigin", async ({ page }) => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-384", new TextEncoder().encode("window.SRI_GOOD=1")),
  );
  const integrity = `sha384-${btoa(String.fromCharCode(...digest))}`;
  const body = `
    <script src="${data("SRI_GOOD")}" integrity="${integrity}"></script>
    <script src="${data("SRI_BAD")}" integrity="${integrity}"></script>`;
  await page.goto(docUrl(body), { waitUntil: "load" });
  await settle(page);
  expect(await markers(page, ["SRI_GOOD", "SRI_BAD"])).toEqual({ SRI_GOOD: 1, SRI_BAD: null });
}, 60_000);

test("a static import of a data: module runs", async ({ page }) => {
  const inner = (marker: string): string => `data:text/javascript,window.${marker}=1`;
  const outer = `data:text/javascript,import ${JSON.stringify(inner("INNER"))};window.OUTER=1`;
  const body = `
    <script type="module" src="${outer.replaceAll('"', "&quot;")}"></script>
    <script type="module">import "${inner("FROM_INLINE")}"; window.INLINE=1;</script>`;
  await page.goto(docUrl(body), { waitUntil: "load" });
  await settle(page);
  expect(await markers(page, ["INNER", "OUTER", "FROM_INLINE", "INLINE"])).toEqual({
    INNER: 1,
    OUTER: 1,
    FROM_INLINE: 1,
    INLINE: 1,
  });
}, 60_000);

test("script-src governs a static data: import", async ({ page }) => {
  const body = `<script type="module">import "${data("STATIC_IMPORT")}"; window.IMPORTER=1;</script>
    <script>window.CLASSIC=1;</script>`;
  const run = async (csp: string) => {
    await page.goto(docUrl(body, csp), { waitUntil: "load" });
    await settle(page);
    return await markers(page, ["STATIC_IMPORT", "IMPORTER", "CLASSIC"]);
  };
  expect(await run("script-src 'self' 'unsafe-inline'")).toEqual({
    STATIC_IMPORT: null,
    IMPORTER: null,
    CLASSIC: 1,
  });
  expect(await run("script-src 'self' 'unsafe-inline' data:")).toEqual({
    STATIC_IMPORT: 1,
    IMPORTER: 1,
    CLASSIC: 1,
  });
}, 60_000);

test("an inserted crossorigin data: script runs", async ({ page }) => {
  const body = `<script>
    var s = document.createElement("script");
    s.crossOrigin = "anonymous";
    s.src = ${JSON.stringify(data("INSERTED"))};
    s.onload = function () { window.OUTCOME = "load:" + (window.INSERTED || 0); };
    s.onerror = function () { window.OUTCOME = "error:" + (window.INSERTED || 0); };
    document.head.appendChild(s);
  </script>`;
  await page.goto(docUrl(body), { waitUntil: "load" });
  await waitFor(page, "OUTCOME");
  expect(await page.evaluate(() => (globalThis as { OUTCOME?: string }).OUTCOME)).toBe("load:1");
}, 60_000);

test("a cross-origin crossorigin https: script without ACAO stays blocked", async ({ page }) => {
  const body = `
    <script crossorigin src="https://ks-other.invalid/__fixtures/corp-script.js"></script>
    <script crossorigin src="${data("CONTROL")}"></script>`;
  await page.goto(docUrl(body), { waitUntil: "load" });
  await settle(page);
  expect(await markers(page, ["__ks_corp_ran", "CONTROL"])).toEqual({
    __ks_corp_ran: null,
    CONTROL: 1,
  });
}, 60_000);

test("an https: redirect to a data: script stays blocked", async ({ page }) => {
  const hop = (marker: string): string => {
    const u = new URL("https://ks-other.invalid/__fixtures/cors-redirect");
    u.searchParams.set("to", data(marker));
    return u.toString();
  };
  const body = `
    <script crossorigin src="${hop("REDIRECT_CLASSIC")}"></script>
    <script type="module" src="${hop("REDIRECT_MODULE")}"></script>
    <script crossorigin src="${data("CONTROL")}"></script>`;
  await page.goto(docUrl(body), { waitUntil: "load" });
  await settle(page);
  expect(await markers(page, ["REDIRECT_CLASSIC", "REDIRECT_MODULE", "CONTROL"])).toEqual({
    REDIRECT_CLASSIC: null,
    REDIRECT_MODULE: null,
    CONTROL: 1,
  });
}, 60_000);

const CSP_BODY = `
  <script src="${ORIGIN}/__fixtures/policy-script.js?tag=self"></script>
  <script crossorigin src="${data("CSP_ANON")}"></script>
  <script type="module" src="${data("CSP_MODULE")}"></script>`;

async function underCsp(page: Page, csp: string): Promise<Record<string, unknown>> {
  await page.goto(docUrl(CSP_BODY, csp), { waitUntil: "load" });
  await settle(page);
  return {
    ...(await markers(page, ["CSP_ANON", "CSP_MODULE"])),
    ran: await page.evaluate(() => (globalThis as { __ksRan?: string[] }).__ksRan ?? []),
  };
}

test("script-src without data: still blocks data: scripts", async ({ page }) => {
  expect(await underCsp(page, "script-src 'self'")).toEqual({
    CSP_ANON: null,
    CSP_MODULE: null,
    ran: ["self"],
  });
}, 60_000);

test("script-src with data: runs them", async ({ page }) => {
  expect(await underCsp(page, "script-src 'self' data:")).toEqual({
    CSP_ANON: 1,
    CSP_MODULE: 1,
    ran: ["self"],
  });
}, 60_000);
