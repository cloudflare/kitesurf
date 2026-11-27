// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

// Insertion adopts a node from another document, and an Attr's document is its element's.
const MARKUP = `<div id="host"></div>
<script>
  const out = {};
  const doc = document.implementation.createHTMLDocument("t");

  const div = doc.createElement("div");
  div.setAttribute("data-a", "1");
  const attr = div.getAttributeNode("data-a");
  out.attrBeforeAdopt = attr.ownerDocument === doc;
  document.adoptNode(div);
  out.attrAfterAdopt = attr.ownerDocument === document;
  out.attrIdentity = div.getAttributeNode("data-a") === attr;

  const created = doc.createAttribute("data-b");
  out.createdAttr = created.ownerDocument === doc;
  const inserted = doc.createElement("p");
  inserted.appendChild(doc.createElement("span"));
  inserted.setAttributeNode(created);
  document.getElementById("host").appendChild(inserted);
  out.insertedElement = inserted.ownerDocument === document;
  out.insertedChild = inserted.firstChild.ownerDocument === document;
  out.insertedAttr = created.ownerDocument === document;

  inserted.removeAttributeNode(created);
  out.removedAttr = created.ownerDocument === document;

  const back = document.createElement("b");
  doc.body.insertBefore(back, null);
  out.intoDetached = back.ownerDocument === doc;

  const frag = document.createDocumentFragment();
  frag.appendChild(document.createElement("i"));
  const fragChild = frag.firstChild;
  doc.body.appendChild(frag);
  out.fragmentChild = fragChild.ownerDocument === doc;
  out.fragmentItself = frag.ownerDocument === document;

  const replacement = doc.createElement("em");
  document.getElementById("host").replaceChild(replacement, inserted);
  out.replaced = replacement.ownerDocument === document;

  window.__out = out;
</script>`;

test("insertion and adoptNode move a node and its Attrs to the new document", async ({ page }) => {
  await setContent(page, MARKUP);
  const r = await page.evaluate(
    () => (window as typeof window & { __out: Record<string, unknown> }).__out,
  );
  expect(r).toEqual({
    attrBeforeAdopt: true,
    attrAfterAdopt: true,
    attrIdentity: true,
    createdAttr: true,
    insertedElement: true,
    insertedChild: true,
    insertedAttr: true,
    removedAttr: true,
    intoDetached: true,
    fragmentChild: true,
    fragmentItself: true,
    replaced: true,
  });
});
