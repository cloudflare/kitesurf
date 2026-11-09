// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const html = `<!doctype html>
<style>
  body { margin: 0 }
  table { margin: 20px; border: 1px solid; border-spacing: 2px }
  td { padding: 4px 8px; height: 24px }
</style>
<table id="inbox">
  <thead id="head"><tr id="h"><td>From</td><td>Subject</td><td>Date</td></tr></thead>
  <tbody id="body">
    <tr id="r1" onclick="clicked(this)"><td>Ada</td><td>Quarterly report</td><td>Sep 1</td></tr>
    <tr id="r2" onclick="clicked(this)"><td>Grace</td><td>Compiler notes</td><td>Sep 2</td></tr>
    <tr id="r3" onclick="clicked(this)"><td>Linus</td><td>Patch series</td><td>Sep 3</td></tr>
  </tbody>
</table>
<script>
  window.clicks = [];
  function clicked(row) { window.clicks.push(row.id); }
</script>`;

test("table rows and row groups report the union of their cells", async ({ page }) => {
  await page.setViewport({ width: 800, height: 600 });
  await setContent(page, html, { waitUntil: "load" });

  const { parts, bodySpansItsRows, bodyBelowHead } = await page.evaluate(() => {
    const table = document.getElementById("inbox")!;
    const tableRect = table.getBoundingClientRect();
    const edges = (r: DOMRect) => [r.left, r.top, r.right, r.bottom].map(Math.round);
    const rectOf = (id: string) => document.getElementById(id)!.getBoundingClientRect();
    const parts = ["h", "head", "r1", "r2", "r3", "body"].map((id) => {
      const el = document.getElementById(id)!;
      const cells = Array.from(el.querySelectorAll("td"), (td) => td.getBoundingClientRect());
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        id,
        edges: edges(r),
        cellUnion: [
          Math.min(...cells.map((c) => c.left)),
          Math.min(...cells.map((c) => c.top)),
          Math.max(...cells.map((c) => c.right)),
          Math.max(...cells.map((c) => c.bottom)),
        ].map(Math.round),
        hasArea: r.width > 0 && r.height > 0,
        clientRects: el.getClientRects().length,
        offsetSize: [el.offsetWidth, el.offsetHeight],
        size: [Math.round(r.width), Math.round(r.height)],
        offsetParentIsTable: el.offsetParent === table,
        offset: [el.offsetLeft, el.offsetTop],
        fromTablePadding: [
          Math.round(r.left - tableRect.left - table.clientLeft),
          Math.round(r.top - tableRect.top - table.clientTop),
        ],
        centreHitsInside: !!hit && hit !== el && el.contains(hit),
      };
    });
    const body = rectOf("body");
    return {
      parts,
      bodySpansItsRows:
        body.top === rectOf("r1").top &&
        body.bottom === rectOf("r3").bottom &&
        body.left === rectOf("r1").left &&
        body.right === rectOf("r3").right,
      bodyBelowHead: body.top > rectOf("head").bottom,
    };
  });

  for (const part of parts) {
    expect(part.hasArea, part.id).toBe(true);
    expect(part.edges, part.id).toEqual(part.cellUnion);
    expect(part.clientRects, part.id).toBe(1);
    expect(part.offsetSize, part.id).toEqual(part.size);
    expect(part.offsetParentIsTable, part.id).toBe(true);
    expect(part.offset, part.id).toEqual(part.fromTablePadding);
    expect(part.centreHitsInside, part.id).toBe(true);
  }
  expect(bodySpansItsRows).toBe(true);
  expect(bodyBelowHead).toBe(true);
}, 120_000);

test("a trusted click at a table row's centre lands on that row", async ({ page }) => {
  await page.setViewport({ width: 800, height: 600 });
  await setContent(page, html, { waitUntil: "load" });

  // page.click aims at the centre of the row's content quad, which a zero-size row lacked, so
  // it threw; the raw click at the reported centre is how agents click a row.
  await page.click("#r2");
  const centre = await page.evaluate(() => {
    const r = document.getElementById("r3")!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(centre.x, centre.y);

  const clicks = await page.evaluate(() => (window as typeof window & { clicks: string[] }).clicks);
  expect(clicks).toEqual(["r2", "r3"]);
}, 120_000);
