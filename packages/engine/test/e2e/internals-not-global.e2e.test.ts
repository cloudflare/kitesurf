// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The engine's in-isolate hooks live on one internals record, not as page globals
// (page-script/src/internal-state.ts). Pin that the page sees no stray `__ks*` names, and that
// the record itself stays out of for-in and can't be replaced.
import { expect, test } from "./harness";
import { setContent } from "./set-content";

// Called by name from the engine's rewritten module code, so they are still page globals.
const REMAINING_GLOBALS = ["__ks_import", "__ks_resolve_import_map"];

test("engine hooks are not page globals", async ({ page }) => {
  // An inline script runs in the page's own V8 realm, which is where a page would look.
  await setContent(
    page,
    `<script>
      const prefix = /^__(ks|KS|Ks|memprof)/;
      const key = Symbol.for("kitesurf.internals");
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
      document.body.dataset.out = JSON.stringify({
        globals: Object.getOwnPropertyNames(globalThis).filter((n) => prefix.test(n)).sort(),
        windowKeys: Object.keys(window).filter((n) => prefix.test(n)),
        recordIsObject: typeof globalThis[key] === "object",
        enumerable: descriptor && descriptor.enumerable,
        writable: descriptor && descriptor.writable,
        configurable: descriptor && descriptor.configurable,
        hookOnRecord: typeof globalThis[key].pumpDueTimers,
      });
    </script>`,
  );
  const out = JSON.parse(await page.evaluate(() => document.body.dataset.out ?? "null"));
  expect(out.globals).toEqual(REMAINING_GLOBALS);
  expect(out.windowKeys).toEqual([]);
  expect(out.recordIsObject).toBe(true);
  expect(out.enumerable).toBe(false);
  expect(out.writable).toBe(false);
  expect(out.configurable).toBe(false);
  expect(out.hookOnRecord).toBe("function");
});
