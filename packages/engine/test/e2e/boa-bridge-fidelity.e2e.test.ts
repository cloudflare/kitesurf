// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import type { Page } from "@cloudflare/puppeteer";

async function settleResults(page: Page, url: string): Promise<string> {
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page
    .waitForFunction(() => document.getElementById("results")?.getAttribute("data-done") === "1", {
      timeout: 30_000,
    })
    .catch(() => {});
  const done = await page
    .evaluate(() => document.getElementById("results")?.getAttribute("data-done") ?? "0")
    .catch(() => "0");
  expect(done, "probe settled (data-done)").toBe("1");
  return page.evaluate(() => document.getElementById("results")?.textContent ?? "{}");
}

test("boa chunk-graph shapes all evaluate and bridge", async ({ page }) => {
  const out = JSON.parse(
    await settleResults(page, "http://127.0.0.1:8787/__fixtures/dynprobe-graph.html"),
  ) as Record<string, { ok: boolean; err?: string }>;
  for (const [name, r] of Object.entries(out)) {
    expect(r.ok, `${name} (err=${r.err ?? "none"})`).toBe(true);
  }
  expect(Object.keys(out).length).toBeGreaterThanOrEqual(21);
});

test("boa-bridged functions receive every call-site argument", async ({ page }) => {
  const out = JSON.parse(
    await settleResults(page, "http://127.0.0.1:8787/__fixtures/dynprobe-arity.html"),
  ) as { direct?: string; viaThis?: string; err?: string };
  expect(out.direct, `direct call (err=${out.err ?? "none"})`).toBe("5:x");
  expect(out.viaThis, "receiver-bound method call").toBe("5:y");
});
