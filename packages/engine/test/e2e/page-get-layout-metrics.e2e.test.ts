// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Page.getLayoutMetrics feeds Playwright's screenshot clip: it reads
// visualViewport.pageX/pageY/scale before every page.screenshot(), and an
// empty reply failed each one with "Cannot read properties of undefined
// (reading 'pageX')".
import type { CDPSession, Page } from "@cloudflare/puppeteer";
import type Protocol from "devtools-protocol";

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const VIEWPORT = { width: 600, height: 300 };

async function layoutMetrics(page: Page): Promise<Protocol.Page.GetLayoutMetricsResponse> {
  const session: CDPSession = await page.createCDPSession();
  try {
    return await session.send("Page.getLayoutMetrics");
  } finally {
    await session.detach();
  }
}

function numbersIn(value: unknown): unknown[] {
  if (value === null || typeof value !== "object") return [value];
  return Object.values(value).flatMap(numbersIn);
}

test("returns every field with the viewport size and scale 1", async ({ page }) => {
  await page.setViewport(VIEWPORT);
  await setContent(page, "<p>hello</p>");

  const m = await layoutMetrics(page);

  for (const key of [
    "layoutViewport",
    "visualViewport",
    "contentSize",
    "cssLayoutViewport",
    "cssVisualViewport",
    "cssContentSize",
  ] as const) {
    expect(m[key], key).toBeTypeOf("object");
  }
  for (const n of numbersIn(m)) {
    expect(Number.isFinite(n), String(n)).toBe(true);
  }
  expect(m.visualViewport.scale).toBe(1);
  expect(m.cssVisualViewport.scale).toBe(1);
  expect(m.cssVisualViewport).toMatchObject({
    offsetX: 0,
    offsetY: 0,
    pageX: 0,
    pageY: 0,
    clientWidth: VIEWPORT.width,
    clientHeight: VIEWPORT.height,
  });
  expect(m.cssLayoutViewport).toEqual({
    pageX: 0,
    pageY: 0,
    clientWidth: VIEWPORT.width,
    clientHeight: VIEWPORT.height,
  });
  // A short page still reports at least the viewport.
  expect(m.cssContentSize).toEqual({
    x: 0,
    y: 0,
    width: VIEWPORT.width,
    height: VIEWPORT.height,
  });
}, 120_000);

test("reports the document size of a page taller than the viewport", async ({ page }) => {
  await page.setViewport(VIEWPORT);
  await setContent(page, `<div style="height:3000px">tall</div>`);

  const m = await layoutMetrics(page);

  expect(m.cssContentSize.height).toBeGreaterThanOrEqual(3000);
  expect(m.cssContentSize.width).toBe(VIEWPORT.width);
  expect(m.contentSize).toEqual(m.cssContentSize);
  expect(m.layoutViewport).toEqual(m.cssLayoutViewport);
  expect(m.visualViewport).toEqual(m.cssVisualViewport);
}, 120_000);

test("reports the scroll offset in both viewports", async ({ page }) => {
  await page.setViewport(VIEWPORT);
  await setContent(page, `<div style="width:2000px;height:3000px">big</div>`);

  const scrolled = await page.evaluate(() => {
    window.scrollTo(150, 500);
    return [window.scrollX, window.scrollY];
  });
  expect(scrolled).toEqual([150, 500]);

  const m = await layoutMetrics(page);

  expect(m.cssContentSize.width).toBeGreaterThanOrEqual(2000);
  expect(m.cssVisualViewport).toMatchObject({ pageX: 150, pageY: 500 });
  expect(m.cssLayoutViewport).toMatchObject({ pageX: 150, pageY: 500 });
  expect(m.visualViewport).toMatchObject({ pageX: 150, pageY: 500 });
  expect(m.layoutViewport).toMatchObject({ pageX: 150, pageY: 500 });
}, 120_000);

test("a never-navigated page reports its viewport", async ({ browser }) => {
  const page = await browser.newPage();
  try {
    await page.setViewport(VIEWPORT);

    const m = await layoutMetrics(page);

    expect(m.cssVisualViewport).toEqual({
      offsetX: 0,
      offsetY: 0,
      pageX: 0,
      pageY: 0,
      clientWidth: VIEWPORT.width,
      clientHeight: VIEWPORT.height,
      scale: 1,
      zoom: 1,
    });
    expect(m.cssContentSize).toEqual({
      x: 0,
      y: 0,
      width: VIEWPORT.width,
      height: VIEWPORT.height,
    });
  } finally {
    await page.close();
  }
}, 120_000);
