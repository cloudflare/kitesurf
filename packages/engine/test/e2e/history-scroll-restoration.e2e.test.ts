// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Session history entries preserve scroll position and restore it on traversal
// when history.scrollRestoration is "auto", skipping restoration for "manual".
// https://html.spec.whatwg.org/multipage/nav-history-apis.html#dom-history-scrollrestoration
import { expect, test } from "./harness";

const PAGE_A = "https://ks.invalid/__fixtures/lifecycle.html";
const PAGE_TALL = "https://ks.invalid/__fixtures/sticky-root-overflow.html";
const PAGE_B = "https://ks.invalid/__fixtures/events.html";

test("same-document history.back honours history.scrollRestoration", async ({ page }) => {
  await page.goto(PAGE_A, { waitUntil: "load" });
  const result = await page.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.style.height = "3000px";
    document.body.appendChild(spacer);

    // Invalid enum values are ignored.
    (history as { scrollRestoration: string }).scrollRestoration = "bogus";
    const afterInvalid = history.scrollRestoration;

    window.scrollTo(0, 420);
    history.pushState({ step: 2 }, "", "#step2");
    window.scrollTo(0, 0);
    history.back();
    const restoredAuto = window.scrollY;

    history.forward();
    history.scrollRestoration = "manual";
    window.scrollTo(0, 300);
    history.pushState({ step: 3 }, "", "#step3");
    window.scrollTo(0, 50);
    history.back();
    const stayedManual = window.scrollY;

    return { afterInvalid, restoredAuto, stayedManual };
  });

  expect(result).toEqual({
    afterInvalid: "auto",
    restoredAuto: 420,
    stayedManual: 50,
  });
});

test("cross-document goBack restores the prior entry's scroll position", async ({ page }) => {
  await page.goto(PAGE_TALL, { waitUntil: "load" });
  await page.evaluate(() => window.scrollTo(0, 300));
  expect(await page.evaluate(() => window.scrollY)).toBe(300);

  await page.goto(PAGE_B, { waitUntil: "load" });
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await page.goBack({ waitUntil: "load" });
  expect(await page.evaluate(() => ({ url: location.href, y: window.scrollY }))).toEqual({
    url: PAGE_TALL,
    y: 300,
  });
});
