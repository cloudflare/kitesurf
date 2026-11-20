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

// The document's own children live under its host element; the record must still name the
// document, and the host must never reach page script.
const documentChildren = `<script>
  (function () {
    var doc = document.implementation.createHTMLDocument("t");
    var seen = [];
    var mo = new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        seen.push({
          isDoc: list[i].target === doc,
          nodeName: String(list[i].target && list[i].target.nodeName),
        });
      }
      globalThis.__moChildren = JSON.stringify({ records: seen });
    });
    mo.observe(doc, { childList: true });
    doc.removeChild(doc.documentElement);
    doc.appendChild(doc.createElement("html"));
  })();
</script>`;

test("records for a created document's own children name the document", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, documentChildren, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => (globalThis as { __moChildren?: string }).__moChildren !== undefined,
    { timeout: 20_000 },
  );
  expect(await readJsonReport(cdpSession, "globalThis.__moChildren")).toEqual({
    records: [
      { isDoc: true, nodeName: "#document" },
      { isDoc: true, nodeName: "#document" },
    ],
  });
}, 60_000);
