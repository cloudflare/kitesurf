// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

test("an eager img joining an inflight lazy fetch re-arms the load gate", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/lazy-coalesce.html", {
    waitUntil: "load",
    timeout: 30000,
  });

  const state = (await page.evaluate(`
    (() => {
      const eager = document.getElementById("eager");
      return {
        eagerPresent: !!eager,
        eagerComplete: !!(eager && eager.complete),
      };
    })()
  `)) as { eagerPresent: boolean; eagerComplete: boolean };
  expect(state.eagerPresent).toBe(true);
  expect(state.eagerComplete).toBe(true);
});
