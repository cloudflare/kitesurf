// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const BASE = "https://ks.invalid/__fixtures";

test("redirect chain: per-hop events, final URL and status", async ({ page, cdpSession: cdp }) => {
  await cdp.send("Network.enable");
  const hops: Array<{ url: string; redirectFrom?: string }> = [];
  cdp.on("Network.requestWillBeSent", (e) => {
    const ev = e as {
      request: { url: string };
      redirectResponse?: { url: string };
      type?: string;
    };
    if (ev.type === "Document") {
      hops.push({
        url: ev.request.url,
        redirectFrom: ev.redirectResponse?.url,
      });
    }
  });
  const resp = await page.goto(`${BASE}/redirect-hop?n=1`, {
    waitUntil: "domcontentloaded",
  });
  expect(page.url()).toBe(`${BASE}/lifecycle.html`);
  expect(resp!.status()).toBe(200);
  const chain = hops.filter((h) => h.url.includes("/__fixtures/"));
  expect(chain.length).toBe(4);
  expect(chain[1]!.redirectFrom).toBe(`${BASE}/redirect-hop?n=1`);
  expect(chain[3]!.url).toBe(`${BASE}/lifecycle.html`);
}, 120_000);

test("navigation failures: invalid URL and 204 abort", async ({ cdpSession: cdp }) => {
  await expect(cdp.send("Page.navigate", { url: "asdfasdf" })).rejects.toThrow(
    /Cannot navigate to invalid URL/,
  );
  const nav = (await cdp.send("Page.navigate", {
    url: `${BASE}/status-204`,
  })) as { errorText?: string };
  expect(nav.errorText).toBe("net::ERR_ABORTED");
}, 120_000);

test("subresource referer: full URL same-origin, honors goto referer for the doc", async ({
  page,
  cdpSession: cdp,
}) => {
  await cdp.send("Page.enable");
  const loaded = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 15_000);
    cdp.once("Page.loadEventFired", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await cdp.send("Page.navigate", {
    url: `${BASE}/lifecycle.html#secret-fragment`,
    referrer: "http://google.com/",
  });
  await loaded;
  const echoed = await page.evaluate(`
    fetch("/__fixtures/echo-headers.json").then((r) => r.text())
  `);
  const headers = JSON.parse(echoed as string) as Record<string, string>;
  expect(headers.referer).toBe(`${BASE}/lifecycle.html`);
}, 120_000);

test("document.referrer: the Referer after a cross-origin redirect hop", async ({ page }) => {
  // The hop to ks-alt.invalid cuts the Referer down to its origin, and the
  // document must report what its final request sent, not the first one.
  const to = encodeURIComponent("https://ks-alt.invalid/__fixtures/lifecycle.html");
  await page.goto(`${BASE}/cors-redirect?to=${to}`, {
    referer: "https://ref.invalid/path?q=1",
    waitUntil: "domcontentloaded",
  });
  expect(page.url()).toBe("https://ks-alt.invalid/__fixtures/lifecycle.html");
  expect(await page.evaluate("document.referrer")).toBe("https://ref.invalid/");
}, 120_000);
