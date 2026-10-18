// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("selection-api", async ({ page }) => {
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><body>
        <div id="a">alpha</div><div id="b">beta</div>
        <input id="inp" value="hello">
        <div id="host"></div>
        <div id="attr" onselectionchange="window.__attrFired = true"></div>
      </body>`),
  );

  const r = await page.evaluate(async () => {
    const out: any = {};
    const sel = getSelection()!;
    const a = document.getElementById("a")!;
    const b = document.getElementById("b")!;

    sel.collapse(b.firstChild, 2);
    sel.extend(a.firstChild, 1);
    out.direction = sel.direction;
    out.anchorIsB = sel.anchorNode === b.firstChild;
    out.focusIsA = sel.focusNode === a.firstChild;
    out.rangeStartIsA = sel.getRangeAt(0).startContainer === a.firstChild;

    try {
      sel.collapse(a.firstChild, 999);
      out.collapseThrow = "none";
    } catch (e: any) {
      out.collapseThrow = e.name;
    }
    const detached = document.createElement("div");
    detached.textContent = "x";
    const before = sel.anchorNode;
    sel.collapse(detached.firstChild, 0);
    out.detachedAborts = sel.anchorNode === before;

    sel.selectAllChildren(a.firstChild!);
    out.textSelectAll = sel.getRangeAt(0).endOffset === 0;

    try {
      sel.removeRange(document.createRange());
      out.removeThrow = "none";
    } catch (e: any) {
      out.removeThrow = e.name;
    }

    sel.selectAllChildren(a);
    const frag = document.createDocumentFragment();
    frag.append(document.createElement("span"));
    sel.getRangeAt(0).selectNodeContents(frag.firstChild as any);
    out.rerootedCount = sel.rangeCount;

    let docEvents = 0;
    document.addEventListener("selectionchange", () => docEvents++);
    sel.collapse(a.firstChild, 0);
    sel.collapse(a.firstChild, 1);
    out.syncEvents = docEvents;
    await new Promise((res) => setTimeout(res, 0));
    out.asyncEvents = docEvents;

    const inp = document.getElementById("inp") as any;
    let inpEvents = 0;
    inp.addEventListener("selectionchange", () => inpEvents++);
    inp.setSelectionRange(1, 3);
    await new Promise((res) => setTimeout(res, 0));
    out.controlEvents = inpEvents;

    (window as any).__attrFired = false;
    document.getElementById("attr")!.dispatchEvent(new Event("selectionchange"));
    out.attrHandler = (window as any).__attrFired;
    return out;
  });

  expect(r.direction, "extend before anchor flips direction").toBe("backward");
  expect(r.anchorIsB, "anchor survives extend").toBe(true);
  expect(r.focusIsA, "focus moves to the extend target").toBe(true);
  expect(r.rangeStartIsA, "range boundaries reorder around direction").toBe(true);
  expect(r.collapseThrow, "collapse offset validation").toBe("IndexSizeError");
  expect(r.detachedAborts, "detached-node collapse aborts silently").toBe(true);
  expect(r.textSelectAll, "selectAllChildren uses child count").toBe(true);
  expect(r.removeThrow, "removeRange foreign range").toBe("NotFoundError");
  expect(r.rerootedCount, "rerooted range unsets the selection").toBe(0);
  expect(r.syncEvents, "selectionchange never fires synchronously").toBe(0);
  expect(r.asyncEvents, "mutations coalesce into one task").toBe(1);
  expect(r.controlEvents, "text control fires its own selectionchange").toBe(1);
  expect(r.attrHandler, "parser-set handler attribute hydrates").toBe(true);
});
