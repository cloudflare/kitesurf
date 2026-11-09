// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The bundle shadows `require` so UMD scripts take their browser branch. That
// shadow must not hide a page-defined global require from later scripts.
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<script>
  window.require = function (id) { return "loaded:" + id; };
</script>
<script>
  globalThis.__requireReport = JSON.stringify({
    type: typeof require,
    value: require("x"),
  });
</script>`;

test("a page-defined global require survives the bundle shadow", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__requireReport")).toEqual({
    type: "function",
    value: "loaded:x",
  });
}, 60_000);
