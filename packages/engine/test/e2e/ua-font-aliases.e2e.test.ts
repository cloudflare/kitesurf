// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The macos font profile maps families as Chrome on macOS does: Arimo behind sans-serif,
// Arial and Helvetica, Inter behind system-ui and -apple-system, Tinos behind serif and Times
// New Roman, Gelasio behind Georgia. Arimo, Tinos and Gelasio share Arial's, Times New Roman's
// and Georgia's advances, so the expected widths are those fonts' hmtx sums for TEXT at 32px.
import type { Browser, CDPSession, Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";
import { bbox, decodePng } from "./png";
import { setContent } from "./set-content";

const TEXT = "Hamburgefonstiv 0123";
const ARIAL_WIDTH = 321.97;
const TIMES_WIDTH = 295.95;
const TIMES_BOLD_WIDTH = 312;
const TIMES_ITALIC_WIDTH = 294.2;
const GEORGIA_WIDTH = 324.94;
// U+A7C0 is in Noto Sans only, so this line pulls the Latn script face in.
const LATIN_EXT = "Hamburg\uA7C0";
const MACOS = "?ks_font_profile=macos";

const LINE_IDS = [
  "sans",
  "arial",
  "helvetica",
  "segoe",
  "ui",
  "apple",
  "serif",
  "times",
  "missing",
  "bold",
  "italic",
  "serifItalic",
  "georgia",
  "latinExt",
] as const;
type LineId = (typeof LINE_IDS)[number];

const LINES = {
  sans: "sans-serif",
  arial: "Arial",
  helvetica: "Helvetica",
  segoe: `"Segoe UI", sans-serif`,
  ui: "system-ui",
  apple: "-apple-system",
  serif: "serif",
  times: `"Times New Roman"`,
  missing: "NoSuchFont",
  bold: "serif; font-weight: bold",
  italic: "sans-serif; font-style: italic",
  serifItalic: "serif; font-style: italic",
  georgia: "Georgia",
  latinExt: "sans-serif",
} satisfies Record<LineId, string>;

const MARKUP = `<style>
  body { margin: 0; background: #fff; color: #000; font-size: 32px; }
  p { margin: 0; height: 40px; white-space: nowrap; }
</style>
${LINE_IDS.map(
  (id) =>
    `<p><span id=${id} style='font-family: ${LINES[id]}'>${id === "latinExt" ? LATIN_EXT : TEXT}</span></p>`,
).join("\n")}`;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

interface Face {
  family: string;
  styles: string[];
}

// Kitesurf.getFontFaces carries each target's families as a JSON string.
async function faces(cdp: CDPSession): Promise<Face[]> {
  const dump = await cdp.send("Kitesurf.getFontFaces");
  const targets = "byTarget" in dump ? Object.values(dump.byTarget) : [];
  return targets.flatMap((entry) => {
    if (typeof entry?.json !== "string") return [];
    const families: unknown = JSON.parse(entry.json);
    if (!Array.isArray(families)) return [];
    return families.flatMap((family) => {
      if (!isRecord(family) || typeof family.family !== "string") return [];
      const styles = Array.isArray(family.faces)
        ? family.faces.flatMap((face) =>
            isRecord(face) && typeof face.style === "string" ? [face.style] : [],
          )
        : [];
      return [{ family: family.family, styles }];
    });
  });
}

async function widths(page: Page): Promise<(id: LineId) => number> {
  const raw: unknown = await page.evaluate(`(() => Object.fromEntries(
    ${JSON.stringify(LINE_IDS)}.map((id) =>
      [id, document.getElementById(id).getBoundingClientRect().width])
  ))()`);
  return (id) => {
    const v: unknown = isRecord(raw) ? raw[id] : undefined;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`${id}: expected a number, got ${String(v)}`);
    }
    return v;
  };
}

function expectNear(actual: number, expected: number, label: string, tolerance = 1): void {
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThan(tolerance);
}

async function loadMarkup(browser: Browser, markup = MARKUP): Promise<Page> {
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await page.setViewport({ width: 600, height: 560 });
  await setContent(page, markup);
  return page;
}

