// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

test("null/undefined property access names the key", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/dynimport.html", {
    waitUntil: "load",
    timeout: 30000,
  });

  const out = await page.evaluate(`(() => {
    const grab = (f) => { try { return f(); } catch (e) { return String(e); } };
    return {
      primitiveRead: grab(() => "str".length),
      primitiveCall: grab(() => (5).toFixed(1)),
      undefRead: grab(() => { const x = undefined; return x.foo; }),
      nullRead: grab(() => { const x = null; return x.foo; }),
      undefComputed: grab(() => { const x = undefined; return x["bar"]; }),
      undefWrite: grab(() => { const x = undefined; x.mode = 1; }),
      nullWriteComputed: grab(() => { const x = null; x["k"] = 1; }),
    };
  })()`);

  expect(out).toStrictEqual({
    primitiveRead: 3,
    primitiveCall: "5.0",
    undefRead: "TypeError: cannot read properties of undefined (reading 'foo')",
    nullRead: "TypeError: cannot read properties of null (reading 'foo')",
    undefComputed: "TypeError: cannot read properties of undefined (reading 'bar')",
    undefWrite: "TypeError: cannot set properties of undefined (setting 'mode')",
    nullWriteComputed: "TypeError: cannot set properties of null (setting 'k')",
  });
});
