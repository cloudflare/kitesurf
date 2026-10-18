// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

test("ratio-only SVG fills its containing block, sized cases don't", async ({ page }) => {
  await page.setViewport({ width: 900, height: 600 });
  await page.goto("https://ks.invalid/__fixtures/svg-sizing.html", {
    waitUntil: "domcontentloaded",
  });

  const sizes = await page.evaluate(() => {
    const box = (id: string) => {
      const r = document.getElementById(id)!.getBoundingClientRect();
      return [Math.round(r.width), Math.round(r.height)];
    };
    return {
      block: box("s-block"),
      inline: box("s-inline"),
      img: box("s-img"),
      css: box("s-css"),
      attr: box("s-attr"),
      noratio: box("s-noratio"),
    };
  });

  expect(sizes).toEqual({
    block: [600, 300],
    inline: [600, 300],
    img: [600, 300],
    css: [120, 60],
    attr: [80, 40],
    noratio: [300, 150],
  });
}, 120_000);
