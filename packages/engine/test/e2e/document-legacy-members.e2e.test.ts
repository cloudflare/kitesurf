// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Pins legacy Document members and `document.all` behavior.
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<script>
  (function () {
    document.designMode = "on";
    globalThis.__docReport = JSON.stringify({
      designMode: document.designMode,
      lastModified: /^\\d\\d\\/\\d\\d\\/\\d\\d\\d\\d \\d\\d:\\d\\d:\\d\\d$/.test(document.lastModified),
      fullscreen: [document.fullscreenEnabled, document.fullscreenElement,
        document.exitFullscreen() instanceof Promise],
      legacy: [typeof document.clear, document.clear(), document.captureEvents(),
        document.releaseEvents()],
      all: typeof document.all,
    });
  })();
</script>`;

test("the live document has the legacy Document members", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__docReport")).toEqual({
    designMode: "off",
    lastModified: true,
    fullscreen: [false, null, true],
    legacy: ["function", null, null, null],
    all: "undefined",
  });
}, 60_000);
