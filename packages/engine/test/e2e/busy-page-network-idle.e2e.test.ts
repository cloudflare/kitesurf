// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

// A page that keeps scheduling short tasks, as a framework retrying a render does, must not stall
// the engine's own timers: network idle depends on the network, so it fires while script runs.
const SLICES = 600;

test("network idle fires while a page stays busy in short tasks", async ({ page }) => {
  await setContent(
    page,
    `<!DOCTYPE html><script>
      window.__slices = 0;
      const work = () => {
        let x = 0;
        for (let i = 0; i < 5e6; i++) x += i % 7;
        window.__sink = x;
        window.__slices++;
        if (window.__slices < ${SLICES}) setTimeout(work, 0);
      };
      setTimeout(work, 0);
    </script>`,
    { waitUntil: "networkidle0", timeout: 60_000 },
  );
  const slicesAtIdle = Number(await page.evaluate("window.__slices"));
  expect(slicesAtIdle).toBeLessThan(SLICES);
}, 120_000);
