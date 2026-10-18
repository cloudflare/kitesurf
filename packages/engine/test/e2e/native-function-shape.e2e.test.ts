// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("engine functions stringify as native code under their own names", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><title>t</title><script>
    var F = Function.prototype.toString;
    function pageFn(a) { return a + 1; }
    var d = Object.getOwnPropertyDescriptor(Node.prototype, "firstChild");
    document.title = JSON.stringify({
      timeout: F.call(setTimeout),
      timeoutName: setTimeout.name,
      rafViaWindow: F.call(window.requestAnimationFrame),
      createElement: F.call(document.createElement),
      getter: F.call(d.get),
      fn: [Function.name, F.call(Function)],
      toStringItself: F.call(F),
      page: F.call(pageFn),
      pageArrow: String(() => 1),
    });
  </script>`,
  );
  expect(JSON.parse(await page.title())).toEqual({
    timeout: "function setTimeout() { [native code] }",
    timeoutName: "setTimeout",
    rafViaWindow: "function requestAnimationFrame() { [native code] }",
    createElement: "function createElement() { [native code] }",
    getter: "function get firstChild() { [native code] }",
    fn: ["Function", "function Function() { [native code] }"],
    toStringItself: "function toString() { [native code] }",
    page: "function pageFn(a) { return a + 1; }",
    pageArrow: "() => 1",
  });
}, 60_000);
