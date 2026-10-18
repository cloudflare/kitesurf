// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Element implementation slots stay private and never appear as own properties.
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<form id="f"><input id="i" name="q"><button id="b">go</button></form>
<script>
  (function () {
    var form = document.getElementById("f");
    var input = document.getElementById("i");
    var button = document.getElementById("b");
    input.style.color = "red";
    form.elements.length;
    button.popoverTargetElement = input;
    input.popoverTargetElement = button;
    form.addEventListener("submit", function (e) { e.preventDefault(); });
    form.requestSubmit();
    var nodeSlots = ["_id", "_info", "_parentIdCache", "_parentIdSeq",
      "_attrFlatCache", "_attrFlatCacheSeq", "_typeCheckSeq"];
    var extra = function (el) {
      return Object.getOwnPropertyNames(el).filter(function (k) { return nodeSlots.indexOf(k) < 0; });
    };
    var root = document.createElement("div").attachShadow({ mode: "open" });
    var sheets = root.styleSheets;
    var illegal = null;
    try { Object.getOwnPropertyDescriptor(HTMLButtonElement.prototype, "popoverTargetElement").get.call({}); }
    catch (e) { illegal = e.constructor.name; }
    globalThis.__elementReport = JSON.stringify({
      extra: [extra(form), extra(input), extra(button), extra(root)],
      identity: [input.style === input.style, form.elements === form.elements,
        root.styleSheets === sheets],
      values: [input.style.color, form.elements.length, button.popoverTargetElement === input,
        input.popoverTargetElement === button],
      tags: [Object.prototype.toString.call(input), Object.prototype.toString.call(form),
        Object.prototype.toString.call(document.createElement("x-y"))],
      illegal: illegal,
    });
  })();
</script>`;

test("element state is not exposed as own properties", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__elementReport")).toEqual({
    extra: [[], [], [], []],
    identity: [true, true, true],
    values: ["red", 2, true, true],
    tags: ["[object HTMLInputElement]", "[object HTMLFormElement]", "[object HTMLElement]"],
    illegal: "TypeError",
  });
}, 60_000);
