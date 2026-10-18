// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("Highlight and CSS.highlights behave as setlike and maplike", async ({ page }) => {
  await setContent(
    page,
    `<p id="p">hello</p>
    <script>
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("p"));
      const hl = new Highlight(range);
      CSS.highlights.set("search", hl);
      let rejected = false;
      try { CSS.highlights.set("bad", {}); } catch (e) { rejected = e instanceof TypeError; }
      window.__hl = JSON.stringify({
        size: hl.size,
        has: hl.has(range),
        priority: hl.priority,
        type: hl.type,
        same: CSS.highlights.get("search") === hl,
        registry: CSS.highlights instanceof HighlightRegistry,
        fromPoint: CSS.highlights.highlightsFromPoint(0, 0).length,
        rejected,
      });
    </script>`,
  );
  expect(await page.evaluate("JSON.parse(window.__hl)")).toEqual({
    size: 1,
    has: true,
    priority: 0,
    type: "highlight",
    same: true,
    registry: true,
    fromPoint: 0,
    rejected: true,
  });
});
