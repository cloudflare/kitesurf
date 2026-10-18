// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// select.options is an HTMLOptionsCollection: the global is the real class,
// it inherits from HTMLCollection, and its own length and selectedIndex
// accessors reach the owner <select>.
// https://html.spec.whatwg.org/#htmloptionscollection
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<select id="s"><option>a</option><option selected>b</option></select>
<script>
  (function () {
    var s = document.getElementById("s");
    var options = s.options;
    var proto = HTMLOptionsCollection.prototype;
    var before = options.selectedIndex;
    options.selectedIndex = 0;
    Object.getOwnPropertyDescriptor(proto, "length").set.call(options, 3);
    globalThis.__optionsReport = JSON.stringify({
      interface: [options instanceof HTMLOptionsCollection,
        Object.getPrototypeOf(proto) === HTMLCollection.prototype,
        Object.prototype.toString.call(options), typeof proto.add, proto.add.length],
      selectedIndex: [before, s.selectedIndex, options.selectedIndex],
      length: [s.length, options.length],
    });
  })();
</script>`;

test("select.options is an HTMLOptionsCollection", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__optionsReport")).toEqual({
    interface: [true, true, "[object HTMLOptionsCollection]", "function", 1],
    selectedIndex: [1, 0, 0],
    length: [3, 3],
  });
}, 60_000);
