// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A created document's legacy color attributes reflect its body's
// attributes, and its lastModified uses the spec's format, as on the live
// document.
// https://html.spec.whatwg.org/#dom-document-fgcolor
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<script>
  (function () {
    var doc = document.implementation.createHTMLDocument("t");
    doc.body.setAttribute("link", "red");
    doc.bgColor = "blue";
    globalThis.__createdReport = JSON.stringify({
      colors: [doc.linkColor, doc.body.getAttribute("bgcolor"), doc.fgColor],
      lastModified: /^\\d\\d\\/\\d\\d\\/\\d\\d\\d\\d \\d\\d:\\d\\d:\\d\\d$/.test(doc.lastModified),
    });
  })();
</script>`;

test("a created document has the live document's legacy members", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__createdReport")).toEqual({
    colors: ["red", "blue", ""],
    lastModified: true,
  });
}, 60_000);
