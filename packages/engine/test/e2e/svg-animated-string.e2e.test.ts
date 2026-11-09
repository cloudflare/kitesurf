// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The SVGAnimatedString interface must exist; page code constructs it and reads
// baseVal/animVal. It was missing entirely.
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<script>
  (function () {
    var Ctor = globalThis.SVGAnimatedString;
    var out = { type: typeof Ctor, base: null, anim: null, writable: null };
    if (typeof Ctor === "function") {
      var v = new Ctor("hello");
      out.base = v.baseVal;
      out.anim = v.animVal;
      v.baseVal = "changed";
      out.writable = v.baseVal;
    }
    globalThis.__svgStringReport = JSON.stringify(out);
  })();
</script>`;

test("SVGAnimatedString exists with baseVal and animVal", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__svgStringReport")).toEqual({
    type: "function",
    base: "hello",
    anim: "hello",
    writable: "changed",
  });
}, 60_000);
