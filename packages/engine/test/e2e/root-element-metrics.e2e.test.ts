// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("documentElement reports viewport + scrolling-area metrics", async ({ page }) => {
  await page.setViewport({ width: 800, height: 600 });
  await setContent(
    page,
    `<style>body { margin: 0 } #tall { width: 100px; height: 3000px; background: #eee }</style>
     <div id="tall">tall</div>`,
    { waitUntil: "domcontentloaded" },
  );

  const m = await page.evaluate(() => {
    const de = document.documentElement;
    return {
      clientWidth: de.clientWidth,
      clientHeight: de.clientHeight,
      scrollWidth: de.scrollWidth,
      scrollHeight: de.scrollHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      identity: de === document.querySelector("html"),
    };
  });

  expect(m.clientWidth).toBe(m.innerWidth);
  expect(m.clientHeight).toBe(m.innerHeight);
  expect(m.scrollHeight).toBe(3000);
  expect(m.scrollWidth).toBe(m.innerWidth);
  expect(m.identity).toBe(true);

  await page.setViewport({ width: 1000, height: 700 });
  const after = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(after.clientWidth).toBe(1000);
  expect(after.clientHeight).toBe(700);
  expect(after.scrollHeight).toBe(3000);
}, 120_000);

test("excludes hidden fixed content from document scroll metrics", async ({ page }) => {
  await page.setViewport({ width: 800, height: 600 });
  await setContent(
    page,
    `<style>
       html, body { margin: 0 }
       #content { height: 1328px }
       #overlay { position: fixed; inset: 0; visibility: hidden; overflow: visible }
       #long { height: 2996px }
       #wide { position: fixed; left: 700px; width: 1600px; height: 1px; visibility: hidden }
     </style>
     <div id="content"></div>
     <div id="overlay"><div id="long"></div></div>
     <div id="wide"></div>`,
    { waitUntil: "domcontentloaded" },
  );

  const metrics = await page.evaluate(() => {
    window.scrollTo(0, 99999);
    return {
      bodyScrollHeight: document.body.scrollHeight,
      documentScrollHeight: document.documentElement.scrollHeight,
      bodyScrollWidth: document.body.scrollWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      scrollY: window.scrollY,
    };
  });

  expect(metrics).toEqual({
    bodyScrollHeight: 1328,
    documentScrollHeight: 1328,
    bodyScrollWidth: 800,
    documentScrollWidth: 800,
    scrollY: 728,
  });
}, 120_000);

test("excludes a fixed body from document scroll metrics", async ({ page }) => {
  await page.setViewport({ width: 800, height: 600 });
  await setContent(
    page,
    `<style>
       html, body { margin: 0 }
       body { position: fixed; inset: 0 }
       #long { height: 3000px }
     </style>
     <div id="long"></div>`,
    { waitUntil: "domcontentloaded" },
  );

  const metrics = await page.evaluate(() => {
    window.scrollTo(0, 9999);
    return {
      scrollHeight: document.documentElement.scrollHeight,
      scrollY: window.scrollY,
    };
  });

  expect(metrics).toEqual({ scrollHeight: 600, scrollY: 0 });
}, 120_000);

test("includes root-hoisted absolute content in document scroll metrics", async ({ page }) => {
  await page.setViewport({ width: 800, height: 600 });

  for (const { top, height, scrollHeight, scrollY } of [
    { top: 0, height: 3000, scrollHeight: 3000, scrollY: 2000 },
    { top: 2000, height: 500, scrollHeight: 2500, scrollY: 1900 },
  ]) {
    await setContent(
      page,
      `<style>body { margin: 0 }</style>
       <div style="position: absolute; top: ${top}px; left: 0; width: 100px; height: ${height}px"></div>`,
      { waitUntil: "domcontentloaded" },
    );

    const metrics = await page.evaluate(() => {
      window.scrollTo(0, 2000);
      return {
        scrollHeight: document.documentElement.scrollHeight,
        scrollY: window.scrollY,
      };
    });
    expect(metrics).toEqual({ scrollHeight, scrollY });
  }
}, 120_000);

test("includes direct non-fixed children in document scroll metrics", async ({ page }) => {
  await page.setViewport({ width: 800, height: 600 });
  await setContent(page, `<style>html, body { margin: 0 }</style>`, {
    waitUntil: "domcontentloaded",
  });

  const metrics = await page.evaluate(() => {
    const direct = document.createElement("div");
    direct.style.cssText = "width: 1100px; height: 2500px";
    document.documentElement.appendChild(direct);
    return {
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
    };
  });

  expect(metrics).toEqual({ scrollWidth: 1100, scrollHeight: 2500 });
}, 120_000);

test("document scrollWidth counts the body's x-origin", async ({ page }) => {
  await page.setViewport({ width: 800, height: 600 });
  await setContent(
    page,
    `<style>
       html { margin: 0 }
       body { margin: 8px }
       #wide { width: 1000px; height: 10px }
     </style>
     <div id="wide"></div>`,
    { waitUntil: "domcontentloaded" },
  );

  const m = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  expect(m.scrollWidth).toBe(1008);
  expect(m.bodyScrollWidth).toBe(1000);
}, 120_000);

test("scroll metrics survive a non-layout child under html", async ({ page }) => {
  await page.setViewport({ width: 800, height: 600 });
  await setContent(
    page,
    `<!doctype html><html><head></head><body style="margin: 0">
       <div style="height: 2000px"></div>
     </body></html>`,
    { waitUntil: "domcontentloaded" },
  );

  const metrics = await page.evaluate(() => {
    document.documentElement.insertBefore(
      document.createComment("direct non-layout child"),
      document.body,
    );
    window.scrollTo(0, 9999);
    return {
      documentScrollTop: document.documentElement.scrollTop,
      scrollY: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
    };
  });

  expect(metrics.documentScrollTop).toBe(metrics.scrollY);
  expect(metrics.scrollY).toBe(1400);
  expect(metrics.scrollHeight).toBe(2000);
}, 120_000);
