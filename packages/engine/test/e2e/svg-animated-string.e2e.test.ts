// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// SVGAnimatedString is an interface, not a constructor: page code reads the
// global and its prototype accessors, and `new` throws as in Chrome.
// https://svgwg.org/svg2-draft/types.html#InterfaceSVGAnimatedString
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<script>
  (function () {
    var out = { type: typeof SVGAnimatedString, ctor: null, base: null, anim: null };
    try {
      new SVGAnimatedString();
      out.ctor = "ok";
    } catch (e) {
      out.ctor = e.name;
    }
    var base = Object.getOwnPropertyDescriptor(SVGAnimatedString.prototype, "baseVal");
    var anim = Object.getOwnPropertyDescriptor(SVGAnimatedString.prototype, "animVal");
    out.base = base && typeof base.get === "function"
      ? (typeof base.set === "function" ? "get/set" : "get")
      : "none";
    out.anim = anim && typeof anim.get === "function"
      ? (typeof anim.set === "function" ? "get/set" : "get")
      : "none";
    globalThis.__svgStringReport = JSON.stringify(out);
  })();
</script>`;

test("SVGAnimatedString is an interface, not a constructor", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__svgStringReport")).toEqual({
    type: "function",
    ctor: "TypeError",
    base: "get/set",
    anim: "get",
  });
}, 60_000);
