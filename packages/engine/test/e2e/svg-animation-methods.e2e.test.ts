// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The SMIL timing methods exist and are callable, so a page that calls them
// unconditionally does not throw. Nothing animates yet: see the TODO in
// globals.ts.
// https://www.w3.org/TR/SVG11/animation.html#InterfaceSVGSVGElement
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<!doctype html><html><body>
<svg id="s"><circle r="4"></circle></svg>
<script>
  var svg = document.getElementById("s");
  var out = {
    pause: typeof svg.pauseAnimations,
    unpause: typeof svg.unpauseAnimations,
    paused: typeof svg.animationsPaused,
    current: typeof svg.getCurrentTime,
    setCurrent: typeof svg.setCurrentTime,
    protoPause: typeof SVGSVGElement.prototype.pauseAnimations,
  };
  try {
    svg.pauseAnimations();
    svg.unpauseAnimations();
    svg.setCurrentTime(1.5);
    out.callable = true;
  } catch (e) {
    out.callable = String(e && e.message);
  }
  out.pausedValue = svg.animationsPaused();
  globalThis.__svg = JSON.stringify(out);
</script></body></html>`;

test("SVG timing methods exist and are callable", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__svg")).toEqual({
    pause: "function",
    unpause: "function",
    paused: "function",
    current: "function",
    setCurrent: "function",
    protoPause: "function",
    callable: true,
    pausedValue: false,
  });
}, 60_000);
