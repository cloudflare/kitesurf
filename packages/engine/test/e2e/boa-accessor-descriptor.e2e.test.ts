// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("page code reads a boa accessor back as an accessor", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><title>t</title><script>
    var s = document.createElement("script");
    s.textContent = "var calls = 0; window.boaProps = { plain: 1, get value() { calls++; return 'v'; }, set value(x) { window.boaSet = x; } };";
    document.head.appendChild(s);
    setTimeout(function () {
      var d = Object.getOwnPropertyDescriptor(window.boaProps, "value");
      d.set("typed");
      document.title = JSON.stringify({
        get: typeof d.get, set: typeof d.set, hasValue: "value" in d, getterRan: window.calls,
        boaSet: window.boaSet, plain: Object.getOwnPropertyDescriptor(window.boaProps, "plain").value,
      });
    }, 100);
  </script>`,
  );
  await page.waitForFunction(() => document.title.startsWith("{"), { timeout: 20_000 });
  expect(JSON.parse(await page.title())).toEqual({
    get: "function",
    set: "function",
    hasValue: false,
    getterRan: 0,
    boaSet: "typed",
    plain: 1,
  });
}, 60_000);
