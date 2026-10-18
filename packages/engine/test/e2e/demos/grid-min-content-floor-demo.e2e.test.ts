// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { setContent } from "../set-content";

const ROW = `<article><section><div style="height:69px"></div><figure></figure></section></article>`;

test("grid-min-content-floor-demo", async ({ page }) => {
  await setContent(
    page,
    `<style>
       html, body { height: 100%; margin: 0; }
       article { display: flex; gap: 24px; padding: 24px; overflow: hidden; grid-column: span 6; }
       section { display: flex; flex: 1 1 0%; flex-direction: column; gap: 24px; }
       figure { min-height: 230px; margin: 0; }
     </style>
     <div style="height:100%;display:flex;flex-direction:column">
       <header style="height:97px;flex-shrink:0"></header>
       <main id="m" style="flex:1 1 0%;display:flex;flex-direction:column">
         <div style="height:70px"></div>
         <div id="g" style="display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:24px;width:100%">
           ${ROW.repeat(3)}
         </div>
       </main>
     </div>`,
  );

  const probe = await page.evaluate(() => {
    const r = (sel) => {
      const e = document.querySelector(sel);
      return e ? Math.round(e.getBoundingClientRect().height) : null;
    };
    return {
      main: r("#m"),
      grid: r("#g"),
      firstArticle: r("article"),
      figure: r("figure"),
    };
  });

  expect(probe.figure, "figure floors at its min-height").toBe(230);
  expect(probe.firstArticle, "grid row content-sizes the overflow:hidden article").toBe(371);
  expect(probe.grid, "grid height is the sum of content rows").toBe(1161);
  expect(
    probe.main,
    "flex item floors at its content-based automatic minimum (not the viewport remainder)",
  ).toBe(1231);
});
