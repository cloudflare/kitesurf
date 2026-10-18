// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const HTML = `<!doctype html>
<style>
  body { margin: 0; font: 16px/26px Arial, sans-serif }
  main { width: 1200px }
  figure {
    display: table;
    float: right;
    clear: right;
    border-collapse: collapse;
    line-height: 0;
    margin: .5em 0 1.3em 1.4em;
    text-align: center;
  }
  figure > a { display: block; position: relative }
  .image {
    width: 250px;
    height: 167px;
    margin: 3px;
    border: 1px solid #c8ccd1;
  }
  figcaption {
    display: table-caption;
    caption-side: bottom;
    box-sizing: border-box;
    padding: 0 6px 6px;
    border: 1px solid #c8ccd1;
    border-top: 0;
    font-size: 88.4%;
    line-height: 1.4em;
    text-align: start;
    word-break: break-word;
  }
  table.check { border-collapse: collapse; margin-top: 10px }
  table.check caption, table.check td { padding: 0; border: 0 }
  table.check td { height: 20px }
  #multi { clear: both }
  #multi .one { width: 100px }
  #multi .two { width: 150px }
  #capmin td, #capmin-after td { width: 40px }
  #capmin caption span, #capmin-after caption span { display: block; width: 180px; height: 1px }
  #separate { border-collapse: separate; border-spacing: 10px 0 }
  #separate .one { width: 100px }
  #separate .two { width: 150px }
  #separate-margins { border-collapse: separate; border-spacing: 10px 0 }
  #separate-margins .one { width: 100px }
  #separate-margins .two { width: 150px }
  #separate-margins caption { margin-inline: 17px 13px }
  #fixed-caption-first { table-layout: fixed; width: 250px }
  #fixed-caption-first .one { width: 100px }
  #fixed-caption-first .two { width: 150px }
</style>
<main>
  <figure>
    <a><div class="image"></div></a>
    <figcaption>King Afonso Henriques reconquered the city from the Almoravid Empire at the 1147 siege of Lisbon.</figcaption>
  </figure>
  <p>On 6 August 711, Lisbon was taken by the Muslim forces of the Umayyad Caliphate. These conquerors built many mosques and houses.</p>
</main>
<table class="check" id="multi">
  <tr><td class="one" rowspan="2"></td></tr>
  <tr><td class="two"></td></tr>
  <caption>caption</caption>
</table>
<table class="check" id="capmin">
  <caption><span></span></caption>
  <tr><td></td></tr>
</table>
<table class="check" id="capmin-after">
  <tr><td></td></tr>
  <caption><span></span></caption>
</table>
<table class="check" id="separate">
  <tr><td class="one"></td><td class="two"></td></tr>
  <caption>caption</caption>
</table>
<table class="check" id="separate-margins">
  <caption>caption</caption>
  <tr><td class="one"></td><td class="two"></td></tr>
</table>
<table class="check" id="fixed-caption-first">
  <caption>caption</caption>
  <tr><td class="one"></td><td class="two"></td></tr>
</table>`;

test("a floated table sizes its caption like Chrome", async ({ page }) => {
  await page.setViewport({ width: 1200, height: 600 });
  await setContent(page, HTML, { waitUntil: "domcontentloaded" });

  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`missing test element: ${selector}`);
      const { x, width, height } = element.getBoundingClientRect();
      return { x: Math.round(x), width: Math.round(width), height: Math.round(height) };
    };
    const inlineRect = (selector: string) => {
      const { x, width } = rect(selector);
      return { x, width };
    };
    return {
      figure: rect("figure"),
      image: rect(".image"),
      caption: rect("figcaption"),
      multiColumn: {
        table: rect("#multi").width,
        caption: rect("#multi caption").width,
        cells: [rect("#multi .one").width, rect("#multi .two").width],
      },
      captionMinimum: {
        table: rect("#capmin").width,
        caption: rect("#capmin caption").width,
        cell: rect("#capmin td").width,
      },
      captionMinimumAfterRow: {
        table: rect("#capmin-after").width,
        caption: rect("#capmin-after caption").width,
        cell: rect("#capmin-after td").width,
      },
      separateBorders: {
        table: rect("#separate").width,
        caption: rect("#separate caption").width,
        cells: [rect("#separate .one").width, rect("#separate .two").width],
      },
      separateBordersWithMargins: {
        table: inlineRect("#separate-margins"),
        caption: inlineRect("#separate-margins caption"),
        cells: [inlineRect("#separate-margins .one"), inlineRect("#separate-margins .two")],
      },
      fixedCaptionFirst: {
        table: rect("#fixed-caption-first").width,
        caption: rect("#fixed-caption-first caption").width,
        cells: [rect("#fixed-caption-first .one").width, rect("#fixed-caption-first .two").width],
      },
    };
  });

  expect(geometry).toEqual({
    figure: { x: 942, width: 258, height: 241 },
    image: { x: 945, width: 252, height: 169 },
    caption: { x: 942, width: 258, height: 66 },
    multiColumn: { table: 250, caption: 250, cells: [100, 150] },
    captionMinimum: { table: 180, caption: 180, cell: 180 },
    captionMinimumAfterRow: { table: 180, caption: 180, cell: 180 },
    separateBorders: { table: 280, caption: 280, cells: [100, 150] },
    separateBordersWithMargins: {
      table: { x: 0, width: 280 },
      caption: { x: 17, width: 250 },
      cells: [
        { x: 10, width: 100 },
        { x: 120, width: 150 },
      ],
    },
    fixedCaptionFirst: { table: 250, caption: 250, cells: [100, 150] },
  });
}, 120_000);
