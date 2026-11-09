// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A created or imported document has no node id, but its host element owns the
// tree. Observing the document must start the observer rather than throw.
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<script>
  (function () {
    var doc = document.implementation.createHTMLDocument("t");
    var mo = new MutationObserver(function (list) {
      globalThis.__moReport = JSON.stringify({ threw: null, records: list.length });
    });
    try {
      mo.observe(doc, { childList: true, subtree: true });
      doc.body.appendChild(doc.createElement("div"));
    } catch (e) {
      globalThis.__moReport = JSON.stringify({
        threw: String((e && e.message) || e),
        records: 0,
      });
    }
  })();
</script>`;

test("MutationObserver accepts a created document", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => (globalThis as { __moReport?: string }).__moReport !== undefined,
    { timeout: 20_000 },
  );
  expect(await readJsonReport(cdpSession, "globalThis.__moReport")).toEqual({
    threw: null,
    records: 1,
  });
}, 60_000);
