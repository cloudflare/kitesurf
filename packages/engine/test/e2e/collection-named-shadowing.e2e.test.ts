// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Named properties must not shadow prototype members.
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<select id="s"><option id="add">a</option><option id="selectedIndex" selected>b</option>
<option id="plain">c</option></select>
<script>
  (function () {
    var options = document.getElementById("s").options;
    globalThis.__shadowReport = JSON.stringify({
      members: [typeof options.add, typeof options.remove, options.selectedIndex],
      named: [options.plain === document.getElementById("plain"),
        options.namedItem("add") === document.getElementById("add")],
      reflection: [Object.getOwnPropertyDescriptor(options, "add"),
        Object.getOwnPropertyNames(options).filter(function (k) { return isNaN(k); }),
        Object.getOwnPropertyDescriptor(options, "plain").value === document.getElementById("plain"),
        delete options.add, typeof options.add, delete options.plain],
    });
  })();
</script>`;

test("collection named properties don't shadow subclass members", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__shadowReport")).toEqual({
    members: ["function", "function", 1],
    named: [true, true],
    reflection: [null, ["plain"], true, true, "function", false],
  });
}, 60_000);

const expandoHtml = `<div id="a"><i></i></div><div id="b"><i></i></div>
<script>
  (function () {
    var a = document.getElementById("a").children;
    var b = document.getElementById("b").children;
    a.extra = 1;
    a.later = "expando";
    for (var id of ["a", "b"]) {
      var span = document.createElement("span");
      span.id = "later";
      document.getElementById(id).appendChild(span);
    }
    globalThis.__expandoReport = JSON.stringify({
      own: [a.extra, document.getElementById("a").children.extra, a.later],
      other: [b.extra === undefined, "extra" in b, b.later === b[1]],
      keys: Object.keys(a),
      removed: [delete a.extra, a.extra === undefined, "extra" in a],
    });
  })();
</script>`;

test("collection expandos stay on their own collection", async ({ page, cdpSession }) => {
  await setContent(page, expandoHtml, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__expandoReport")).toEqual({
    own: [1, 1, "expando"],
    other: [true, false, true],
    keys: ["0", "1", "extra", "later"],
    removed: [true, true, false],
  });
}, 60_000);
