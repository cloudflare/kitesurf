// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import html from "./html/grid-auto-row.html?raw";

test("auto grid rows content-size when the grid has fr columns", async ({ page }) => {
  await page.setViewport({ width: 800, height: 600 });
  await setContent(page, html, { waitUntil: "domcontentloaded" });

  expect(
    await page.evaluate(() => {
      const read = (prefix: string) => {
        const grid = document.getElementById(prefix)!.getBoundingClientRect();
        const main = document.getElementById(`${prefix}-main`)!.getBoundingClientRect();
        const foot = document.getElementById(`${prefix}-foot`)!.getBoundingClientRect();
        return {
          mainHeight: Math.round(main.height),
          footTop: Math.round(foot.top - grid.top),
        };
      };
      return { fr: read("fr"), fixed: read("fixed") };
    }),
  ).toEqual({
    fr: { mainHeight: 3000, footTop: 3072 },
    fixed: { mainHeight: 3000, footTop: 3072 },
  });
}, 120_000);
