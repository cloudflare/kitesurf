// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("flex figures shrink below viewBox-only SVG content", async ({ page }) => {
  await setContent(
    page,
    `<style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .outer { width: 160px; height: 220px; display: flex; justify-content: center; }
      figure { flex: 1 1 50%; max-width: 200px; height: 200px; position: relative; }
      .legend { display: flex; flex: 1 1 0%; justify-content: center; height: 200px; }
      .chart { flex: 1 1 0%; min-width: 0; position: relative; }
      svg { width: 100%; height: 104px; display: block; }
    </style>
    <div class="outer">
      <figure><div class="legend"><div class="chart"><svg viewBox="0 0 165 104"></svg></div></div></figure>
      <figure><div class="legend"><div class="chart"><svg viewBox="0 0 155 104"></svg></div></div></figure>
    </div>`,
  );

  await expect(
    page.evaluate(() =>
      [...document.querySelectorAll("figure")].map((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, width: rect.width };
      }),
    ),
  ).resolves.toEqual([
    { x: 0, width: 80 },
    { x: 80, width: 80 },
  ]);
}, 120_000);

test("ratio wrappers do not inflate flex legends", async ({ page }) => {
  await setContent(
    page,
    `<style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .outer { width: 160px; height: 220px; display: flex; justify-content: center; }
      figure { flex: 1 1 50%; max-width: 200px; height: 200px; position: relative; }
      .legend { display: flex; flex-direction: column; flex-wrap: wrap; gap: 8px 16px; flex: 1 1 0%; justify-content: space-between; height: 200px; }
      .item { display: flex; flex-direction: column; flex: 0 1 auto; }
      .label { display: flex; }
      .marker { width: 10.5px; height: 10.5px; }
      .chart { flex: 1 1 0%; position: relative; overflow: hidden; }
      .abs { position: absolute; }
      .auto { width: 100%; height: 100%; min-width: 0; aspect-ratio: 165 / 102; overflow: hidden; }
      .auto > div { width: 165px; height: 102px; overflow: hidden; }
      svg { display: block; }
    </style>
    <div class="outer">
      <figure><div class="legend"><div class="item"><div class="label"><span class="marker"></span>Requests</div><div class="value">100</div></div><div class="chart"><div class="abs"><div class="auto"><div><svg viewBox="0 0 165 102"></svg></div></div></div></div><div class="item"><div class="label"><span class="marker"></span>Responses</div><div class="value">100</div></div></div></figure>
      <figure><div class="legend"><div class="item"><div class="label"><span class="marker"></span>Requests</div><div class="value">100</div></div><div class="chart"><div class="abs"><div class="auto"><div><svg viewBox="0 0 155 102"></svg></div></div></div></div><div class="item"><div class="label"><span class="marker"></span>Responses</div><div class="value">100</div></div></div></figure>
    </div>`,
  );

  const figures = await page.evaluate(() =>
    [...document.querySelectorAll("figure")].map((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width };
    }),
  );
  expect(figures).toHaveLength(2);
  expect(figures.every(({ width }) => width > 60 && width < 100)).toBe(true);
}, 120_000);

test("nested centered flex rows keep ratio chart legends bounded", async ({ page }) => {
  await setContent(
    page,
    `<style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .section { width: 160px; height: 229px; display: flex; gap: 16px; }
      hr { width: 1px; height: 100%; }
      .row { width: 100%; display: flex; justify-content: center; }
      figure { flex: 1 1 50%; max-width: 200px; height: 200px; position: relative; }
      .legend { display: flex; flex-direction: column; flex-wrap: wrap; gap: 8px 16px; flex: 1 1 0%; justify-content: space-between; min-height: 100%; }
      .item { display: flex; flex-direction: column; flex: 0 1 auto; }
      .label { display: flex; align-items: center; font-size: 14px; }
      .marker { display: block; width: 10.5px; height: 10.5px; min-height: 10.5px; margin-right: 6px; }
      .value { font-size: 20px; }
      .chart { flex: 1 1 0%; position: relative; overflow: hidden; }
      .abs { position: absolute; }
      .auto { width: 100%; height: 100%; min-width: 0; aspect-ratio: 165 / 102; overflow: hidden; }
      .auto > div { width: 165px; height: 102px; overflow: hidden; }
      svg { max-width: 100%; }
    </style>
    <div class="section"><hr><div class="row">
      <figure><div class="legend"><div class="item"><div class="label"><span class="marker"></span>Requests</div><div class="value">100</div></div><div class="chart"><div class="abs"><div class="auto"><div><svg viewBox="0 0 165 102"></svg></div></div></div></div><div class="item"><div class="label"><span class="marker"></span>Responses</div><div class="value">100</div></div></div></figure>
      <figure><div class="legend"><div class="item"><div class="label"><span class="marker"></span>Requests</div><div class="value">100</div></div><div class="chart"><div class="abs"><div class="auto"><div><svg viewBox="0 0 155 102"></svg></div></div></div></div><div class="item"><div class="label"><span class="marker"></span>Responses</div><div class="value">100</div></div></div></figure>
    </div></div>`,
  );

  const figures = await page.evaluate(() =>
    [...document.querySelectorAll("figure")].map((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width };
    }),
  );
  expect(figures).toHaveLength(2);
  expect(figures.every(({ width }) => width > 60 && width < 100)).toBe(true);
}, 120_000);
