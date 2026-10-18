// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("start-side overflow does not widen the scrollable area", async ({ page }) => {
  await page.setViewport({ width: 1000, height: 700 });
  await setContent(
    page,
    `<style>
       body { margin: 0; }
       #col { width: 400px; margin: 0 auto; }
       #bleed { width: 1000px; margin-left: -300px; height: 40px; background: #cde; }
       #tall { height: 1400px; }
     </style>
     <div id="col"><div id="bleed"></div><div id="tall"></div></div>`,
    { waitUntil: "domcontentloaded" },
  );

  await page.evaluate(() => window.scrollTo(99999, 0));

  expect(
    await page.evaluate(() => {
      const col = document.getElementById("col")!;
      const bleed = document.getElementById("bleed")!.getBoundingClientRect();
      return {
        bleed: [Math.round(bleed.x), Math.round(bleed.right)],
        colScrollWidth: col.scrollWidth,
        colClientWidth: col.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        maxScrollX: window.scrollX,
      };
    }),
  ).toEqual({
    bleed: [0, 1000],
    colScrollWidth: 700,
    colClientWidth: 400,
    bodyScrollWidth: 1000,
    docScrollWidth: 1000,
    maxScrollX: 0,
  });
}, 120_000);
