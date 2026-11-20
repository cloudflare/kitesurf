// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("V8 sees each Boa superclass when inheriting static metadata", async ({ page }) => {
  await setContent(
    page,
    `<script>
      globalThis.NativeBase = class {
        static properties = new Map([["base", true]]);
        static inheritProperties() {
          this.properties = new Map(Object.getPrototypeOf(this).properties);
        }
      };
      globalThis.inspectParent = (child, parent) => Object.getPrototypeOf(child) === parent;
    </script>`,
  );
  const out = await page.evaluate(`(() => {
    class Parent extends NativeBase {}
    Parent.inheritProperties();
    Parent.properties.set("parent", true);
    class Child extends Parent {}
    Child.inheritProperties();
    return {
      parent: inspectParent(Child, Parent),
      properties: [...Child.properties.keys()],
      baseProperties: [...NativeBase.properties.keys()],
    };
  })()`);
  expect(out).toEqual({ parent: true, properties: ["base", "parent"], baseProperties: ["base"] });
});

test("a Boa class chain deeper than the bridge's bound still links its nearest parents", async ({
  page,
}) => {
  await setContent(
    page,
    `<script>
      globalThis.NativeBase = class {};
      globalThis.inspectParent = (child, parent) => Object.getPrototypeOf(child) === parent;
    </script>`,
  );
  const out = await page.evaluate(`(() => {
    let parent = NativeBase;
    for (let i = 0; i < 100; i++) parent = class extends parent {};
    class Child extends parent {}
    return inspectParent(Child, parent);
  })()`);
  expect(out).toBe(true);
});

test("Boa async functions and generators keep V8's Function.prototype", async ({ page }) => {
  await setContent(
    page,
    `<script>
      globalThis.inspectFunction = (fn) => [
        Object.getPrototypeOf(fn) === Function.prototype,
        fn instanceof Function,
        fn.call === Function.prototype.call,
        fn.bind === Function.prototype.bind,
      ];
    </script>`,
  );
  const out = await page.evaluate(`({
    plain: inspectFunction(function () {}),
    arrow: inspectFunction(() => 1),
    asyncFunction: inspectFunction(async function () {}),
    asyncArrow: inspectFunction(async () => 1),
    generator: inspectFunction(function* () {}),
    asyncGenerator: inspectFunction(async function* () {}),
  })`);
  const all = [true, true, true, true];
  expect(out).toEqual({
    plain: all,
    arrow: all,
    asyncFunction: all,
    asyncArrow: all,
    generator: all,
    asyncGenerator: all,
  });
});
