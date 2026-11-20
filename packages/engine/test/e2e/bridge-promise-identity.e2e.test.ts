// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const NATIVE_PROMISES = `<script>
  const attached = Symbol("attached");
  globalThis.resolved = Promise.resolve("ready");
  resolved[attached] = "data";
  globalThis.rejected = Promise.reject(new Error("no"));
  rejected.catch(() => {});
  globalThis.inspectPromise = (promise, original) => ({
    same: promise === original,
    attached: promise[attached],
  });
</script>`;

test("a V8 promise keeps its identity and attached properties across Boa", async ({ page }) => {
  await setContent(page, NATIVE_PROMISES);
  const out = await page.evaluate(`(async () => {
    const promise = resolved;
    return {
      before: inspectPromise(promise, resolved),
      value: await promise,
      after: inspectPromise(promise, resolved),
    };
  })()`);
  expect(out).toEqual({
    before: { same: true, attached: "data" },
    value: "ready",
    after: { same: true, attached: "data" },
  });
});

test("a rejected V8 promise keeps its identity across Boa", async ({ page }) => {
  await setContent(page, NATIVE_PROMISES);
  const out = await page.evaluate(`(async () => {
    const promise = rejected;
    let reason;
    try { await promise; } catch (e) { reason = e.message; }
    return { reason, same: inspectPromise(promise, rejected).same };
  })()`);
  expect(out).toEqual({ reason: "no", same: true });
});

test("a Boa-created promise is not mistaken for a native one", async ({ page }) => {
  await setContent(page, NATIVE_PROMISES);
  const out = await page.evaluate(`(async () => {
    const own = Promise.resolve("boa");
    const seen = inspectPromise(own, resolved);
    return { seen, value: await own };
  })()`);
  expect(out).toEqual({ seen: { same: false }, value: "boa" });
});
