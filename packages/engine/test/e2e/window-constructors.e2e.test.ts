// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("constructors read through the window keep their prototype", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><title>t</title><script>
    function Base() {}
    function Child() {}
    Child.prototype = Object.create(Base.prototype);
  </script><script>
    var r = {
      fnProto: typeof self.Function.prototype,
      fnToString: typeof self.Function.prototype.toString,
      nativeCheck: /native code/.test(self.Function.prototype.toString.call(Object)),
      child: self.Child === Child && new self.Child() instanceof Base,
      timer: typeof self.setTimeout(function () {}, 0),
    };
    document.title = JSON.stringify(r);
  </script>`,
  );
  expect(JSON.parse(await page.title())).toEqual({
    fnProto: "function",
    fnToString: "function",
    nativeCheck: true,
    child: true,
    timer: "number",
  });
}, 60_000);
