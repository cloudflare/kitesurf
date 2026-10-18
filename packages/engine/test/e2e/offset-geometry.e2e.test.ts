// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import pageHtml from "./html/offset-geometry.html?raw";

test("offsetParent/offsetTop/offsetLeft follow CSSOM-View", async ({ page }) => {
  await page.setViewport({ width: 800, height: 600 });
  await setContent(page, pageHtml, { waitUntil: "domcontentloaded" });

  expect(
    await page.evaluate(() => {
      const $ = (id: string) => document.getElementById(id)!;
      const parentId = (el: HTMLElement) =>
        el.offsetParent ? (el.offsetParent as HTMLElement).id || el.offsetParent.tagName : null;
      return {
        first: [parentId($("first")), $("first").offsetTop, $("first").offsetLeft],
        rel: [parentId($("rel")), $("rel").offsetTop, $("rel").offsetLeft],
        inner: [parentId($("inner")), $("inner").offsetTop, $("inner").offsetLeft],
        abs: [parentId($("abs")), $("abs").offsetTop, $("abs").offsetLeft],
        after: [parentId($("after")), $("after").offsetTop, $("after").offsetLeft],
        fixed: [parentId($("fixed")), $("fixed").offsetTop, $("fixed").offsetLeft],
        contents: [parentId($("contents")), $("contents").offsetTop, $("contents").offsetLeft],
        cell: parentId($("cell")),
        incell: parentId($("incell")),
        body: [document.body.offsetParent, document.body.offsetTop],
        html: [document.documentElement.offsetParent],
      };
    }),
  ).toEqual({
    first: ["BODY", 8, 8],
    rel: ["BODY", 70, 8],
    inner: ["rel", 16, 26],
    abs: ["rel", 25, 35],
    after: ["scroller", 200, 0],
    fixed: [null, 5, 7],
    contents: [null, 0, 0],
    cell: "TABLE",
    incell: "cell",
    body: [null, 0],
    html: [null],
  });

  expect(
    await page.evaluate(() => {
      const mk = (html: string) => {
        const host = document.createElement("div");
        host.innerHTML = html;
        document.body.appendChild(host);
        return host;
      };
      const s = mk('<div id="st" style="width:40px;height:20px;top:50px;left:50px"></div>');
      const stBefore = s.firstElementChild!.getBoundingClientRect();
      const r = mk(
        '<div style="width:100px;height:100px"><div id="rp" style="position:relative;top:-50%;width:40px;height:20px"></div></div>',
      );
      const rpRect = r.firstElementChild!.firstElementChild!.getBoundingClientRect();
      const rTop = r.firstElementChild!.getBoundingClientRect().top;
      const a = mk(
        '<div style="width:100px"><div id="ra" style="position:relative;top:-50%;width:40px;height:20px"></div></div>',
      );
      const raRect = a.firstElementChild!.firstElementChild!.getBoundingClientRect();
      const aTop = a.firstElementChild!.getBoundingClientRect().top;
      const out = {
        staticUnmoved:
          stBefore.left === s.getBoundingClientRect().left &&
          stBefore.top === s.getBoundingClientRect().top,
        relPctShift: Math.round(rpRect.top - rTop),
        relAutoShift: Math.round(raRect.top - aTop),
      };
      s.remove();
      r.remove();
      a.remove();
      return out;
    }),
  ).toEqual({ staticUnmoved: true, relPctShift: -50, relAutoShift: 0 });

  expect(
    await page.evaluate(() => {
      const scroller = document.getElementById("scroller")!;
      const after = document.getElementById("after")!;
      const beforeRect = after.getBoundingClientRect().top;
      scroller.scrollTop = 150;
      return {
        offsetTop: after.offsetTop,
        rectMoved: after.getBoundingClientRect().top !== beforeRect,
      };
    }),
  ).toEqual({ offsetTop: 200, rectMoved: true });
}, 120_000);
