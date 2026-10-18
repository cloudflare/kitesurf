// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// webpack's runtime is page script (V8) but chunks it loads run on boa, so its
// `d` defines getters on boa objects, and a bundle's boot died on the proxy invariant.

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const V8_HELPERS = `<script>
  window.__wpD = (e, d) => {
    if (Array.isArray(d))
      for (var a = 0; a < d.length; ) {
        var b = d[a++], n = d[a++];
        var c = n === 0 ? { enumerable: true, value: d[a++] } : { enumerable: true, get: n };
        Object.prototype.hasOwnProperty.call(e, b) || Object.defineProperty(e, b, c);
      }
    else
      for (var k in d)
        Object.prototype.hasOwnProperty.call(d, k) &&
          !Object.prototype.hasOwnProperty.call(e, k) &&
          Object.defineProperty(e, k, { enumerable: true, get: d[k] });
  };
  window.__same = (a, b) => a === b;
  window.__redefineEnumerable = (o, k) => {
    Object.defineProperty(o, k, { enumerable: true });
    return o[k];
  };
  window.__descFromV8 = (o, k) => {
    const d = Object.getOwnPropertyDescriptor(o, k);
    return [typeof d.get, d.get(), d.enumerable, d.configurable].join(":");
  };
</script>`;

test("V8 defines a boa getter onto a boa object, as webpack's d does", async ({ page }) => {
  await setContent(page, V8_HELPERS, { waitUntil: "domcontentloaded" });

  const out = await page.evaluate(() => {
    const helper = (name: string) => {
      const f: unknown = Reflect.get(globalThis, name);
      if (typeof f !== "function") throw new Error(`missing ${name}`);
      return (...args: unknown[]) => Reflect.apply(f, undefined, args);
    };
    const g = {
      __wpD: helper("__wpD"),
      __same: helper("__same"),
      __descFromV8: helper("__descFromV8"),
      __redefineEnumerable: helper("__redefineEnumerable"),
    };
    const attempt = (f: () => unknown) => {
      try {
        return f();
      } catch (e) {
        return `threw: ${e instanceof Error ? e.message : String(e)}`;
      }
    };
    const fn = () => 1;
    const objectForm: Record<string, unknown> = {};
    const arrayForm: Record<string, unknown> = {};
    const viaDefine: Record<string, unknown> = {};
    const redefined: Record<string, unknown> = {};
    return {
      sameWrapper: g.__same(fn, fn),
      objectForm: attempt(() => {
        g.__wpD(objectForm, { A: () => "a", B: () => "b" });
        return `${objectForm.A}${objectForm.B}`;
      }),
      arrayForm: attempt(() => {
        g.__wpD(arrayForm, ["V", 0, 42, "G", () => "g"]);
        return `${arrayForm.V}${arrayForm.G}`;
      }),
      descFromV8: attempt(() => {
        g.__wpD(viaDefine, { K: () => "got" });
        return `${g.__descFromV8(viaDefine, "K")} ${g.__descFromV8(viaDefine, "K")}`;
      }),
      partialRedefine: attempt(() => {
        g.__wpD(redefined, { R: () => "kept" });
        return g.__redefineEnumerable(redefined, "R");
      }),
    };
  });

  expect(out.sameWrapper, "one boa function crosses as one V8 wrapper").toBe(true);
  expect(out.objectForm, "webpack d, object form").toBe("ab");
  expect(out.arrayForm, "webpack d, array form").toBe("42g");
  expect(out.descFromV8, "V8 reads the fixed accessor back, twice").toBe(
    "function:got:true:false function:got:true:false",
  );
  expect(out.partialRedefine, "a partial re-define keeps the fixed getter").toBe("kept");
});
