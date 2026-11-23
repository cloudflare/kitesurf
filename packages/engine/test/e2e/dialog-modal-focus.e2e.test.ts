// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// showModal() runs the dialog focusing steps: the autofocus element, else the
// first focusable descendant, else the dialog itself. A modal that leaves
// focus on the page breaks keyboard use.
// https://html.spec.whatwg.org/multipage/interactive-elements.html#dialog-focusing-steps
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<!doctype html><html><body>
<button id="opener">open</button>
<dialog id="plain"><button id="first">one</button><input id="second"></dialog>
<dialog id="auto"><button id="before">x</button><input id="picked" autofocus></dialog>
<dialog id="empty">no controls</dialog>
<script>
  globalThis.__focus = JSON.stringify({
    plain: (function () {
      document.getElementById("plain").showModal();
      return document.activeElement.id;
    })(),
    auto: (function () {
      document.getElementById("auto").showModal();
      return document.activeElement.id;
    })(),
    empty: (function () {
      var empty = document.getElementById("empty");
      empty.showModal();
      return document.activeElement === empty ? "dialog" : document.activeElement.id;
    })(),
  });
</script></body></html>`;

test("showModal moves focus into the dialog", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__focus")).toEqual({
    plain: "first",
    auto: "picked",
    empty: "dialog",
  });
}, 60_000);
