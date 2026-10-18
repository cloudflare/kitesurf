// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Limitation: `setImmediate` is not exposed to page code, matching browsers.

import { expect } from "vitest";

import { test } from "./harness";
import { setContent } from "./set-content";

test("setImmediate and clearImmediate are absent, as in Chrome", async ({ page }) => {
  await setContent(
    page,
    `<script>globalThis.__seen = [typeof setImmediate, typeof clearImmediate, "setImmediate" in globalThis].join();</script>`,
  );
  const out = await page.evaluate(() => ({
    script: (globalThis as typeof globalThis & { __seen: string }).__seen,
    evaluate: [typeof setImmediate, typeof clearImmediate].join(),
  }));
  expect(out).toEqual({ script: "undefined,undefined,false", evaluate: "undefined,undefined" });
});
