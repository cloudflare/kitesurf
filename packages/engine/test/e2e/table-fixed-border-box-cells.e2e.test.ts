// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

// A mail-list row: narrow border-box cells whose padding is wider than their width, so each
// column must grow to its cell's padding and border or the next cell overlaps the control.
const HTML = `<!doctype html>
<style>
  * { box-sizing: border-box }
  body { margin: 8px }
  table { table-layout: fixed; width: 600px; border-spacing: 0 }
  td { padding: 0; height: 40px }
  .a { padding: 0 10px 0 13px; width: 20px }
  .b { padding: 8px 16px; width: 20px }
  .wide { padding: 8px 16px }
  i { display: block; width: 20px; height: 20px }
  #bordered { width: 200px }
  #bordered td { height: 20px }
</style>
<table>
  <tr id="row">
    <td id="c0" width="4px"></td>
    <td id="c1" class="a"><i id="checkbox"></i></td>
    <td id="c2" class="b"><i id="star"></i></td>
    <td id="c3" class="wide" style="width: 16%">Support</td>
    <td id="c4" class="wide" style="width: 69%">Subject</td>
    <td id="c5" class="wide" style="width: 8%">Sep 2</td>
  </tr>
</table>
<table id="bordered">
  <tr>
    <td id="b0" style="width: 10px; padding: 0 5px; border: 4px solid black"></td>
    <td id="b1"></td>
  </tr>
</table>
<script>
  window.clicks = [];
  document.addEventListener("click", (event) => clicks.push(event.target.id));
</script>`;

test("fixed-layout columns floor border-box cells at their padding and border", async ({
  page,
}) => {
  await page.setViewport({ width: 800, height: 300 });
  await setContent(page, HTML, { waitUntil: "domcontentloaded" });

  const { layout, centre } = await page.evaluate(() => {
    const box = (id: string) => {
      const element = document.getElementById(id);
      if (!element) throw new Error(`missing test element: ${id}`);
      return element.getBoundingClientRect();
    };
    const span = (id: string): [number, number] => {
      const { x, width } = box(id);
      return [Math.round(x), Math.round(width)];
    };
    const row = ["c0", "c1", "c2", "c3", "c4", "c5"].map(span);
    const ends = row.map(([x, width]) => x + width);
    const star = box("star");
    const centre = { x: star.x + star.width / 2, y: star.y + star.height / 2 };
    return {
      layout: {
        narrow: row.slice(0, 3),
        gaps: row.slice(1).map(([x], i) => x - (ends[i] ?? Number.NaN)),
        bordered: [span("b0"), span("b1")],
        hit: document.elementFromPoint(centre.x, centre.y)?.id,
      },
      centre,
    };
  });

  expect(layout).toEqual({
    narrow: [
      [8, 4],
      [12, 23],
      [35, 32],
    ],
    gaps: [0, 0, 0, 0, 0],
    bordered: [
      [8, 18],
      [26, 182],
    ],
    hit: "star",
  });

  await page.mouse.click(centre.x, centre.y);
  expect(await page.evaluate(() => Reflect.get(window, "clicks"))).toEqual(["star"]);
}, 120_000);
