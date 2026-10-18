// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<div id=d></div><span id=s></span>
<script>
  (function () {
    HTMLElement.prototype.__ksPatched = function () { return this.localName; };
    var d = document.getElementById("d");
    var s = document.getElementById("s");
    class Custom extends HTMLElement {}
    customElements.define("x-chain", Custom);
    var c = document.createElement("x-chain");
    globalThis.__chainReport = JSON.stringify({
      objectChain: Object.getPrototypeOf(HTMLDivElement) === HTMLElement,
      prototypeChain: Object.getPrototypeOf(HTMLDivElement.prototype) === HTMLElement.prototype,
      patchReachesParsed: typeof d.__ksPatched === "function" ? d.__ksPatched() : null,
      divIsDiv: d instanceof HTMLDivElement,
      spanIsDiv: s instanceof HTMLDivElement,
      divIsHTMLElement: d instanceof HTMLElement,
      customIsCustom: c instanceof Custom,
      customIsHTMLElement: c instanceof HTMLElement,
    });
  })();
</script>`;

test("HTML element interfaces inherit from the page's HTMLElement", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__chainReport")).toEqual({
    objectChain: true,
    prototypeChain: true,
    patchReachesParsed: "div",
    divIsDiv: true,
    spanIsDiv: false,
    divIsHTMLElement: true,
    customIsCustom: true,
    customIsHTMLElement: true,
  });
}, 60_000);
