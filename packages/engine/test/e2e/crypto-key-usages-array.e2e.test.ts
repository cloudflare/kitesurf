// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// workerd requires keyUsages to be a real Array. Pages pass Sets and array-like
// objects; the shim must coerce them before forwarding.
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<script>
  (async function () {
    var out = { threw: null, extractable: null, type: null };
    try {
      var key = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        new Set(["encrypt"]),
      );
      out.extractable = key.extractable;
      out.type = key.type;
    } catch (e) {
      out.threw = String((e && e.message) || e);
    }
    globalThis.__keyUsagesReport = JSON.stringify(out);
  })();
</script>`;

test("generateKey accepts a Set of key usages", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => (globalThis as { __keyUsagesReport?: string }).__keyUsagesReport !== undefined,
    { timeout: 30_000 },
  );
  expect(await readJsonReport(cdpSession, "globalThis.__keyUsagesReport")).toEqual({
    threw: null,
    extractable: true,
    type: "secret",
  });
}, 60_000);
