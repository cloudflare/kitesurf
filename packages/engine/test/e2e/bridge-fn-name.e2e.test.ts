// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A boa function crosses to V8 as a trampoline, so its `name` and `length`
// must come from the boa function. Otherwise a boa Float32Array's
// `constructor.name` reads "", and code that classifies buffers by
// constructor name takes floats for integers.

import { test } from "./harness";
import { expect } from "vitest";
import { setContent } from "./set-content";

test("boa function name/length survive the bridge to V8", async ({ browser }) => {
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await setContent(
    page,
    `<!doctype html>
<html>
<body>
<script>
  // V8-side reader: receives boa-created values, reads introspection
  // that lives on the V8 wrapper.
  globalThis.__ksReadFromV8 = function (o) {
    return {
      fnName: o.fn.name,
      fnLen: o.fn.length,
      f32Name: o.f32.constructor && o.f32.constructor.name,
      u16Name: o.u16.constructor && o.u16.constructor.name,
      f32BPE: o.f32.BYTES_PER_ELEMENT,
    };
  };
</script>
</body>
</html>`,
    { waitUntil: "domcontentloaded" },
  );

  // page.evaluate runs on boa (fact 1), so these objects are boa-native
  // and cross the bridge into the V8 reader.
  const out = await page.evaluate(() => {
    function namedFn(_a: unknown, _b: unknown) {}
    const read: unknown = Reflect.get(globalThis, "__ksReadFromV8");
    if (typeof read !== "function") throw new Error("__ksReadFromV8 is not installed");
    const result: unknown = read({
      fn: namedFn,
      f32: new Float32Array(2),
      u16: new Uint16Array(2),
    });
    return result;
  });

  expect(out).toEqual({
    fnName: "namedFn",
    fnLen: 2,
    f32Name: "Float32Array",
    u16Name: "Uint16Array",
    f32BPE: 4,
  });
});
