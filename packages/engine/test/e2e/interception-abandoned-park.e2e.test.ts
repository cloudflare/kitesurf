// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const FIXTURE = "https://ks.invalid/__fixtures/lifecycle.html";

interface PptrRequest {
  url(): string;
  continue(): Promise<void>;
}

test("pages closed with a paused request keep the session usable", async ({ browser }) => {
  for (let i = 0; i < 3; i++) {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    let abandoned = false;
    page.on("request", (req: PptrRequest) => {
      if (req.url().endsWith("/abandoned.json")) abandoned = true;
      else void req.continue();
    });
    await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
    await page.evaluate(`fetch("/abandoned.json").catch(() => {}); null`);
    await expect.poll(() => abandoned, { timeout: 10_000 }).toBe(true);
    await page.close();
  }

  const page = await browser.newPage();
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  expect(await page.evaluate("1+1")).toBe(2);
}, 120_000);

test("closing an intercepting page ends its interception", async ({ browser }) => {
  // Open the other page first: Puppeteer's page setup sends Fetch.disable.
  const page = await browser.newPage();
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  // Some clients close the page without sending Fetch.disable first.
  const intercepting = await browser.newPage();
  const session = await intercepting.createCDPSession();
  await session.send("Fetch.enable", { patterns: [{ urlPattern: "*after-close*" }] });
  await intercepting.close();

  // A parked request waits the 5 s verdict timeout; an unintercepted one returns at once.
  const ms = await page.evaluate(
    `(async () => { const t = performance.now(); await fetch("/__fixtures/lifecycle.html?after-close"); return performance.now() - t; })()`,
  );
  expect(ms).toBeLessThan(2_500);
}, 120_000);

test("a route handler that never answers continues instead of hanging", async ({ page }) => {
  await page.setRequestInterception(true);
  page.on("request", (_req: PptrRequest) => {});
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded", timeout: 60_000 });
  expect(await page.evaluate("1+1")).toBe(2);
}, 120_000);
