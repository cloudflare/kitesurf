// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A `<meta name="viewport" content="width=N">` widens the layout viewport to N
// only when mobile emulation is enabled (`mobile: true`), clamping to engine
// viewport caps while leaving desktop viewports and `width=device-width` intact.
// https://drafts.csswg.org/css-viewport/#viewport-meta
import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("meta[name=viewport] numeric width applies only on mobile and clamps to engine limits", async ({
  page,
}) => {
  await page.setViewport({ width: 375, height: 812, isMobile: true });
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

  // Oversized mobile meta widths clamp to the engine's side and pixel caps.
  await setContent(
    page,
    '<!doctype html><html><head><meta name="viewport" content="width=9999"></head><body></body></html>',
    { waitUntil: "load" },
  );
  const clamped = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  }));
  expect(clamped.innerWidth).toBeLessThanOrEqual(2560);
  expect(clamped.innerHeight).toBeLessThanOrEqual(2560);
  expect(clamped.innerWidth * clamped.innerHeight).toBeLessThanOrEqual(2560 * 1440);

  // Desktop viewport (isMobile: false) ignores meta viewport width even when narrower.
  await page.setViewport({ width: 800, height: 600, isMobile: false });
  await setContent(
    page,
    '<!doctype html><html><head><meta name="viewport" content="width=1024"></head><body></body></html>',
    { waitUntil: "load" },
  );
  const desktop = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  }));
  expect(desktop).toEqual({ innerWidth: 800, innerHeight: 600 });

  // width=device-width keeps the mobile device viewport.
  await page.setViewport({ width: 375, height: 812, isMobile: true });
  await setContent(
    page,
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>',
    { waitUntil: "load" },
  );
  expect(await page.evaluate(() => window.innerWidth)).toBe(375);
});
