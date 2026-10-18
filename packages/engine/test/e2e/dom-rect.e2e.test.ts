// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("DOMRect is a spec-shaped global that layout rects are instances of", async ({ page }) => {
  await setContent(
    page,
    `<div id="box" style="width: 30px; height: 20px"></div>
    <script>
      const r = new DOMRect(10, 20, -4, 5);
      const before = [r.left, r.right, r.top, r.bottom];
      r.width = 6;
      const box = document.getElementById("box").getBoundingClientRect();
      window.__rect = JSON.stringify({
        before, after: [r.left, r.right],
        json: new DOMRectReadOnly(1, 2, 3, 4).toJSON(),
        from: DOMRect.fromRect({ x: 7 }).x,
        tag: Object.prototype.toString.call(new DOMRectReadOnly()),
        readOnly: (() => { const ro = new DOMRectReadOnly(1); ro.x = 9; return ro.x; })(),
        layout: [box instanceof DOMRect, box instanceof DOMRectReadOnly, box.width, box.height],
      });
      const list = document.getElementById("box").getClientRects();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("box"));
      const rangeList = range.getClientRects();
      const attempt = (f) => { try { f(); return "none"; } catch (e) { return e.constructor.name; } };
      window.__shape = JSON.stringify({
        ownKeys: [Object.keys(r), Object.keys(list)],
        protoKeys: Object.keys(DOMRectReadOnly.prototype),
        list: [list instanceof DOMRectList, list.length, list.item(0) === list[0], list.item(1),
          Object.prototype.toString.call(list), [...list].length],
        range: [rangeList instanceof DOMRectList, rangeList.length,
          range.getBoundingClientRect() instanceof DOMRect,
          document.createRange().getBoundingClientRect() instanceof DOMRect],
        fromRect: [Object.hasOwn(DOMRect, "fromRect"), DOMRectReadOnly.fromRect.length,
          DOMRect.fromRect() instanceof DOMRect],
        illegal: [
          attempt(() => new DOMRectList()),
          attempt(() => Object.getOwnPropertyDescriptor(DOMRectReadOnly.prototype, "x").get.call({})),
          attempt(() => DOMRectList.prototype.item.call({}, 0)),
        ],
      });
    </script>`,
  );
  expect(await page.evaluate("JSON.parse(window.__shape)")).toEqual({
    ownKeys: [[], ["0"]],
    protoKeys: ["x", "y", "width", "height", "top", "right", "bottom", "left", "toJSON"],
    list: [true, 1, true, null, "[object DOMRectList]", 1],
    range: [true, 1, true, true],
    fromRect: [true, 0, true],
    illegal: ["TypeError", "TypeError", "TypeError"],
  });
  expect(await page.evaluate("JSON.parse(window.__rect)")).toEqual({
    before: [6, 10, 20, 25],
    after: [10, 16],
    json: { x: 1, y: 2, width: 3, height: 4, top: 2, right: 4, bottom: 6, left: 1 },
    from: 7,
    tag: "[object DOMRectReadOnly]",
    readOnly: 1,
    layout: [true, true, 30, 20],
  });
});
