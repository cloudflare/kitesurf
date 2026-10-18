// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const DOC = "https://ks.invalid/__fixtures/gzip-only-doc.html";

test("a gzip-only document arrives whole and decoded", async ({ page }) => {
  const resp = await page.goto(DOC, { waitUntil: "load" });
  expect(resp?.status()).toBe(200);
  const got = await page.evaluate(() => ({
    ae: document.getElementById("ae")?.textContent,
    tail: document.getElementById("tail")?.textContent?.endsWith("complete"),
  }));
  expect(got).toEqual({ ae: "gzip, br", tail: true });
}, 120_000);

test("page fetch offers gzip and br", async ({ page }) => {
  const body = await page.evaluate(`
    fetch("https://ks.invalid/__fixtures/echo-headers.json").then((r) => r.text())
  `);
  const headers = JSON.parse(String(body)) as Record<string, string>;
  expect(headers["accept-encoding"]).toBe("gzip, br");
}, 120_000);

test("setExtraHTTPHeaders cannot offer codings workerd cannot decode", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "Accept-Encoding": "gzip, deflate, br, zstd" });
  await page.goto(DOC, { waitUntil: "load" });
  const ae = await page.evaluate(() => document.getElementById("ae")?.textContent);
  expect(ae).toBe("gzip, br");
}, 120_000);
