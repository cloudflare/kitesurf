// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import html from "./html/table-fixup.html?raw";

test("misparented table boxes get anonymous wrappers", async ({ page }) => {
  await page.setViewport({ width: 500, height: 400 });
  await setContent(page, html, { waitUntil: "domcontentloaded" });

  expect(
    await page.evaluate(() => {
      const r = (id: string) => {
        const b = document.getElementById(id)!.getBoundingClientRect();
        return {
          x: Math.round(b.x),
          y: Math.round(b.y),
          w: Math.round(b.width),
          h: Math.round(b.height),
        };
      };
      const a = r("a"),
        b = r("b"),
        c = r("c");
      const inner = r("inner"),
        centered = r("centered");
      const s1 = r("stray1"),
        s2 = r("stray2"),
        r1c1 = r("r1c1");
      return {
        cellsOneLine: a.y === b.y && b.y === c.y,
        cellsAdvance: a.x < b.x && b.x < c.x,
        innerVisible: inner.w === 120 && inner.h === 40,
        centeredX: centered.x,
        strayOneLine: s1.y === s2.y && s1.x < s2.x,
        realRowBelow: r1c1.y > s1.y,
      };
    }),
  ).toEqual({
    cellsOneLine: true,
    cellsAdvance: true,
    innerVisible: true,
    centeredX: 190,
    strayOneLine: true,
    realRowBelow: true,
  });
}, 120_000);
