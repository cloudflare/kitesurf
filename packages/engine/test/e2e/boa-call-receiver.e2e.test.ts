// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("boa's call-site receiver reaches an unbound V8 function", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><script>
    window.handProbe = function (cb) {
      return cb(function () {
        "use strict";
        if (this === undefined || this === null) return String(this);
        if (this === window) return "window";
        return typeof this + ":" + (typeof this === "object" ? JSON.stringify(this) : String(this));
      });
    };
  </script>`,
  );
  const got = await page.evaluate(() => {
    const hand = Reflect.get(window, "handProbe");
    if (typeof hand !== "function") return "no probe";
    return hand((f: (this: unknown) => string) => [
      Reflect.apply(f, "abc", []),
      [0].map(f, 5)[0],
      Reflect.apply(f, true, []),
      Reflect.apply(f, null, []),
      Reflect.apply(f, globalThis, []),
      Reflect.apply(f, { k: 1 }, []),
      f(),
      f.call("abc"),
    ]);
  });
  expect(got).toEqual([
    "string:abc",
    "number:5",
    "boolean:true",
    "null",
    "window",
    'object:{"k":1}',
    "undefined",
    "string:abc",
  ]);
});
