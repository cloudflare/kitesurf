// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("range-live-mutation-demo", async ({ page }) => {
  const session = await page.target().createCDPSession();

  const tree = await session.send("Page.getFrameTree");
  await session.send("Page.setDocumentContent", {
    frameId: tree.frameTree.frame.id,
    html: "<!doctype html><html><body></body></html>",
  });

  const results = await page.evaluate(() => {
    const out = [];
    const check = (name, got, want) => {
      const ok = JSON.stringify(got) === JSON.stringify(want);
      out.push({ name, ok, got, want });
    };

    function freshText(data) {
      const t = document.createTextNode(data);
      document.body.appendChild(t);
      return t;
    }
    function freshComment(data) {
      const c = document.createComment(data);
      document.body.appendChild(c);
      return c;
    }
    function mkRange(sc, so, ec, eo) {
      const r = document.createRange();
      r.setStart(sc, so);
      r.setEnd(ec, eo);
      return r;
    }
    const snap = (r) => [r.startOffset, r.endOffset];

    {
      const t = freshText("0123456789");
      const r = mkRange(t, 1, t, 5);
      t.data = "foo";
      check("text .data= collapse", snap(r), [0, 0]);
      check("text .data= container", r.startContainer === t, true);
    }
    {
      const t = freshText("0123456789");
      const r = mkRange(t, 1, t, 5);
      t.textContent = "foo";
      check("text .textContent= collapse", snap(r), [0, 0]);
    }
    {
      const t = freshText("0123456789");
      const r = mkRange(t, 1, t, 5);
      t.nodeValue = "foo";
      check("text .nodeValue= collapse", snap(r), [0, 0]);
    }
    {
      const t = freshText("0123456789");
      const r = mkRange(t, 0, t, 0);
      t.data = "foo";
      check("text .data= zero stays", snap(r), [0, 0]);
    }
    {
      const t = freshText("0123456789");
      const r = mkRange(t, 1, t, 10);
      t.data += "foo";
      check("text .data+= collapse", snap(r), [0, 0]);
    }
    {
      const c = freshComment("0123456789");
      const r = mkRange(c, 1, c, 5);
      c.data = "foo";
      check("comment .data= collapse", snap(r), [0, 0]);
    }
    {
      const c = freshComment("0123456789");
      const r = mkRange(c, 1, c, 5);
      c.textContent = "foo";
      check("comment .textContent= collapse", snap(r), [0, 0]);
    }
    {
      const t = document.createTextNode("0123456789");
      const r = mkRange(t, 1, t, 5);
      t.data = "foo";
      check("detached text .data= collapse", snap(r), [0, 0]);
    }

    {
      const t = freshText("0123456789");
      const r = mkRange(t, 3, t, 8);
      t.deleteData(2, 4);
      check("deleteData mid", snap(r), [2, 4]);
    }
    {
      const t = freshText("0123456789");
      const r = mkRange(t, 3, t, 8);
      t.replaceData(2, 4, "xy");
      check("replaceData mid", snap(r), [2, 6]);
    }
    {
      const t = freshText("0123456789");
      const r = mkRange(t, 3, t, 8);
      t.insertData(2, "xy");
      check("insertData mid", snap(r), [5, 10]);
    }

    {
      const t = freshText("0123456789");
      const r = mkRange(t, 2, t, 7);
      const n = t.splitText(4);
      check("splitText start stays", [r.startContainer === t, r.startOffset], [true, 2]);
      check("splitText end migrates", [r.endContainer === n, r.endOffset], [true, 3]);
    }
    {
      const parent = document.createElement("div");
      document.body.appendChild(parent);
      const t = document.createTextNode("0123456789");
      parent.appendChild(t);
      const r = mkRange(parent, 1, parent, 1);
      t.splitText(4);
      check("splitText parent idx+1 bump", snap(r), [2, 2]);
    }
    {
      const t = document.createTextNode("0123456789");
      const r = mkRange(t, 2, t, 7);
      t.splitText(4);
      check(
        "splitText detached",
        [r.startContainer === t, r.startOffset, r.endContainer === t, r.endOffset],
        [true, 2, true, 4],
      );
    }

    return out;
  });

  expect(results.length).toBe(16);
  const failures = results.filter((r) => !r.ok);
  expect(failures).toEqual([]);
});
