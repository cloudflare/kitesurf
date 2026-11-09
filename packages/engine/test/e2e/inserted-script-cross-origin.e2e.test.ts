// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A dynamically inserted cross-origin script without Access-Control-Allow-Origin
// must still load. The fixtures worker serves corp-script.js with no ACAO.
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<script>
  (function () {
    var finish = function (state) {
      globalThis.__insertedScript = state;
      globalThis.__insertedReport = JSON.stringify({
        state: state,
        ran: globalThis.__ks_corp_ran || 0,
      });
    };
    globalThis.__insertedScript = "pending";
    var s = document.createElement("script");
    s.src = "https://ks.invalid/__fixtures/corp-script.js?probe=" + Date.now();
    s.onload = function () { finish("load"); };
    s.onerror = function () { finish("error"); };
    document.head.appendChild(s);
    setTimeout(function () {
      if (globalThis.__insertedScript === "pending") finish("timeout");
    }, 8000);
  })();
</script>`;

test("inserted cross-origin script without ACAO loads", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => (globalThis as { __insertedScript?: string }).__insertedScript !== "pending",
    { timeout: 20_000 },
  );
  expect(await readJsonReport(cdpSession, "globalThis.__insertedReport")).toEqual({
    state: "load",
    ran: 1,
  });
}, 60_000);
