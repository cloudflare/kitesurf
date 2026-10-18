// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { waitForTitle } from "./waits";

test("inserted external scripts: load, error, and silent transport failure", async ({
  browser,
}) => {
  const page = (await browser.pages())[0] ?? (await browser.newPage());

  await page.goto("http://127.0.0.1:8787/__fixtures/inserted-script.html", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  const title = await waitForTitle(page, "INSERTED:", {
    prefix: true,
    timeout: 30000,
  });
  expect(
    title.startsWith("INSERTED:"),
    "fixture never reported (title=" + title + ")",
  ).toBeTruthy();

  const out = JSON.parse(title.slice("INSERTED:".length));

  expect(out.ran, "inserted script executed").toBe(true);

  expect(out.events, "events").toEqual([
    "error:/__fixtures/inserted-missing.js",
    "load:/__fixtures/inserted-ok.js",
  ]);
});
