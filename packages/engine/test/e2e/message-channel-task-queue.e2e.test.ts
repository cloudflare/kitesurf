// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect } from "vitest";

import { test } from "./harness";
import { setContent } from "./set-content";

test("a posted message does not wait behind overdue timers", async ({ page }) => {
  await setContent(
    page,
    `<p>ports</p><script>
      const seen = [];
      // Timers queued first, then a message: on the wheel the message
      // ran after all of them.
      for (let i = 0; i < 10; i++) setTimeout(() => seen.push("t"), 0);
      const c = new MessageChannel();
      c.port1.onmessage = () => {
        seen.push("m");
        // A microtask queued by the handler runs before the next task.
        void Promise.resolve().then(() => seen.push("micro"));
      };
      c.port2.postMessage(0);
      setTimeout(() => { globalThis.__order = seen.join(""); }, 50);
    </script>`,
  );
  await page.waitForFunction("typeof globalThis.__order === 'string'", { timeout: 10_000 });
  const order = (await page.evaluate("globalThis.__order")) as string;
  expect(order.indexOf("m")).toBeLessThan(order.lastIndexOf("t"));
  expect(order).toContain("mmicro");
});
