// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("event-handler-hydration", async ({ page }) => {
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html>
      <body onresize="window.__resized = true">
        <div id="killed" onclick="window.__resurrected = true">x</div>
        <div id="alive" onclick="window.__alive = true">y</div>
        <script>
          // Null-assign BEFORE any click dispatch: takes ownership
          // of the slot; hydration must not compile the attribute.
          document.getElementById("killed").onclick = null;
        </script>
      </body>`),
  );

  const r = await page.evaluate(() => {
    const out: any = {};
    (window as any).__resurrected = false;
    (window as any).__alive = false;
    (window as any).__resized = false;

    document.getElementById("killed")!.dispatchEvent(new Event("click"));
    out.resurrected = (window as any).__resurrected;

    document.getElementById("alive")!.dispatchEvent(new Event("click"));
    out.alive = (window as any).__alive;

    window.dispatchEvent(new Event("resize"));
    out.resized = (window as any).__resized;
    return out;
  });

  expect(r.alive, "parser onclick hydrates on first dispatch").toBe(true);
  expect(r.resurrected, "null-assign must not resurrect the attribute").toBe(false);
  expect(r.resized, "body onresize forwards to the window handler").toBe(true);
});
