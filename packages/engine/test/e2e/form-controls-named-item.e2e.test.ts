// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// form.elements.namedItem(name) returns a RadioNodeList when more than one
// control matches, the same object kind as the named property read and its
// property descriptor. Its value setter checks the radio with that value.
// https://html.spec.whatwg.org/#dom-htmlformcontrolscollection-nameditem
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<form id="f">
  <input type="radio" name="r" value="a"><input type="radio" name="r" value="b" checked>
  <input id="solo" name="t">
</form>
<script>
  (function () {
    var els = document.getElementById("f").elements;
    var viaMethod = els.namedItem("r");
    var viaProperty = els.r;
    var radios = document.querySelectorAll("[name=r]");
    var methodValue = viaMethod.value;
    var described = Object.getOwnPropertyDescriptor(els, "r").value;
    var descriptor = [described instanceof RadioNodeList, described.length, described.value];
    viaMethod.value = "a";
    var afterMethodSet = [radios[0].checked, viaMethod.value];
    viaProperty.value = "b";
    var afterPropertySet = [radios[1].checked, viaProperty.value];
    var strictIndexWrite = (function () {
      "use strict";
      try { viaMethod[0] = null; return "none"; } catch (e) { return e.constructor.name; }
    })();
    viaMethod.pageProp = 1;
    globalThis.__namedReport = JSON.stringify({
      method: [viaMethod instanceof RadioNodeList, viaMethod.length, methodValue],
      property: [viaProperty instanceof RadioNodeList, viaProperty.length],
      descriptor: descriptor,
      set: [afterMethodSet, afterPropertySet, strictIndexWrite, viaMethod.pageProp,
        Object.keys(viaMethod).indexOf("pageProp") >= 0],
      single: [els.namedItem("solo") === document.getElementById("solo"),
        els.namedItem("t") === document.getElementById("solo"), els.namedItem("none")],
      own: Object.prototype.hasOwnProperty.call(HTMLFormControlsCollection.prototype, "namedItem"),
    });
  })();
</script>`;

test("form.elements.namedItem returns a RadioNodeList for shared names", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__namedReport")).toEqual({
    method: [true, 2, "b"],
    property: [true, 2],
    descriptor: [true, 2, "b"],
    set: [[true, "a"], [true, "b"], "TypeError", 1, true],
    single: [true, true, null],
    own: true,
  });
}, 60_000);
