// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { HTTPRequest, Page } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";

const MODULE = "/__fixtures/inserted-ok.js";

// The quoted `>` must not end the link tag for the scanner; a tag regex stops there.
const documentHtml = (pin: string): string => `<!doctype html><title>start</title>
  <link data-note=">" rel="modulepreload" href="${MODULE}" integrity="${pin}">
  <script>window.__classicRan = true;</script>
  <script type="module">import "${MODULE}"; document.title = "imported";</script>`;

async function sha384(page: Page, url: string): Promise<string> {
  const source = await page.evaluate(async (u) => (await fetch(u)).text(), url);
  const digest = await crypto.subtle.digest("SHA-384", new TextEncoder().encode(source));
  let bin = "";
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return `sha384-${btoa(bin)}`;
}

test("a module imported under a modulepreload integrity pin runs only if it matches", async ({
  page,
}) => {
  const pin = "sha384-" + "A".repeat(64);
  let matchingPin = "";
  await page.setRequestInterception(true);
  page.on("request", (req: HTTPRequest) => {
    const path = new URL(req.url()).pathname;
    if (path === "/preload-pin.html" || path === "/preload-pin-ok.html") {
      return void req.respond({
        status: 200,
        contentType: "text/html",
        body: documentHtml(path === "/preload-pin.html" ? pin : matchingPin),
      });
    }
    void req.continue();
  });
  await page.goto("https://ks.invalid/preload-pin.html", { waitUntil: "load" });
  expect(await page.evaluate(() => Reflect.get(window, "__classicRan") ?? false)).toBe(true);
  expect(await page.evaluate(() => Reflect.get(window, "__insertedRan") ?? false)).toBe(false);
  expect(await page.evaluate(() => document.title)).toBe("start");

  matchingPin = await sha384(page, `https://ks.invalid${MODULE}`);
  await page.goto("https://ks.invalid/preload-pin-ok.html", { waitUntil: "load" });
  expect(await page.evaluate(() => Reflect.get(window, "__insertedRan") ?? false)).toBe(true);
  expect(await page.evaluate(() => document.title)).toBe("imported");
}, 60_000);
