// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const MARKUP = `<script>
  const doc = document.implementation.createHTMLDocument("t");
  const doctype = doc.implementation.createDocumentType("html", "public", "system");
  const imported = document.importNode(doctype);
  const fromTree = document.importNode(doc.doctype, true);
  window.__out = {
    distinct: imported !== doctype,
    nodeType: imported.nodeType,
    ids: [imported.name, imported.publicId, imported.systemId],
    owner: imported.ownerDocument === document,
    parent: imported.parentNode,
    sourceOwner: doctype.ownerDocument === doc,
    treeName: fromTree.name,
    treeOwner: fromTree.ownerDocument === document,
    sourceParent: doc.doctype.parentNode === doc,
  };
</script>`;

test("document.importNode clones a DocumentType into the importing document", async ({ page }) => {
  await setContent(page, MARKUP);
  const r = await page.evaluate(
    () => (window as typeof window & { __out: Record<string, unknown> }).__out,
  );
  expect(r).toEqual({
    distinct: true,
    nodeType: 10,
    ids: ["html", "public", "system"],
    owner: true,
    parent: null,
    sourceOwner: true,
    treeName: "html",
    treeOwner: true,
    sourceParent: true,
  });
});
