// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Each classic script is its own execution unit. A throw in one must not stop
// the scripts after it, and it must still be reported.
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<script>
  window.__before = 1;
  throw new Error("boom");
</script>
<script>
  window.__after = 1;
</script>
<script defer src="data:text/javascript,window.__defer=1;window.__deferReport=JSON.stringify({before:window.__before,after:window.__after,defer:window.__defer})"></script>`;

test("a throwing classic script does not stop later scripts", async ({ page, cdpSession }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => (globalThis as { __deferReport?: string }).__deferReport !== undefined,
    { timeout: 20_000 },
  );
  expect(await readJsonReport(cdpSession, "globalThis.__deferReport")).toEqual({
    before: 1,
    after: 1,
    defer: 1,
  });
  expect(
    errors.some((text) => text.includes("boom")),
    "captured: " + JSON.stringify(errors),
  ).toBe(true);
}, 60_000);
