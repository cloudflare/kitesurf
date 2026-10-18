// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<canvas id=c width=4 height=4></canvas>
<script>
  (function () {
    var canvas = document.getElementById("c");
    var ctx = canvas.getContext("2d");
    CanvasRenderingContext2D.prototype.__ksPatched = function () { return this.canvas.id; };
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 4, 4);
    var illegal = null;
    try { CanvasRenderingContext2D.prototype.fillRect.call({}, 0, 0, 1, 1); }
    catch (e) { illegal = e.constructor.name; }
    var constructed = null;
    try { new CanvasRenderingContext2D(); } catch (e) { constructed = e.constructor.name; }
    globalThis.__ctxReport = JSON.stringify({
      isInstance: ctx instanceof CanvasRenderingContext2D,
      sameContext: canvas.getContext("2d") === ctx,
      canvasBack: ctx.canvas === canvas,
      ownOnPrototype: Object.prototype.hasOwnProperty.call(CanvasRenderingContext2D.prototype, "fillRect"),
      notOwnOnInstance: !Object.prototype.hasOwnProperty.call(ctx, "fillRect"),
      patchReaches: ctx.__ksPatched(),
      fillStyle: ctx.fillStyle,
      pixel: Array.from(ctx.getImageData(1, 1, 1, 1).data),
      illegal: illegal,
      constructed: constructed,
    });
  })();
</script>`;

test("2D contexts are CanvasRenderingContext2D instances", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__ctxReport")).toEqual({
    isInstance: true,
    sameContext: true,
    canvasBack: true,
    ownOnPrototype: true,
    notOwnOnInstance: true,
    patchReaches: "c",
    fillStyle: "#ff0000",
    pixel: [255, 0, 0, 255],
    illegal: "TypeError",
    constructed: "TypeError",
  });
}, 60_000);
