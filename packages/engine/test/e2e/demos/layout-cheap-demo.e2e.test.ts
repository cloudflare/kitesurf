// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { setContent } from "../set-content";

test("cheap layout returns ordered rectangles and restores full mode", async ({ page }) => {
  const session = await page.target().createCDPSession();
  const html = `<!doctype html>
    <html><head><title>cheap layout</title></head><body>
    <h1 id="h">Top heading</h1>
    <p id="p">Paragraph one with <span id="s">inline span</span> inside.</p>
    <div id="d">Box element</div>
    </body></html>
  `;

  try {
    const offMode = await session.send("Kitesurf.setLayoutMode", { mode: "off" });
    expect(offMode.mode, "layout mode is off before measuring cheap rectangles").toBe("off");
    await setContent(page, html);

    const rects = await page.evaluate(() => {
      const ids = ["h", "p", "s", "d"];
      const out: Record<string, { x: number; y: number; w: number; h: number } | null> = {};
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) {
          out[id] = null;
          continue;
        }
        const r = el.getBoundingClientRect();
        out[id] = { x: r.x, y: r.y, w: r.width, h: r.height };
      }
      return out;
    });

    const hRect = rects.h;
    const pRect = rects.p;
    const spanRect = rects.s;
    const dRect = rects.d;
    expect(!!hRect && hRect.h > 0, "h1 has non-zero height in off mode").toBeTruthy();
    expect(!!pRect && pRect.h > 0, "p has non-zero height in off mode").toBeTruthy();
    expect(!!dRect && dRect.h > 0, "div has non-zero height in off mode").toBeTruthy();
    expect(!!pRect && !!hRect && pRect.y > hRect.y, "p stacks below h1").toBeTruthy();
    expect(!!dRect && !!pRect && dRect.y > pRect.y, "div stacks below p").toBeTruthy();
    expect(
      !!spanRect && !!pRect && Math.abs(spanRect.y - pRect.y) < 32,
      "inline span shares a line with its paragraph",
    ).toBeTruthy();

    await session.send("Kitesurf.setLayoutMode", { mode: "full" });
    await setContent(page, html);

    const fullRects = await page.evaluate(() => {
      const h = document.getElementById("h")!.getBoundingClientRect();
      const p = document.getElementById("p")!.getBoundingClientRect();
      return {
        h: { x: h.x, y: h.y, w: h.width, h: h.height },
        p: { x: p.x, y: p.y, w: p.width, h: p.height },
      };
    });
    expect(
      fullRects.h.h > 0 && fullRects.p.h > 0,
      "full mode rectangles remain non-zero after switching modes",
    ).toBe(true);

    const reply = await session.send("Kitesurf.getLayoutMode", {});
    expect(reply.mode, "Kitesurf.getLayoutMode reports full mode").toBe("full");
  } finally {
    await session.detach();
  }
});
