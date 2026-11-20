// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<ol id="o"> lead <li id="x">x</li><!-- c --> tail </ol><p id="e"></p>
<script>
  (function () {
    var o = document.getElementById("o");
    var first = o.firstChild;
    var last = o.lastChild;
    var ends = [first.nodeType, first.data, last.nodeType, last.data, o.firstChild === first];
    var span = document.createElement("span");
    o.prepend(span, "t");
    var afterPrepend = [o.firstChild === span, span.nextSibling.data, o.firstChild.nextSibling.nextSibling === first];
    var kids = o.childNodes;
    var identity = [kids[0] === o.firstChild, kids[kids.length - 1] === o.lastChild, kids.length];
    o.removeChild(o.lastChild);
    var afterRemove = [o.lastChild.nodeType, kids.length];
    var e = document.getElementById("e");
    var empty = [e.firstChild, e.lastChild];
    e.prepend("only");
    var single = [e.firstChild === e.lastChild, e.firstChild.data, e.firstChild === e.childNodes[0]];
    var q = document.createElement("q");
    q.textContent = "a";
    var beforeHtml = q.firstChild.data;
    q.innerHTML = "<b></b>c";
    single.push(beforeHtml, q.firstChild.nodeName, q.lastChild.data, q.firstChild.nextSibling.data);
    var doc = [document.firstChild.nodeType, document.lastChild === document.documentElement];
    var x = document.getElementById("x");
    var siblings = [x.previousSibling.data, x.nextSibling.nodeType, x.nextSibling.nextSibling,
      span.previousSibling, span.nextSibling.nextSibling.nextSibling === x];
    var big = document.createElement("div");
    big.innerHTML = new Array(41).join("<b></b>t");
    var walked = 0;
    for (var n = big.firstChild; n; n = n.nextSibling) walked++;
    var back = 0;
    for (var m = big.lastChild; m; m = m.previousSibling) back++;
    var host = document.createElement("div");
    host.innerHTML = "<i></i><i></i><i></i>";
    var range = document.createRange();
    range.setStart(host, 1);
    range.setEnd(host, 3);
    host.insertBefore(document.createElement("u"), host.childNodes[1]);
    var ranged = [range.startOffset, range.endOffset];
    var listed = document.createElement("div");
    listed.innerHTML = "x<b></b>";
    var unlisted = listed.cloneNode(true);
    void listed.childNodes;
    var desc = Object.getOwnPropertyDescriptor(Node.prototype, "childNodes");
    Object.defineProperty(Node.prototype, "childNodes", { get: function () { return []; }, configurable: true });
    var patched = [listed.firstChild && listed.firstChild.nodeName,
      unlisted.firstChild && unlisted.firstChild.nodeName, big.lastChild && big.lastChild.nodeName];
    Object.defineProperty(Node.prototype, "childNodes", desc);
    globalThis.__edgeChildReport = JSON.stringify({
      patched: patched,
      ends: ends, afterPrepend: afterPrepend, identity: identity, afterRemove: afterRemove,
      empty: empty, single: single, doc: doc, siblings: siblings, walk: [walked, back],
      ranged: ranged,
    });
  })();
</script>`;

test("firstChild and lastChild read only the ends yet keep identity and liveness", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, `<!DOCTYPE html>${html}`, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__edgeChildReport")).toEqual({
    ends: [3, " lead ", 3, " tail ", true],
    afterPrepend: [true, "t", true],
    identity: [true, true, 6],
    afterRemove: [8, 5],
    empty: [null, null],
    single: [true, "only", true, "a", "B", "c", "c"],
    doc: [10, true],
    siblings: [" lead ", 8, null, null, true],
    walk: [80, 80],
    ranged: [1, 4],
    patched: ["#text", "#text", "#text"],
  });
}, 60_000);
