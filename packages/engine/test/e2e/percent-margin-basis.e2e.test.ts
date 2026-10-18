// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// CSS 2.2 §§8.3 and 10.1: percentage margins use the containing block content width.

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import html from "./html/percent-margin.html?raw";

test("percentage margins resolve against the containing block's content box", async ({ page }) => {
  await page.setViewport({ width: 1000, height: 800 });
  await setContent(page, html, { waitUntil: "domcontentloaded" });

  expect(
    await page.evaluate(() => {
      const cb = document.getElementById("cb")!;
      const contentLeft =
        cb.getBoundingClientRect().x + parseFloat(getComputedStyle(cb).paddingLeft);
      const rel = (id: string) => {
        const r = document.getElementById(id)!.getBoundingClientRect();
        return [Math.round(r.x - contentLeft), Math.round(r.width)];
      };
      const bleed = document.getElementById("bleed")!.getBoundingClientRect();
      return {
        ml: rel("ml"),
        mlc: rel("mlc"),
        mr: rel("mr"),
        bleed: [Math.round(bleed.x), Math.round(bleed.right)],
      };
    }),
  ).toEqual({
    ml: [350, 350],
    mlc: [250, 450],
    mr: [0, 350],
    bleed: [0, 1000],
  });
}, 120_000);
