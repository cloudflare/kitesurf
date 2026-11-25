// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

// Knockout clones each parsed component template, so an emptied <!-- ko --> comment dropped its
// binding and the bindings beneath it ran in the wrong context (Microsoft's sign-in page).
test("a deep clone keeps the data of parsed comments", async ({ page }) => {
  await setContent(
    page,
    `<div id="doc"><!-- in document --><b>x</b></div>
    <script>
      const div = document.createElement("div");
      div.innerHTML = "<!-- ko if: x --><b>a</b><!-- /ko -->";
      const written = document.createElement("div");
      written.innerHTML = "<!--before-->";
      written.firstChild.data = "after";
      window.__clone = JSON.stringify({
        comment: div.firstChild.cloneNode(true).data,
        shallow: div.firstChild.cloneNode(false).data,
        parent: Array.from(div.cloneNode(true).childNodes, (n) => n.nodeValue ?? n.nodeName),
        document: document.getElementById("doc").cloneNode(true).firstChild.nodeValue,
        created: document.createComment("made").cloneNode(true).data,
        written: written.cloneNode(true).firstChild.data,
        serialized: div.cloneNode(true).innerHTML,
      });
    </script>`,
  );
  expect(await page.evaluate("JSON.parse(window.__clone)")).toEqual({
    comment: " ko if: x ",
    shallow: " ko if: x ",
    parent: [" ko if: x ", "B", " /ko "],
    document: " in document ",
    created: "made",
    written: "after",
    serialized: "<!-- ko if: x --><b>a</b><!-- /ko -->",
  });
});