async function pageFaces(page: Page): Promise<Face[]> {
  const cdp = await page.createCDPSession();
  try {
    return await faces(cdp);
  } finally {
    await cdp.detach();
  }
}

test("platform family names resolve to the macOS-like UA faces", async ({ browserFactory }) => {
  const page = await loadMarkup(await browserFactory({ query: MACOS }));

  const registered = await pageFaces(page);
  const byName = new Map(registered.map((f) => [f.family, f.styles]));
  const names = registered.map((f) => f.family).join(", ");
  for (const family of ["Arimo", "Arial", "Helvetica", "Inter Variable", "-apple-system"]) {
    expect(byName.get(family), `${family} in ${names}`).toEqual(
      expect.arrayContaining(["Normal", "Italic"]),
    );
  }
  for (const family of ["Tinos", "Times New Roman", "Georgia"]) {
    expect(byName.get(family), `${family} in ${names}`).toEqual(
      expect.arrayContaining(["Normal", "Italic"]),
    );
  }
  expect(byName.has("Noto Sans"), `Noto Sans in ${names}`).toBe(true);
  expect(byName.has("Segoe UI")).toBe(false);

  const w = await widths(page);
  for (const id of ["sans", "arial", "helvetica", "segoe"] as const) {
    expectNear(w(id), ARIAL_WIDTH, id);
  }
  expect(w("apple")).toBe(w("ui"));
  expect(Math.abs(w("ui") - w("sans"))).toBeGreaterThan(10);
  expectNear(w("serif"), TIMES_WIDTH, "serif");
  expect(w("times")).toBe(w("serif"));
  // A family list that matches nothing lands on the fallback chain, which Arimo leads. Chrome
  // draws it in its standard font, Times; blitz does not end such a list on serif.
  expect(w("missing")).toBe(w("sans"));
  // A real bold face, not a synthesized one, which keeps regular advances.
  expectNear(w("bold"), TIMES_BOLD_WIDTH, "bold");
  // Arimo's italic keeps Arial's advances, so only the glyphs tell it apart.
  expectNear(w("italic"), ARIAL_WIDTH, "italic");
  // Tinos Italic has its own advances, and kerns more than the upright; a
  // synthesized slant would keep the upright's width.
  expectNear(w("serifItalic"), TIMES_ITALIC_WIDTH, "serifItalic", 1.5);
  expect(w("serif") - w("serifItalic")).toBeGreaterThan(1.5);
  expectNear(w("georgia"), GEORGIA_WIDTH, "georgia");

  // The renderer paints each face from the asset it fetches by path; ink in
  // every line means each path resolved, where an unknown one paints nothing.
  const png = await decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
  LINE_IDS.forEach((id, line) => {
    const width = w(id);
    const ink = bbox(png, line * 40, line * 40 + 40, (r, g, b) => r < 96 && g < 96 && b < 96);
    expect(ink, `no ink in the ${id} line`).not.toBeNull();
    expect(ink?.w ?? 0, id).toBeGreaterThan(width * 0.8);
  });
  const row = (id: LineId): Uint8Array => {
    const line = LINE_IDS.indexOf(id);
    const stride = png.width * 4 * 40;
    return png.data.subarray(line * stride, (line + 1) * stride);
  };
  expect(row("italic")).not.toEqual(row("sans"));
});

test("Noto Sans loads only for the codepoints the UA faces lack", async ({ browserFactory }) => {
  const page = await loadMarkup(
    await browserFactory({ query: MACOS }),
    `<p style="font-family: sans-serif">${TEXT}</p>`,
  );
  const names = (await pageFaces(page)).map((f) => f.family);
  expect(names, names.join(", ")).not.toContain("Noto Sans");
});

test("a pixel-free session shapes the UA faces identically", async ({ browserFactory }) => {
  // Pixel-free sessions fetch the .shaping.otf variants instead of the full files; the stripped
  // tables must not move a single advance.
  const paint = await widths(await loadMarkup(await browserFactory({ query: MACOS })));
  const pixelFree = await widths(
    await loadMarkup(
      await browserFactory({ query: MACOS, headers: { "x-kitesurf-skip-raster": "1" } }),
    ),
  );
  expect(LINE_IDS.map(pixelFree)).toEqual(LINE_IDS.map(paint));
});
