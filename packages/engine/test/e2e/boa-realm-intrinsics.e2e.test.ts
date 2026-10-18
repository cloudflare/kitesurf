// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const markup = `<script>
  window.__probe = function (o) {
    var ctor = o != null && o.constructor;
    return {
      ctorName: ctor && ctor.name,
      isV8Object: ctor === Object,
      isV8Array: ctor === Array,
      // paper.js's exact predicate.
      paperIsPlainObject: !!(ctor && (ctor === Object || ctor.name === "Object")),
    };
  };
  window.__ctorRoundTrips = function (o) {
    // The remapped constructor still has to be callable, not just
    // identity-correct.
    var made = new o.constructor();
    return typeof made === "object" && Object.keys(made).length === 0;
  };
  window.__namedCtor = function (o) {
    return o.constructor.name;
  };
<\/script>`;

test("a boa-born object presents V8's intrinsic as its constructor", async ({ page }) => {
  await setContent(page, markup, { waitUntil: "domcontentloaded" });

  const out = await page.evaluate(() => {
    const g = globalThis as any;
    return {
      plainObject: g.__probe({ insert: false }),
      array: g.__probe([1, 2, 3]),
      map: g.__probe(new Map()),
      date: g.__probe(new Date(0)),
      objectRoundTrips: g.__ctorRoundTrips({ a: 1 }),
    };
  });

  expect(out.plainObject).toEqual({
    ctorName: "Object",
    isV8Object: true,
    isV8Array: false,
    paperIsPlainObject: true,
  });
  expect(out.array).toEqual({
    ctorName: "Array",
    isV8Object: false,
    isV8Array: true,
    paperIsPlainObject: false,
  });
  expect(out.map.ctorName).toBe("Map");
  expect(out.date.ctorName).toBe("Date");
  expect(out.objectRoundTrips).toBe(true);
});

test("a page's own constructor is not remapped to an intrinsic", async ({ page }) => {
  await setContent(page, markup, { waitUntil: "domcontentloaded" });

  const out = await page.evaluate(() => {
    const g = globalThis as any;
    function Widget(this: any) {
      this.kind = "widget";
    }
    const w = new (Widget as any)();
    return {
      name: g.__namedCtor(w),
      probe: g.__probe(w),
      subclassName: g.__namedCtor(new (class Bag extends Array {})()),
    };
  });

  expect(out.name).toBe("Widget");
  expect(out.probe.isV8Object).toBe(false);
  expect(out.probe.ctorName).toBe("Widget");
  expect(out.subclassName).toBe("Bag");
});

test("an intrinsic stored on a bridged object keeps its boa identity", async ({ page }) => {
  await setContent(page, markup, { waitUntil: "domcontentloaded" });

  expect(
    await page.evaluate(() => {
      const node = document.createElement("div");
      (node as any).ctor = Object;
      return (node as any).ctor === Object;
    }),
  ).toBe(true);
});
