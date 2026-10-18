// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// <source> width and height reflect as unsigned long, not as DOMString like
// iframe and embed: a missing or invalid attribute reads 0.
// https://html.spec.whatwg.org/#dom-source-width
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<picture><source id="s" width="320" height="x"></picture>
<script>
  (function () {
    var s = document.getElementById("s");
    var read = [s.width, s.height, document.createElement("source").width];
    s.height = 7.9;
    globalThis.__sourceReport = JSON.stringify({ read: read, written: s.getAttribute("height") });
  })();
</script>`;

test("source width and height are unsigned long reflections", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__sourceReport")).toEqual({
    read: [320, 0, 0],
    written: "7",
  });
}, 60_000);
