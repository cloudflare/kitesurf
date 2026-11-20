// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// ImageData dimensions are WebIDL longs, and converting a BigInt to a long throws a
// TypeError. Number() would accept it, so the context must keep the `| 0` conversion.
// The page script runs natively; a BigInt from Runtime.evaluate reaches it as a number.
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<canvas id=c width=4 height=4></canvas>
<script>
  (function () {
    var ctx = document.getElementById("c").getContext("2d");
    function outcome(fn) {
      try { fn(); return "accepted"; }
      catch (e) { return e instanceof TypeError ? "TypeError" : String(e); }
    }
    globalThis.__bigintReport = JSON.stringify({
      create: outcome(function () { ctx.createImageData(BigInt(1), 1); }),
      put: outcome(function () {
        ctx.putImageData({ width: BigInt(1), height: 1, data: new Uint8ClampedArray(4) }, 0, 0);
      }),
      number: outcome(function () { ctx.createImageData(1, 1); }),
    });
  })();
</script>`;

test("createImageData and putImageData reject BigInt dimensions", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__bigintReport")).toEqual({
    create: "TypeError",
    put: "TypeError",
    number: "accepted",
  });
}, 120_000);
