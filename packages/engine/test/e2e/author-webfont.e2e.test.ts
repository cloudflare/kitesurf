// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";
import { bbox, decodePng } from "./png";
import { waitForTitle } from "./waits";

const FIXTURE = "https://ks.invalid/__fixtures/webfont.html";

interface WebfontWidths {
  fallback: number;
  wf: number;
  wfdata: number;
  wfpct: number;
  wfTop: number;
  wfBottom: number;
  wfpctTop: number;
  wfpctBottom: number;
}

async function settleAndMeasure(page: Page): Promise<WebfontWidths> {
  const title = await waitForTitle(page, "FONTSETTLED", { timeout: 20000 });
  if (title !== "FONTSETTLED") {
    throw new Error("fixture never settled");
  }
  const raw: unknown = await page.evaluate(`(() => {
    const r = (id) => document.getElementById(id).getBoundingClientRect();
    const wf = r("wf");
    const wfpct = r("wfpct");
    return {
      fallback: r("fallback").width,
      wf: wf.width,
      wfdata: r("wfdata").width,
      wfpct: wfpct.width,
      wfTop: wf.top,
      wfBottom: wf.bottom,
      wfpctTop: wfpct.top,
      wfpctBottom: wfpct.bottom,
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
    wf: num("wf"),
    wfdata: num("wfdata"),
    wfpct: num("wfpct"),
    wfTop: num("wfTop"),
    wfBottom: num("wfBottom"),
    wfpctTop: num("wfpctTop"),
    wfpctBottom: num("wfpctBottom"),
  };
}

test("author webfonts shape and paint on a paint session", async ({ page }) => {
  await page.setViewport({ width: 600, height: 300 });
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded", timeout: 30000 });
  const m = await settleAndMeasure(page);

  expect(m.wf).toBeGreaterThan(m.fallback * 1.1);
  expect(m.wfdata).toBe(m.wf);
  expect(m.wfpct).toBe(m.wf);

  await new Promise((r) => setTimeout(r, 300));
  const shot = new Uint8Array(await page.screenshot({ type: "png" }));
  const png = await decodePng(shot);

  const red = bbox(
    png,
    Math.floor(m.wfTop),
    Math.ceil(m.wfBottom),
    (r, g, b) => r > 150 && g < 100 && b < 100,
  );
  expect(red, "no red webfont ink found").not.toBeNull();
  if (!red) throw new Error("unreachable");
  expect(red.w).toBeGreaterThan(80);

  const green = bbox(
    png,
    Math.floor(m.wfpctTop),
    Math.ceil(m.wfpctBottom),
    (r, g, b) => g > 120 && r < 100 && b < 100,
  );
  expect(green, "no green percent-data webfont ink found").not.toBeNull();
  if (!green) throw new Error("unreachable");
  expect(green.w).toBeGreaterThan(80);
});

test("author webfonts shape identically on a pixel-free CDP session", async ({
  browserFactory,
}) => {
  const browser = await browserFactory({
    headers: { "x-kitesurf-skip-raster": "1" },
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 600, height: 300 });
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded", timeout: 30000 });
  const m = await settleAndMeasure(page);
  expect(m.wf).toBeGreaterThan(m.fallback * 1.1);
  expect(m.wfdata).toBe(m.wf);
  expect(m.wfpct).toBe(m.wf);
});
