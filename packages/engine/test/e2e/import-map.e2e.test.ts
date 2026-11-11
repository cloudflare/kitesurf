// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

test("module scripts honor import maps", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/importmap.html", {
    waitUntil: "load",
  });

  await expect
    .poll(() => page.evaluate(() => (globalThis as { importMapResult?: unknown }).importMapResult))
    .toEqual({
      staticAnswer: 43,
      dynamicAnswer: 43,
      lazyAnswer: 44,
      url: "https://ks.invalid/__fixtures/__kitesurf_inline_2.js",
      resolved: "https://ks.invalid/__fixtures/peer.js",
      earlyAnswer: "early",
      lateAnswer: "early",
      earlyResolved: "https://ks.invalid/__fixtures/importmap-early.js",
    });
});

test("a CSP-refused import map installs nothing", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/importmap-csp.html", {
    waitUntil: "load",
  });

  const result = () =>
    page.evaluate(
      () =>
        (globalThis as { importMapResult?: { bare?: unknown; direct?: unknown } }).importMapResult,
    );
  await expect.poll(async () => (await result())?.direct).toEqual({ ok: "early" });
  expect((await result())?.bare).toEqual({
    error: expect.stringContaining("requires an import map"),
  });
});

test("an over-budget import map is ignored, not applied or fatal", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/importmap-over-budget.html", {
    waitUntil: "load",
  });

  const result = () =>
    page.evaluate(() => (globalThis as { importMapBudget?: unknown }).importMapBudget);
  // The dropped map would have mapped "pkg/a.js" to a url that never loads; the bare
  // specifier error proves no substitute ran and the document itself still loaded.
  await expect.poll(result).toEqual(expect.stringContaining("requires an import map"));
}, 120_000);
