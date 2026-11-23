// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A browser runs every queued microtask before the next parser script, so a promise chain one
// script starts has finished by the time the next one runs. Counting microtask turns cannot
// bound a chain, and a shallow count let the next script read an unfinished one.
import { expect, test } from "./harness";
import { setContent } from "./set-content";

const html = `<script>
  async function step() { await null; }
  (async () => { await step(); await step(); await step(); window.ready = 1; })();
</script>
<script>document.title = String(window.ready);</script>`;

test("the next parser script sees a finished promise chain", async ({ page }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await page.title()).toBe("1");
}, 60_000);
