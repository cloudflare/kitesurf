// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("a function the page stores on window reads back as itself", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><title>t</title><script>
    var arrow = () => {}; window.setTimeout = arrow;
    var method = ({ m() {} }).m; window.requestAnimationFrame = method;
    var bound = function () {}.bind(null); window.addEventListener = bound;
    var viaBoa = new Function("a", "var f = function () {}; a.setInterval = f; return a.setInterval === f;")(window);
    document.title = JSON.stringify([window.setTimeout === arrow, window.requestAnimationFrame === method, window.addEventListener === bound, viaBoa]);
  </script>`,
  );
  expect(JSON.parse(await page.title())).toEqual([true, true, true, true]);
}, 60_000);

test("a bound or proxied function stored on window reads back as itself", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><title>t</title><script>
    var fresh = function () {}.bind(null); window.pageHook = fresh;
    var proxied = new Proxy(() => {}, {}); window.pageProxy = proxied;
    document.title = JSON.stringify([window.pageHook === fresh, window.pageProxy === proxied]);
  </script>`,
  );
  expect(JSON.parse(await page.title())).toEqual([true, true]);
}, 60_000);
