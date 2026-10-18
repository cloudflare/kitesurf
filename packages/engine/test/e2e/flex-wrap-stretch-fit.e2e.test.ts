// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("a wrapping inline-flex fills the available space across its padding", async ({ page }) => {
  await setContent(
    page,
    `<style>
      html, body { margin: 0; }
      body { width: 300px; }
      .row { display: inline-flex; flex-wrap: wrap; padding: 0 20px; }
      .row > i { display: block; width: 100px; height: 20px; }
    </style>
    <span class="row"><i></i><i></i><i></i><i></i></span>`,
  );

  await expect(
    page.evaluate(() => {
      const rect = document.querySelector(".row")!.getBoundingClientRect();
      return [rect.width, rect.height];
    }),
  ).resolves.toEqual([300, 40]);
}, 120_000);

test("a wrapping inline-flex fills the available space across its border", async ({ page }) => {
  await setContent(
    page,
    `<style>
      html, body { margin: 0; }
      body { width: 300px; }
      .row {
        display: inline-flex;
        flex-wrap: wrap;
        box-sizing: border-box;
        padding: 0 20px;
        border: 10px solid;
      }
      .row > i { display: block; width: 100px; height: 20px; }
    </style>
    <span class="row"><i></i><i></i><i></i><i></i></span>`,
  );

  await expect(
    page.evaluate(() => {
      const rect = document.querySelector(".row")!.getBoundingClientRect();
      return [rect.width, rect.height];
    }),
  ).resolves.toEqual([300, 60]);
}, 120_000);
