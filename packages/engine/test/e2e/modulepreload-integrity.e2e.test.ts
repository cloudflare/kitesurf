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

test("runtime imports enforce modulepreload integrity", async ({ page }) => {
  const dep = "/__fixtures/inserted-module/dep.js";
  await page.goto("https://ks.invalid/__fixtures/lifecycle.html", { waitUntil: "load" });
  const good = await sha384(page, `https://ks.invalid${dep}`);
  for (const [kind, pin, expected] of [
    ["computed", good, "from-dep"],
    ["inserted", good, "load:tool"],
    ["computed", "sha384-" + "A".repeat(64), "rejected"],
    ["inserted", "sha384-" + "A".repeat(64), "error:"],
  ]) {
    const script =
      kind === "computed"
        ? `var u = ${JSON.stringify(dep)}; import(u).then(m => window.result = m.label, () => window.result = "rejected");`
        : `var s = document.createElement("script"); s.type = "module";
         s.src = "/__fixtures/inserted-module/tool.js";
         s.onload = () => window.result = "load:" + (window.__insertedModule || []).join();
         s.onerror = () => window.result = "error:" + (window.__insertedModule || []).join();
         document.head.appendChild(s);`;
    const body = `<link rel="modulepreload" href="${dep}" integrity="${pin}"><script>${script}</script>`;
    const url = new URL("https://ks.invalid/__fixtures/policy-doc.html");
    url.searchParams.set("body", body);
    await page.goto(url.toString(), { waitUntil: "load" });
    await page.waitForFunction(() => Reflect.get(window, "result") != null, { timeout: 20_000 });
    expect(await page.evaluate(() => Reflect.get(window, "result"))).toBe(expected);
  }
}, 90_000);
