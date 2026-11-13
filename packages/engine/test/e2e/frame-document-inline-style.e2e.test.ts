// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Elements created from a frame document have an inline style declaration, as
// main-document elements do. A page that sets `el.style.cssText` on them threw
// "Cannot set properties of undefined".
// https://drafts.csswg.org/cssom/#dom-elementcssinlinestyle-style
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<!doctype html><html><body>
<iframe id="f" srcdoc="<p>x</p>"></iframe>
<script>
  var frameDoc = document.getElementById("f").contentDocument;
  var made = frameDoc.createElement("iframe");
  made.style.cssText = "display:none";
  var body = frameDoc.body;
  body.style.setProperty("margin-left", "4px");
  var out = {
    styleType: typeof made.style,
    cssText: made.style.cssText,
    attr: made.getAttribute("style"),
    bodyStyle: typeof body.style,
    bodyMargin: body.style.getPropertyValue("margin-left"),
    bodyAttr: body.getAttribute("style"),
  };
  made.style.display = "block";
  out.afterProp = made.getAttribute("style");
  globalThis.__frameStyle = JSON.stringify(out);
</script></body></html>`;

test("frame-document elements have a working inline style", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__frameStyle")).toEqual({
    styleType: "object",
    cssText: "display: none;",
    attr: "display: none;",
    bodyStyle: "object",
    bodyMargin: "4px",
    bodyAttr: "margin-left: 4px;",
    afterProp: "display: block;",
  });
}, 60_000);
