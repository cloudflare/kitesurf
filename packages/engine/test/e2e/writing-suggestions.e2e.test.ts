// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// writingSuggestions is a DOMString, not a boolean reflection: the getter
// returns the computed "true"/"false" value, which inherits from the parent
// while the attribute is missing, and the setter writes the string as given.
// https://html.spec.whatwg.org/#dom-writingsuggestions
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<div id="off" writingsuggestions="FaLsE"><span id="inherit"></span><b id="on" writingsuggestions="foo"></b></div>
<i id="plain"></i>
<script>
  (function () {
    var get = function (id) { return document.getElementById(id); };
    var plain = get("plain");
    var setTo = function (v) { plain.writingSuggestions = v; return plain.getAttribute("writingsuggestions"); };
    globalThis.__wsReport = JSON.stringify({
      computed: ["off", "inherit", "on", "plain"].map(function (id) { return get(id).writingSuggestions; }),
      written: [setTo("TrUe"), setTo(false), setTo("")],
      afterEmpty: plain.writingSuggestions,
    });
  })();
</script>`;

test("writingSuggestions returns the computed string value", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__wsReport")).toEqual({
    computed: ["false", "false", "true", "true"],
    written: ["TrUe", "false", ""],
    afterEmpty: "true",
  });
}, 60_000);
