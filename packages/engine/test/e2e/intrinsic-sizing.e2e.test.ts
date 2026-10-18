// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

// CSS Sizing 3 §5.2.1 cyclic percentages apply to replaced elements only.

test("a percentage-width block still contributes its content to a min-content width", async ({
  page,
}) => {
  await setContent(
    page,
    `<style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .row { display: flex; width: min-content; }
      .fill { width: 100%; }
      .fixed { width: 120px; height: 10px; }
    </style>
    <div class="row"><div><div class="fill"><div class="fixed"></div></div></div></div>`,
  );

  await expect(
    page.evaluate(() => document.querySelector(".row")!.getBoundingClientRect().width),
  ).resolves.toBe(120);
}, 120_000);

test("min-width on a text block reaches a shrink-to-fit inline-block", async ({ page }) => {
  await setContent(
    page,
    `<style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .shrink { display: inline-block; }
      .wide { min-width: 200px; }
    </style>
    <div class="shrink"><div class="wide">x</div></div>`,
  );

  await expect(
    page.evaluate(() => document.querySelector(".shrink")!.getBoundingClientRect().width),
  ).resolves.toBe(200);
}, 120_000);

test("max-width on a text block bounds an absolutely positioned parent", async ({ page }) => {
  await setContent(
    page,
    `<style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { width: 800px; }
      .abs { position: absolute; top: 0; left: 0; }
      .narrow { max-width: 200px; }
    </style>
    <div class="abs"><div class="narrow">antidisestablishmentarianism floccinaucinihilipilification</div></div>`,
  );

  await expect(
    page.evaluate(() => document.querySelector(".abs")!.getBoundingClientRect().width),
  ).resolves.toBe(200);
}, 120_000);

test("an atomic inline sizes itself from its own width keyword", async ({ page }) => {
  await setContent(
    page,
    `<style>
      html, body { margin: 0; }
      body { width: 300px; }
      div { margin-bottom: 4px; }
      span { display: inline-flex; flex-wrap: wrap; padding: 0 20px; }
      i { display: block; width: 100px; height: 20px; }
      #min { width: min-content; }
      #max { width: max-content; }
      #fill { width: stretch; }
    </style>
    <div><span id="min"><i></i><i></i><i></i><i></i></span></div>
    <div><span id="max"><i></i><i></i><i></i><i></i></span></div>
    <div><span id="fill"><i></i><i></i><i></i><i></i></span></div>
    <div><span id="auto"><i></i><i></i><i></i><i></i></span></div>`,
  );

  await expect(
    page.evaluate(() => {
      const size = (id: string) => {
        const rect = document.getElementById(id)!.getBoundingClientRect();
        return [rect.width, rect.height];
      };
      return {
        min: size("min"),
        max: size("max"),
        fill: size("fill"),
        auto: size("auto"),
      };
    }),
  ).resolves.toEqual({
    min: [140, 80],
    max: [440, 20],
    fill: [300, 40],
    auto: [300, 40],
  });
}, 120_000);
