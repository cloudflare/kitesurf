// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { HTTPRequest } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";

const MODULE = "/__fixtures/inserted-ok.js";

test("a module rejected by its integrity pin does not resolve to a query variant", async ({
  page,
}) => {
  const pin = "sha384-" + "A".repeat(64);
  await page.setRequestInterception(true);
  page.on("request", (req: HTTPRequest) => {
    if (!req.url().endsWith("/variant-pin.html")) return void req.continue();
    void req.respond({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><title>start</title>
        <script type="module" src="${MODULE}" integrity="${pin}"></script>
        <script type="module">
          import "${MODULE}";
          if (false) import("${MODULE}?variant=1");
          document.title = "imported";
        </script>`,
    });
  });
  await page.goto("https://ks.invalid/variant-pin.html", { waitUntil: "load" });
  expect(await page.evaluate(() => Reflect.get(window, "__insertedRan") ?? false)).toBe(false);
  expect(await page.evaluate(() => document.title)).toBe("start");
}, 60_000);
