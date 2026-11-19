// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A fetch saved while a module initializes must keep working after the init shims drain.

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const LATER_FETCH_TIMEOUT_MS = 5_000;

test("a fetch saved during module init works after the shims drain", async ({ page }) => {
  await setContent(
    page,
    `<output id="startup">pending</output>
     <script type="module">
       const savedFetch = globalThis.fetch;
       globalThis.savedFetch = savedFetch;
       void savedFetch("data:text/plain,started").then(async (response) => {
         document.querySelector("#startup").textContent = await response.text();
       });
     </script>`,
  );

  await expect
    .poll(() => page.evaluate(() => document.querySelector("#startup")?.textContent), {
      timeout: 15_000,
    })
    .toBe("started");

  const later = await Promise.race([
    page.evaluate(`globalThis.savedFetch("data:text/plain,loaded").then((r) => r.text())`),
    new Promise((resolve) => setTimeout(() => resolve("timed-out"), LATER_FETCH_TIMEOUT_MS)),
  ]);
  expect(later).toBe("loaded");
}, 120_000);
