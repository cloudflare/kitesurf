// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("V8 finds undefined Boa properties without invoking getters", async ({ page }) => {
  await setContent(page, `<script>globalThis.nativeHas = (object, key) => key in object;</script>`);
  const out = await page.evaluate(`(() => {
    let reads = 0;
    class Parent {
      get pending() { reads++; return undefined; }
    }
    const key = Symbol("pending");
    Parent.prototype[key] = undefined;
    const instance = new Parent();
    instance.own = undefined;
    return {
      own: nativeHas(instance, "own"),
      inherited: nativeHas(instance, "pending"),
      symbol: nativeHas(instance, key),
      missing: nativeHas(instance, "missing"),
      reads,
    };
  })()`);
  expect(out).toEqual({ own: true, inherited: true, symbol: true, missing: false, reads: 0 });
});
