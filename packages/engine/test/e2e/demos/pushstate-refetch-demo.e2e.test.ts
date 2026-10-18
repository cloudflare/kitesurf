// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

const LIFECYCLE_PATH = "/__fixtures/lifecycle.html";

test("pushState opt-in refetches path changes", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/echo-headers.html?ks_refetch_on_pushstate=1", {
    waitUntil: "load",
    timeout: 15_000,
  });
  const titleBeforeRefetch = await page.title();
  const refetch = page.waitForNavigation({ waitUntil: "load", timeout: 15_000 }).catch(() => null);
  await page
    .evaluate(() => setTimeout(() => history.pushState({}, "", "/__fixtures/lifecycle.html"), 0))
    .catch(() => undefined);
  await refetch;

  const urlAfterRefetch = page.url();
  const titleAfterRefetch = await page.title();
  expect(urlAfterRefetch.endsWith(LIFECYCLE_PATH), "opt-in: URL reflects pushState target").toBe(
    true,
  );
  expect(
    titleAfterRefetch !== titleBeforeRefetch,
    "opt-in: document body changed (title differs)",
  ).toBe(true);

  await page.goto("https://ks.invalid/__fixtures/echo-headers.html", {
    waitUntil: "load",
    timeout: 15_000,
  });
  const titleBeforeSameDocumentPush = await page.title();
  const sameDocumentNavigation = page.waitForNavigation({ timeout: 15_000 }).catch(() => null);
  await page.evaluate(() => history.pushState({}, "", "/__fixtures/lifecycle.html"));
  await sameDocumentNavigation;

  const urlAfterSameDocumentPush = page.url();
  const titleAfterSameDocumentPush = await page.title();
  expect(
    urlAfterSameDocumentPush.endsWith(LIFECYCLE_PATH),
    "no-opt-in: URL still reflects pushState target",
  ).toBe(true);
  expect(
    titleAfterSameDocumentPush === titleBeforeSameDocumentPush,
    "no-opt-in: document body is unchanged",
  ).toBe(true);
});

test("hash-only pushState keeps the document under the refetch opt-in", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/echo-headers.html?ks_refetch_on_pushstate=1", {
    waitUntil: "load",
    timeout: 15_000,
  });
  await page.evaluate(() => {
    (window as any).__survivesPush = true;
  });
  await page.evaluate(() => setTimeout(() => history.pushState({}, "", "#newfragment"), 0));
  await expect
    .poll(() => page.evaluate(() => location.hash), { timeout: 5_000 })
    .toBe("#newfragment");

  const survived = await page.evaluate(() => (window as any).__survivesPush === true);
  expect(survived, "opt-in + hash-only: the page keeps its JavaScript state").toBe(true);
});
