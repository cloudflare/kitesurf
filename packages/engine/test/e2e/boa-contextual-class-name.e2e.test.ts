// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("an inserted script may name a class of, get or async", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><title>t</title><script>
    var s = document.createElement("script");
    s.textContent = "class of extends Array { tag() { return 'of'; } } var get = class get {}; window.parsed = new of().tag() + ':' + get.name + ':' + (class async {}).name;";
    document.head.appendChild(s);
    setTimeout(function () { document.title = "done " + window.parsed; }, 100);
  </script>`,
  );
  await page.waitForFunction(() => document.title.startsWith("done"), { timeout: 20_000 });
  expect(await page.title()).toBe("done of:get:async");
}, 60_000);
