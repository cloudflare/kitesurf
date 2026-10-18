// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("checkVisibility reports boxless, transparent and hidden elements", async ({ page }) => {
  await setContent(
    page,
    `<div id="shown">a</div>
    <div style="display: none"><span id="underNone">b</span></div>
    <div id="contents" style="display: contents">c</div>
    <div style="opacity: 0"><span id="clear">d</span></div>
    <div id="hidden" style="visibility: hidden">e</div>
    <script>
      const $ = (id) => document.getElementById(id);
      window.__vis = JSON.stringify([
        $("shown").checkVisibility(),
        $("underNone").checkVisibility(),
        $("contents").checkVisibility(),
        $("clear").checkVisibility(),
        $("clear").checkVisibility({ checkOpacity: true }),
        $("hidden").checkVisibility(),
        $("hidden").checkVisibility({ checkVisibilityCSS: true }),
        document.createElement("div").checkVisibility(),
      ]);
    </script>`,
  );
  expect(await page.evaluate("JSON.parse(window.__vis)")).toEqual([
    true,
    false,
    false,
    true,
    false,
    true,
    false,
    false,
  ]);
});
