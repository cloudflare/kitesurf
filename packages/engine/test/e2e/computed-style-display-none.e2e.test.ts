// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// getComputedStyle returns the cascade's values for an element inside a
// display:none subtree. The style traversal culls those subtrees, so the values
// were empty and pages that read them before showing a panel got "".
// https://drafts.csswg.org/cssom/#resolved-values
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<!doctype html><html><head><style>
  #hidden { display: none; }
  #inner { color: rgb(1, 2, 3); font-size: 21px; }
</style></head><body>
<div id="hidden"><span id="inner">x</span></div>
<span id="shown">y</span>
<script>
  var inner = document.getElementById("inner");
  var style = getComputedStyle(inner);
  globalThis.__hiddenStyle = JSON.stringify({
    color: style.color,
    fontSize: style.fontSize,
    display: getComputedStyle(document.getElementById("hidden")).display,
    prop: style.getPropertyValue("color"),
    shownColor: getComputedStyle(document.getElementById("shown")).color,
  });
</script></body></html>`;

test("computed style inside display:none has the cascade's values", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__hiddenStyle")).toEqual({
    color: "rgb(1, 2, 3)",
    fontSize: "21px",
    display: "none",
    prop: "rgb(1, 2, 3)",
    shownColor: "rgb(0, 0, 0)",
  });
}, 60_000);
