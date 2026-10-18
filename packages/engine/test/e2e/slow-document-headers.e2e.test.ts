// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

test("a document whose headers take 12 s still loads", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/slow-document.html?ms=12000", {
    waitUntil: "load",
    timeout: 45_000,
  });
  expect(await page.title()).toBe("Slow document");
}, 90_000);

test.for([
  ["same-origin child frame", "http://127.0.0.1:8787", 14_000],
  ["cross-origin OOPIF", "https://ks-other.invalid", 25_000],
] as const)(
  "a %s document keeps the 10 s headers cap",
  { timeout: 90_000 },
  async ([_label, origin, maxMs], { page }) => {
    const frame = `<iframe src="${origin}/__fixtures/slow-document.html?ms=20000"></iframe>`;
    const t0 = Date.now();
    await page.goto(
      `http://127.0.0.1:8787/__fixtures/policy-doc.html?body=${encodeURIComponent(frame)}`,
      { waitUntil: "load", timeout: 60_000 },
    );
    const elapsed = Date.now() - t0;
    expect(await page.title()).toBe("policy-doc");
    expect(elapsed).toBeLessThan(maxMs);
  },
);
