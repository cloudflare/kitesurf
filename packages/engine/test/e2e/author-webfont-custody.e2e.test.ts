// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";
import { bbox, decodePng } from "./png";
import { waitForTitle } from "./waits";

const FIXTURE = "https://ks.invalid/__fixtures/webfont.html";

async function waitTitle(page: Page, want: string): Promise<void> {
  const title = await waitForTitle(page, want, { timeout: 20000 });
  if (title !== want) throw new Error(`title never became ${want}`);
}

async function redInkIn(
  page: Page,
  y0: number,
  y1: number,
): Promise<{ w: number; h: number } | null> {
  await new Promise((r) => setTimeout(r, 400));
  const shot = new Uint8Array(await page.screenshot({ type: "png" }));
  const png = await decodePng(shot);
  const box = bbox(png, y0, y1, (r, g, b) => r > 150 && g < 100 && b < 100);
  return box ? { w: box.w, h: box.h } : null;
}

async function rectOf(page: Page, id: string): Promise<{ top: number; bottom: number }> {
  const raw: unknown = await page.evaluate(
    `(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
       return { top: r.top, bottom: r.bottom }; })()`,
  );
  const top: unknown = Reflect.get(raw as object, "top");
  const bottom: unknown = Reflect.get(raw as object, "bottom");
  if (typeof top !== "number" || typeof bottom !== "number") {
    throw new Error(`#${id} rect: bad reply`);
  }
  return { top: Math.floor(top), bottom: Math.ceil(bottom) };
}

test("author-font custody survives ack, relaunch and late canvas", async ({ page }) => {
  await page.setViewport({ width: 600, height: 400 });
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded", timeout: 30000 });
  await waitTitle(page, "FONTSETTLED");
  const wf = await rectOf(page, "wf");

  const first = await redInkIn(page, wf.top, wf.bottom);
  expect(first, "first paint has no webfont ink").not.toBeNull();
  if (!first) throw new Error("unreachable");
  expect(first.w).toBeGreaterThan(80);

  const second = await redInkIn(page, wf.top, wf.bottom);
  expect(second, "post-ack paint lost the webfont").toEqual(first);

  const session = await page.createCDPSession();
  await session.send("Kitesurf.disposeRenderer");
  const third = await redInkIn(page, wf.top, wf.bottom);
  expect(third, "post-relaunch paint lost the webfont").toEqual(first);

  await page.evaluate(() => {
    (window as typeof window & { __drawBrandCanvas(): void }).__drawBrandCanvas();
  });
  await waitTitle(page, "BRANDDRAWN");
  const brand = await rectOf(page, "brand");
  const canvasInk = await redInkIn(page, brand.top, brand.bottom);
  expect(canvasInk, "author-face canvas text has no ink").not.toBeNull();
  if (!canvasInk) throw new Error("unreachable");
  expect(canvasInk.w).toBeGreaterThan(80);
});
