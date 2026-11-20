// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// PerformanceNavigationTiming must exist and the navigation entry must be an
// instance of it; analytics scripts read the constructor and the entry type.
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<script>
  (function () {
    var nav = performance.getEntriesByType("navigation")[0];
    globalThis.__navReport = JSON.stringify({
      ctor: typeof PerformanceNavigationTiming,
      isInstance: nav instanceof PerformanceNavigationTiming,
      entryType: nav && nav.entryType,
      nameMatches: !!nav && nav.name === location.href,
      type: nav && nav.type,
    });
  })();
</script>`;

test("the navigation entry is a PerformanceNavigationTiming", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__navReport")).toEqual({
    ctor: "function",
    isInstance: true,
    entryType: "navigation",
    nameMatches: true,
    type: "navigate",
  });
}, 60_000);
