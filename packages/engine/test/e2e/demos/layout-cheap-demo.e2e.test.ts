// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { setContent } from "../set-content";

type LayoutRect = { x: number; y: number; w: number; h: number } | null;

function assertCheapRect(rect: LayoutRect, name: string): void {
  expect(!!rect && rect.h > 0, `${name} has non-zero height in off mode`).toBeTruthy();
}

function assertRectBelow(upper: LayoutRect, lower: LayoutRect, message: string): void {
  expect(!!lower && !!upper && lower.y > upper.y, message).toBeTruthy();
}

function assertInlineRect(spanRect: LayoutRect, paragraphRect: LayoutRect): void {
  expect(
    !!spanRect && !!paragraphRect && Math.abs(spanRect.y - paragraphRect.y) < 32,
    "inline span shares a line with its paragraph",
  ).toBeTruthy();
}

function assertFullModeRects(rects: { h: { h: number }; p: { h: number } }): void {
  expect(
    rects.h.h > 0 && rects.p.h > 0,
    "full mode rectangles remain non-zero after switching modes",
  ).toBe(true);
}

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
    assertCheapRect(hRect, "h1");
    assertCheapRect(pRect, "p");
    assertCheapRect(dRect, "div");
    assertRectBelow(hRect, pRect, "p stacks below h1");
    assertRectBelow(pRect, dRect, "div stacks below p");
    assertInlineRect(spanRect, pRect);

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
    assertFullModeRects(fullRects);

    const reply = await session.send("Kitesurf.getLayoutMode", {});
    expect(reply.mode, "Kitesurf.getLayoutMode reports full mode").toBe("full");
  } finally {
    await session.detach();
  }
});
