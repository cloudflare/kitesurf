// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("cross-origin-nav-demo", async ({ page }) => {
  const FIRST_URL = "https://example.com/__fixtures/inline-script.html";
  const SECOND_URL =
    process.env.KITESURF_FIXTURE ?? "http://127.0.0.1:8787/__fixtures/inline-script.html";

  await page.goto(FIRST_URL, { timeout: 15000 });

  const sameHost1 = await page.evaluate(() =>
    fetch("https://example.com/__fixtures/inline-script.html")
      .then((r) => r.status)
      .catch((e) => String(e)),
  );
  expect(sameHost1, "expected 200 same-host on page 1").toBe(200);

  await page.goto(SECOND_URL, { timeout: 15000 });

  const newHref = await page.evaluate(() => location.href);
  expect(
    newHref.startsWith("http://127.0.0.1:") && newHref.includes("/__fixtures/"),
    `page 2 location wrong: ${newHref}`,
  ).toBeTruthy();

  const sameHost2 = await page.evaluate(() =>
    fetch("/__fixtures/inline-script.html")
      .then((r) => r.status)
      .catch((e) => String(e)),
  );
  expect(sameHost2, "expected 200 same-host on page 2").toBe(200);

  const blocked2 = await page.evaluate(() =>
    fetch("https://example.com/__fixtures/inline-script.html")
      .then((r) => "got status " + r.status)
      .catch((e) => "blocked: " + (e && e.message ? e.message : String(e))),
  );
  expect(
    blocked2.startsWith("blocked: "),
    `expected example.com to be blocked from page 2, got ${blocked2}`,
  ).toBeTruthy();
});
