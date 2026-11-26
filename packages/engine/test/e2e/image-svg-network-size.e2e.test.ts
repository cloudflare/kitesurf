// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A fetched SVG image keeps its intrinsic size, as a data-URI SVG already did.
// Without it every network SVG icon was zero-sized (and reported as a failed
// image), so brand marks and social icons vanished.
// https://html.spec.whatwg.org/multipage/images.html#sourcing-out-of-band-images
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<!doctype html><html><body>
<img id="svg" src="https://ks.invalid/__fixtures/icon-sprite.svg">
<img id="missing" src="https://ks.invalid/__fixtures/no-such-image.png">
<script>
  globalThis.__events = {};
  ["svg", "missing"].forEach(function (id) {
    var img = document.getElementById(id);
    ["load", "error"].forEach(function (type) {
      img.addEventListener(type, function () {
        var key = id + ":" + type;
        globalThis.__events[key] = (globalThis.__events[key] || 0) + 1;
      });
    });
  });
  globalThis.__svgSize = function () {
    var img = document.getElementById("svg");
    return JSON.stringify({
      events: globalThis.__events,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      complete: img.complete,
      missingComplete: document.getElementById("missing").complete,
    });
  };
</script></body></html>`;

test("a network SVG image keeps its intrinsic size", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const report = await readJsonReport(cdpSession, "globalThis.__svgSize()");
  expect(report.events).toEqual({ "svg:load": 1, "missing:error": 1 });
  expect(Number(report.naturalWidth)).toBeGreaterThan(0);
  expect(Number(report.naturalHeight)).toBeGreaterThan(0);
  expect(report.complete).toBe(true);
  expect(report.missingComplete).toBe(true);
}, 60_000);
