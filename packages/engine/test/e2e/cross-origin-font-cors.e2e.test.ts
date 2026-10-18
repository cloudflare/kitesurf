// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";
import { waitForTitle } from "./waits";

// CSS Fonts: cross-origin @font-face uses CORS mode.

const FIXTURE = "https://ks.invalid/__fixtures/cross-origin-font.html";

interface Widths {
  fallback: number;
  cors: number;
  nocors: number;
  fontsReady: boolean;
}

async function settleAndMeasure(page: Page): Promise<Widths> {
  const title = await waitForTitle(page, "FONTSETTLED", { timeout: 20_000 });
  if (title !== "FONTSETTLED") {
    throw new Error("fixture never settled");
  }
  const raw: unknown = await page.evaluate(`(() => {
    const w = (id) => document.getElementById(id).getBoundingClientRect().width;
    return {
      fallback: w("fallback"),
      cors: w("cors"),
      nocors: w("nocors"),
      fontsReady: !!document.getElementById("fontsready"),
    };
  })()`);
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`width probe returned ${typeof raw}`);
  }
  const num = (key: string): number => {
    const v: unknown = Reflect.get(raw, key);
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`${key}: expected a number, got ${String(v)}`);
    }
    return v;
  };
  return {
    fallback: num("fallback"),
    cors: num("cors"),
    nocors: num("nocors"),
    fontsReady: Reflect.get(raw, "fontsReady") === true,
  };
}

test("an ACAO-granted cross-origin face shapes; an ACAO-less one falls back", async ({ page }) => {
  await page.setViewport({ width: 600, height: 300 });
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded", timeout: 30000 });
  const m = await settleAndMeasure(page);

  expect(m.cors).toBeGreaterThan(m.fallback * 1.1);

  expect(m.nocors).toBe(m.fallback);

  expect(m.fontsReady, "fonts.ready never settled").toBe(true);
  expect(m.nocors).toBeGreaterThan(0);
});

test("the same verdicts hold on a pixel-free CDP session", async ({ browserFactory }) => {
  const browser = await browserFactory({
    headers: { "x-kitesurf-skip-raster": "1" },
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 600, height: 300 });
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded", timeout: 30000 });
  const m = await settleAndMeasure(page);
  expect(m.cors).toBeGreaterThan(m.fallback * 1.1);
  expect(m.nocors).toBe(m.fallback);
  expect(m.fontsReady, "fonts.ready never settled").toBe(true);
});
