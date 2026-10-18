// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("network-extra-headers-demo", async ({ page }) => {
  const ECHO = process.env.KITESURF_FIXTURE ?? "http://127.0.0.1:8787/__fixtures/echo-headers.html";

  await page.setExtraHTTPHeaders({
    "x-test-flavour": "salty",
    "X-Custom-Auth": "Bearer demo-token",
    "x-kitesurf-resource-type": "Hostile",
    "x-kitesurf-test": "should-not-arrive",
  });

  await page.goto(ECHO, { timeout: 15000 });

  const docHeaders = await page.evaluate(() => globalThis.__ks_doc_headers);
  expect(docHeaders["x-test-flavour"] === "salty", "doc fetch carries x-test-flavour").toBeTruthy();
  expect(
    docHeaders["x-custom-auth"] === "Bearer demo-token",
    "doc fetch carries X-Custom-Auth",
  ).toBeTruthy();
  expect(
    docHeaders["x-kitesurf-resource-type"] !== "Hostile" &&
      docHeaders["x-kitesurf-test"] === undefined,
    "x-kitesurf-* sanitised on doc fetch",
  ).toBeTruthy();

  const subHeaders = await page.evaluate(async () => {
    await globalThis.__ks_fetch_ready;
    return globalThis.__ks_fetch_headers;
  });
  expect(
    subHeaders["x-test-flavour"] === "salty",
    "subresource fetch carries x-test-flavour",
  ).toBeTruthy();
  expect(
    subHeaders["x-custom-auth"] === "Bearer demo-token",
    "subresource fetch carries X-Custom-Auth",
  ).toBeTruthy();
  expect(
    subHeaders["x-kitesurf-resource-type"] !== "Hostile" &&
      subHeaders["x-kitesurf-test"] === undefined,
    "x-kitesurf-* sanitised on sub fetch",
  ).toBeTruthy();

  await page.setExtraHTTPHeaders({});
  await page.goto(ECHO, { timeout: 15000 });
  const docHeaders2 = await page.evaluate(() => globalThis.__ks_doc_headers);
  expect(
    docHeaders2["x-test-flavour"] === undefined && docHeaders2["x-custom-auth"] === undefined,
    "extras cleared on next navigate",
  ).toBeTruthy();
});
