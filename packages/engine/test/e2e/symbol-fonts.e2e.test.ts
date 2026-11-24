// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Symbol text must paint real glyphs however the page writes it: as numeric or named
// character references, or built by a script from escapes no source scan can see (#170).
import type { CDPSession, Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";
import { decodePng } from "./png";
import { setContent } from "./set-content";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

async function families(cdp: CDPSession): Promise<string[]> {
  const dump = await cdp.send("Kitesurf.getFontFaces");
  const targets = "byTarget" in dump ? Object.values(dump.byTarget) : [];
  return targets.flatMap((entry) => {
    if (typeof entry?.json !== "string") return [];
    const faces: unknown = JSON.parse(entry.json);
    if (!Array.isArray(faces)) return [];
    return faces.flatMap((face) =>
      isRecord(face) && typeof face.family === "string" ? [face.family] : [],
    );
  });
}

const CELL = 60;

// ↻ needs Noto Sans Math, ↑ Noto Sans Symbols, and ✓ and ▾ Noto Sans Symbols 2.
const GLYPHS = ["\u21BB", "\u2191", "\u2713", "\u25BE"];
const FACES = ["Noto Sans Symbols", "Noto Sans Symbols 2", "Noto Sans Math"];

const markup = (body: string) => `<style>
  body { margin: 0; background: #fff; color: #000; font: 40px sans-serif; }
  span { display: inline-block; width: ${CELL}px; height: ${CELL}px; line-height: ${CELL}px;
    text-align: center; vertical-align: top; }
</style>${body}`;

const spans = (refs: string[]) => refs.map((ref) => `<span>${ref}</span>`).join("");

// Each glyph sits in its own cell. Unmapped codepoints all paint the same tofu box, so four
// distinct cell bitmaps, each with ink, mean the symbol faces drew them.
async function cellBitmaps(target: Page): Promise<{ ink: number[]; distinct: number }> {
  const png = await decodePng(new Uint8Array(await target.screenshot({ type: "png" })));
  const ink: number[] = [];
  const bitmaps = new Set<string>();
  for (let cell = 0; cell < GLYPHS.length; cell++) {
    let count = 0;
    let bitmap = "";
    for (let y = 0; y < CELL; y++) {
      for (let x = cell * CELL; x < (cell + 1) * CELL; x++) {
        const dark = (png.data[(y * png.width + x) * 4] ?? 255) < 128;
        count += dark ? 1 : 0;
        bitmap += dark ? "1" : "0";
      }
    }
    ink.push(count);
    bitmaps.add(bitmap);
  }
  return { ink, distinct: bitmaps.size };
}

const CASES: [name: string, body: string][] = [
  ["numeric character references", spans(["&#x21BB;", "&#x2191;", "&#x2713;", "&#x25BE;"])],
  ["named character references", spans(["&orarr;", "&uarr;", "&check;", "&dtrif;"])],
  [
    "script-inserted text",
    `<div id=d></div><script>
      for (const c of ["\\u21BB", "\\u2191", "\\u2713", "\\u25BE"]) {
        const s = document.createElement("span");
        s.textContent = c;
        d.appendChild(s);
      }
    </script>`,
  ],
];

for (const [name, body] of CASES) {
  test(`symbols written as ${name} paint real glyphs`, async ({ page, cdpSession }) => {
    await page.setViewport({ width: GLYPHS.length * CELL, height: CELL });
    await setContent(page, markup(body));
    // The screenshot drains the faces the probe demands before it paints.
    const cells = await cellBitmaps(page);
    const loaded = await families(cdpSession);
    for (const family of FACES) {
      expect(loaded, `${family} registered`).toContain(family);
    }
    expect(cells.distinct, `ink per cell ${cells.ink.join(", ")}`).toBe(GLYPHS.length);
    for (const ink of cells.ink) expect(ink).toBeGreaterThan(0);
  });
}
