// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// popover is a nullable enumerated reflection: a missing attribute reads as null,
// the empty string as "auto" and an unknown value as "manual". Setting null removes it.
// https://html.spec.whatwg.org/#attr-popover
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<div id="el"></div>
<script>
  (function () {
    var el = document.getElementById("el");
    var read = function (value) {
      if (value === null) el.removeAttribute("popover");
      else el.setAttribute("popover", value);
      return el.popover;
    };
    var write = function (value) {
      el.popover = value;
      return el.getAttribute("popover");
    };
    globalThis.__popoverReport = JSON.stringify({
      read: [null, "", "AUTO", "manual", "Hint", "bogus"].map(read),
      written: ["hint", "", null, undefined].map(write),
    });
  })();
</script>`;

test("popover reflects the attribute as a nullable enumeration", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__popoverReport")).toEqual({
    read: [null, "auto", "auto", "manual", "hint", "manual"],
    written: ["hint", "", null, null],
  });
}, 60_000);
