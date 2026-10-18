// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("V8 `new` on a boa constructor runs boa's [[Construct]]", async ({ browser }) => {
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await setContent(
    page,
    `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>kitesurf bridge construct fixture</title></head>
<body>
<script>
  globalThis.__ksNewFromV8 = function (Ctor, arg) {
    try {
      var inst = new Ctor(arg);
      return {
        sawProtoMethod: inst.sawProtoMethod,
        methodCallable: typeof inst.m === "function",
        methodResult: typeof inst.m === "function" ? inst.m() : null,
        ctorArg: inst.arg,
      };
    } catch (e) {
      return { threw: String(e && e.message || e) };
    }
  };
</script>
</body>
</html>`,
    { waitUntil: "domcontentloaded" },
  );

  const out = await page.evaluate(() => {
    function Widget(this: any, arg: unknown) {
      this.sawProtoMethod = typeof this.m === "function";
      this.arg = arg;
    }
    Widget.prototype.m = function () {
      return "from-proto";
    };
    return (globalThis as any).__ksNewFromV8(Widget, "seed");
  });

  expect(out.threw).toBeUndefined();
  expect(out.sawProtoMethod).toBe(true);
  expect(out.methodCallable).toBe(true);
  expect(out.methodResult).toBe("from-proto");
  expect(out.ctorArg).toBe("seed");
});
