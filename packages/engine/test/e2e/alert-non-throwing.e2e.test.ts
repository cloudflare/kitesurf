// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// alert() must not throw: pages call it from load listeners and abort when the
// sandbox rejects it. Chrome opens a dialog; the shim stays silent.
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<script>
  (function () {
    var out = { type: typeof window.alert, threw: null, returned: null };
    try {
      out.returned = String(alert("kitesurf alert probe"));
    } catch (e) {
      out.threw = String((e && e.message) || e);
    }
    globalThis.__alertReport = JSON.stringify(out);
  })();
</script>`;

test("alert does not throw", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__alertReport")).toEqual({
    type: "function",
    threw: null,
    returned: "undefined",
  });
}, 60_000);
