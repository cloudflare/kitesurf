// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// CSS Grid 1 §10.1: auto grid lines anchor to the container padding edge.

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import html from "./html/grid-abspos.html?raw";

test("abspos grid children anchor auto lines to the padding edge", async ({ page }) => {
  await page.setViewport({ width: 400, height: 300 });
  await setContent(page, html, { waitUntil: "domcontentloaded" });

  expect(
    await page.evaluate(() => {
      const g = document.getElementById("g")!.getBoundingClientRect();
      const auto = document.getElementById("auto")!.getBoundingClientRect();
      const areaed = document.getElementById("areaed")!.getBoundingClientRect();
      return {
        auto: [Math.round(auto.x - g.x), Math.round(auto.y - g.y)],
        areaed: [Math.round(areaed.x - g.x), Math.round(areaed.y - g.y)],
      };
    }),
  ).toEqual({
    auto: [6, 11],
    areaed: [46, 51],
  });
}, 120_000);
