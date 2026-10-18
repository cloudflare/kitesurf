// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

import { readRendererInfo } from "./cdp-read";

const PAGE_URL =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><title>renderer laziness</title>
<style>body{margin:0;font-family:sans-serif}h1{color:#204;font-size:24px}</style>
</head><body><h1 id="h">no pixels wanted</h1><p>plain content</p></body></html>`);

test("no renderer isolate for an html-content session", async ({ page, cdpSession }) => {
  await page.goto(PAGE_URL, { timeout: 25_000 });

  const outer = await cdpSession.send("DOM.getOuterHTML", { nodeId: 0 });
  const html: unknown = Reflect.get(Object(outer), "outerHTML");
  expect(typeof html, "DOM.getOuterHTML returned a string").toBe("string");
  expect(String(html)).toContain("no pixels wanted");

  const info = await readRendererInfo(cdpSession);
  expect(
    info.active,
    `no renderer manager after a pixel-free session; got ${JSON.stringify(info)}`,
  ).toBe(false);
  expect(info.framesRendered, "nothing rasterized").toBe(0);
});

test("Page.captureScreenshot spins the renderer up", async ({ page, cdpSession }) => {
  await page.goto(PAGE_URL, { timeout: 25_000 });
  expect((await readRendererInfo(cdpSession)).active, "lazy before").toBe(false);

  const shot = await page.screenshot({ type: "png" });
  expect(shot.length, "screenshot produced bytes").toBeGreaterThan(0);

  const info = await readRendererInfo(cdpSession);
  expect(info.active, "renderer active after captureScreenshot").toBe(true);
  expect(info.framesRendered, "the frame came from the renderer").toBe(1);
});

test("Page.printToPDF spins the renderer up", async ({ page, cdpSession }) => {
  await page.goto(PAGE_URL, { timeout: 25_000 });
  expect((await readRendererInfo(cdpSession)).active, "lazy before").toBe(false);

  const pdf = await cdpSession.send("Page.printToPDF", {});
  const data: unknown = Reflect.get(Object(pdf), "data");
  expect(typeof data, "printToPDF returned base64 data").toBe("string");
  expect(String(data).length, "PDF is non-empty").toBeGreaterThan(0);

  expect((await readRendererInfo(cdpSession)).active, "renderer active after printToPDF").toBe(
    true,
  );
});

test("Page.startScreencast spins the renderer up", async ({ page, cdpSession }) => {
  await page.goto(PAGE_URL, { timeout: 25_000 });
  expect((await readRendererInfo(cdpSession)).active, "lazy before").toBe(false);

  let frames = 0;
  cdpSession.on("Page.screencastFrame", (ev: { sessionId: number }) => {
    frames += 1;
    cdpSession.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
  });
  await cdpSession.send("Page.startScreencast", {
    format: "jpeg",
    quality: 60,
    everyNthFrame: 1,
  });
  try {
    await expect.poll(() => frames, { timeout: 15_000 }).toBeGreaterThan(0);
  } catch {}
  await cdpSession.send("Page.stopScreencast");
  expect(frames, "at least one screencast frame arrived").toBeGreaterThan(0);

  const info = await readRendererInfo(cdpSession);
  expect(info.active, "renderer active after startScreencast").toBe(true);
  expect(info.framesRendered, "screencast frames came from the renderer").toBeGreaterThanOrEqual(1);
});
