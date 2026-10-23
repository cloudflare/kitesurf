// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { setContent } from "../set-content";

// workerd disallows timers in global scope, so a top-level AbortSignal.timeout used to throw.
test("AbortSignal.timeout at module top level aborts with TimeoutError", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await setContent(
    page,
    `<!doctype html><script type="module">
    globalThis.__ksTimeout = { threw: null, initiallyAborted: null, reason: null, anyReason: null };
    try {
      const s = AbortSignal.timeout(50);
      const any = AbortSignal.any([s, new AbortController().signal]);
      globalThis.__ksTimeout.initiallyAborted = s.aborted;
      s.addEventListener("abort", () => {
        globalThis.__ksTimeout.reason = {
          name: s.reason.name,
          isDOMException: s.reason instanceof DOMException,
        };
      });
      any.addEventListener("abort", () => {
        globalThis.__ksTimeout.anyReason = any.reason.name;
      });
    } catch (e) {
      globalThis.__ksTimeout.threw = String(e && e.message);
    }
  </script>`,
  );

  const out: unknown = await page.evaluate(`(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return globalThis.__ksTimeout;
  })()`);

  expect(errors).toEqual([]);
  expect(out).toEqual({
    threw: null,
    initiallyAborted: false,
    reason: { name: "TimeoutError", isDOMException: true },
    anyReason: "TimeoutError",
  });
});
