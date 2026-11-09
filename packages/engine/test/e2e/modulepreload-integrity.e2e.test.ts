// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { HTTPRequest } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";

const MODULE = "/__fixtures/inserted-ok.js";

test("a module imported under a modulepreload integrity pin runs only if it matches", async ({
  page,
}) => {
  const pin = "sha384-" + "A".repeat(64);
  await page.setRequestInterception(true);
  page.on("request", (req: HTTPRequest) => {
    if (!req.url().endsWith("/preload-pin.html")) return void req.continue();
    void req.respond({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><title>start</title>
        <link rel="modulepreload" href="${MODULE}" integrity="${pin}">
        <script type="module">import "${MODULE}"; document.title = "imported";</script>`,
    });
  });
  await page.goto("https://ks.invalid/preload-pin.html", { waitUntil: "load" });
  expect(await page.evaluate(() => Reflect.get(window, "__insertedRan") ?? false)).toBe(false);
  expect(await page.evaluate(() => document.title)).toBe("start");
}, 60_000);
