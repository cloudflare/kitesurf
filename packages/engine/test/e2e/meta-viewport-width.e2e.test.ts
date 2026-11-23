// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A `<meta name="viewport" content="width=N">` widens the layout viewport to N
// when the device viewport is narrower, scaling height proportionally, while
// leaving `width=device-width` and wider desktop viewports unchanged.
// https://drafts.csswg.org/css-viewport/#viewport-meta
import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("meta[name=viewport] numeric width widens a narrow mobile viewport", async ({ page }) => {
  await page.setViewport({ width: 375, height: 812 });
  await setContent(
    page,
    '<!doctype html><html><head><meta name="viewport" content="width=1120"></head><body style="margin:0"><div style="width:1120px;height:40px"></div></body></html>',
    { waitUntil: "load" },
  );
  const mobile = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(mobile.innerWidth).toBe(1120);
  expect(mobile.clientWidth).toBe(1120);
  expect(mobile.scrollWidth).toBe(1120);
  expect(mobile.innerHeight).toBe(Math.round(812 * (1120 / 375)));

  // Desktop viewport wider than 1120 stays at its own width.
  await page.setViewport({ width: 1280, height: 720 });
  const desktop = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  }));
  expect(desktop).toEqual({ innerWidth: 1280, innerHeight: 720 });

  // width=device-width keeps the device viewport.
  await page.setViewport({ width: 375, height: 812 });
  await setContent(
    page,
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>',
    { waitUntil: "load" },
  );
  expect(await page.evaluate(() => window.innerWidth)).toBe(375);
});
