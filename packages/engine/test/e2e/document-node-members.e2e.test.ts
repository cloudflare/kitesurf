// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A created document is a Node: it is its own root, it is connected (its
// root is a document), and normalize() merges the text in its subtree.
// https://dom.spec.whatwg.org/#interface-node
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<script>
  (function () {
    var doc = document.implementation.createHTMLDocument("t");
    doc.body.appendChild(doc.createTextNode("a"));
    doc.body.appendChild(doc.createTextNode("b"));
    doc.normalize();
    var bare = new Document();
    globalThis.__nodeReport = JSON.stringify({
      root: [doc.getRootNode() === doc, bare.getRootNode({ composed: true }) === bare],
      connected: [doc.isConnected, bare.isConnected],
      normalized: [doc.body.childNodes.length, doc.body.textContent],
    });
  })();
</script>`;

test("a created document has Node's root, connected and normalize members", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__nodeReport")).toEqual({
    root: [true, true],
    connected: [true, true],
    normalized: [1, "ab"],
  });
}, 60_000);
