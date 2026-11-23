// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A parser-inserted <link rel=preload as=style> starts its fetch while the
// document parses, and its onload handler is how pages swap rel to stylesheet.
// Without the fetch the handler never ran and the sheet stayed unapplied.
// https://html.spec.whatwg.org/multipage/links.html#link-type-preload
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<!doctype html><html><head>
<link id="pre" rel="preload" as="style" href="https://ks.invalid/__fixtures/webfont-face.css"
      onload="this.onload=null; this.rel='stylesheet'; globalThis.__preloadLoad = (globalThis.__preloadLoad || 0) + 1"
      onerror="globalThis.__preloadError = (globalThis.__preloadError || 0) + 1">
<link id="bad" rel="preload" as="style" href="https://ks.invalid/__fixtures/no-such-sheet.css"
      onload="globalThis.__badLoad = (globalThis.__badLoad || 0) + 1"
      onerror="globalThis.__badError = (globalThis.__badError || 0) + 1">
</head><body><p>x</p>
<script>
  globalThis.__preloadReport = function () {
    return JSON.stringify({
      load: globalThis.__preloadLoad || 0,
      error: globalThis.__preloadError || 0,
      badLoad: globalThis.__badLoad || 0,
      badError: globalThis.__badError || 0,
      rel: document.getElementById("pre").getAttribute("rel"),
    });
  };
</script></body></html>`;

test("a parser-inserted style preload fetches and fires load", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  const deadline = Date.now() + 10_000;
  let report: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    report = await readJsonReport(cdpSession, "globalThis.__preloadReport()");
    if ((report.load as number) >= 1 && report.badError === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // The swapped stylesheet fires load again, so count at least the preload's.
  expect(report.load).toBeGreaterThanOrEqual(1);
  expect(report.error).toBe(0);
  expect(report.rel).toBe("stylesheet");
  expect(report.badLoad).toBe(0);
  expect(report.badError).toBe(1);
}, 60_000);
