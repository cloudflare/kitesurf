// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A codepoint with both text and emoji forms paints in color only when it asks for emoji
// presentation: by default (U+231A) or with VS16. Text-default arrows, alone or with VS15,
// paint as text even though the color emoji face also maps them.
import type { Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";
import { decodePng } from "./png";
import { setContent } from "./set-content";

const CELL = 60;

const CASES: [label: string, ref: string, color: boolean][] = [
  ["U+2194", "&#x2194;", false],
  ["U+2194 VS15", "&#x2194;&#xFE0E;", false],
  ["U+21A9", "&#x21A9;", false],
  ["U+2194 VS16", "&#x2194;&#xFE0F;", true],
  ["U+21A9 VS16", "&#x21A9;&#xFE0F;", true],
  ["U+231A", "&#x231A;", true],
];

const MARKUP = `<style>
  body { margin: 0; background: #fff; color: #000; font: 40px sans-serif; }
  span { display: inline-block; width: ${CELL}px; height: ${CELL}px; line-height: ${CELL}px;
    text-align: center; vertical-align: top; overflow: hidden; }
</style>${CASES.map(([, ref]) => `<span>${ref}</span>`).join("")}`;

// Black text on white antialiases to grays; a color glyph has saturated pixels.
async function cells(page: Page): Promise<{ ink: number; colored: number }[]> {
  const png = await decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
  return CASES.map((_, cell) => {
    let ink = 0;
    let colored = 0;
    for (let y = 0; y < CELL; y++) {
      for (let x = cell * CELL; x < (cell + 1) * CELL; x++) {
        const o = (y * png.width + x) * 4;
        const [r, g, b] = [png.data[o] ?? 255, png.data[o + 1] ?? 255, png.data[o + 2] ?? 255];
        if (Math.min(r, g, b) < 200) ink++;
        if (Math.max(r, g, b) - Math.min(r, g, b) > 60) colored++;
      }
    }
    return { ink, colored };
  });
}

test("only emoji-presentation clusters paint in color", async ({ page }) => {
  await page.setViewport({ width: CASES.length * CELL, height: CELL });
  await setContent(page, MARKUP);
  const measured = await cells(page);
  CASES.forEach(([label, , color], i) => {
    const cell = measured[i] ?? { ink: 0, colored: 0 };
    expect(cell.ink, `${label} paints a glyph`).toBeGreaterThan(0);
    expect(cell.colored > 0, `${label}: ${cell.colored} colored pixels`).toBe(color);
  });
});
