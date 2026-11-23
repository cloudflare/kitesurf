// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A same-origin frame's contentWindow exposes the realm's constructors. Osano's
// bundle reads `frame.contentWindow.HTMLScriptElement.prototype`, which threw
// when the facade carried only a hand-kept list.
// https://html.spec.whatwg.org/multipage/window-object.html#the-window-object
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<!doctype html><html><body>
<iframe id="same" srcdoc="<p>x</p>"></iframe>
<iframe id="cross" src="https://ks.invalid/__fixtures/inserted-script.html"></iframe>
<script>
  globalThis.__frameCtors = function () {
    var same = document.getElementById("same").contentWindow;
    var cross = document.getElementById("cross").contentWindow;
    var out = {
      script: typeof same.HTMLScriptElement,
      div: typeof same.HTMLDivElement,
      document: typeof same.Document,
      node: typeof same.Node,
      scriptPrototype: typeof same.HTMLScriptElement.prototype,
      srcDescriptor: (function () {
        var d = Object.getOwnPropertyDescriptor(same.HTMLScriptElement.prototype, "src");
        return d ? "descriptor" : "none";
      })(),
      // A cross-origin window keeps constructors inaccessible per HTML cross-origin rules.
      crossScript: cross ? typeof cross.HTMLScriptElement : "no-window",
    };
    return JSON.stringify(out);
  };
</script></body></html>`;

test("a same-origin frame window exposes the realm's constructors", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  await new Promise((resolve) => setTimeout(resolve, 800));
  expect(await readJsonReport(cdpSession, "globalThis.__frameCtors()")).toEqual({
    script: "function",
    div: "function",
    document: "function",
    node: "function",
    scriptPrototype: "object",
    srcDescriptor: "descriptor",
    crossScript: "undefined",
  });
}, 60_000);
