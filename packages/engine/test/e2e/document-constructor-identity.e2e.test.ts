// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// `document.constructor` is the Document interface, and no element is an
// instance of it. Bootstrap 4's tooltip guard compares against it, so a wrong
// answer throws on every element.
// https://html.spec.whatwg.org/multipage/dom.html#the-document-object
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<!doctype html><html><body><span id="s">x</span>
<script>
  var span = document.getElementById("s");
  globalThis.__ctor = JSON.stringify({
    same: document.constructor === window.Document,
    docIsDocument: document instanceof window.Document,
    docIsCtor: document instanceof document.constructor,
    spanIsCtor: span instanceof document.constructor,
    spanIsDocument: span instanceof window.Document,
    htmlDocument: document.constructor === HTMLDocument,
  });
</script></body></html>`;

test("document.constructor is the Document interface", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__ctor")).toEqual({
    same: true,
    docIsDocument: true,
    docIsCtor: true,
    spanIsCtor: false,
    spanIsDocument: false,
    htmlDocument: true,
  });
}, 60_000);
