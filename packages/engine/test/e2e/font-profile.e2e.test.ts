// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The font profile picks the UA faces. The e2e engine leaves KITESURF_FONT_PROFILE empty, so
// the default is noto; `?ks_font_profile=macos` switches a connection to the macOS-like faces.
import type { Browser, CDPSession, Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";
import { bbox, decodePng } from "./png";
import { setContent } from "./set-content";

const MARKUP = `<style>
  body { margin: 0; background: #fff; color: #000; font-size: 32px; }
  p { margin: 0; white-space: nowrap; }
</style>
<p><span id=sans style="font-family: sans-serif">Hamburgefonstiv 0123</span></p>
<p><span id=ui style="font-family: system-ui">Hamburgefonstiv 0123</span></p>
<p><i id=italic style="font-family: sans-serif">Hamburgefonstiv 0123</i></p>`;

const MACOS = "?ks_font_profile=macos";

interface Face {
  family: string;
  styles: string[];
}

interface Widths {
  sans: number;
  ui: number;
  italic: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

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

async function pageFaces(page: Page): Promise<Face[]> {
  const cdp = await page.createCDPSession();
  try {
    return await faces(cdp);
  } finally {
    await cdp.detach();
  }
}

async function widths(page: Page): Promise<Widths> {
  const raw: unknown = await page.evaluate(`(() => {
    const w = (id) => document.getElementById(id).getBoundingClientRect().width;
    return { sans: w("sans"), ui: w("ui"), italic: w("italic") };
  })()`);
  const num = (key: keyof Widths): number => {
    const v: unknown = isRecord(raw) ? raw[key] : undefined;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`${key}: expected a number, got ${String(v)}`);
    }
    return v;
  };
  return { sans: num("sans"), ui: num("ui"), italic: num("italic") };
}

async function loadMarkup(browser: Browser): Promise<Page> {
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await page.setViewport({ width: 600, height: 200 });
  await setContent(page, MARKUP);
  return page;
}

test("the default profile keeps Noto Sans behind the sans generics", async ({ browser }) => {
  const page = await loadMarkup(browser);
  const families = (await pageFaces(page)).map((f) => f.family);
  expect(families).toContain("Noto Sans");
  for (const family of ["Arimo", "Arial", "Inter Variable", "Tinos"]) {
    expect(families).not.toContain(family);
  }
  const m = await widths(page);
  // Noto Sans sits behind system-ui too.
  expect(m.ui).toBe(m.sans);
});

test("?ks_font_profile=macos puts Arimo behind sans-serif and Inter behind system-ui", async ({
  browser,
  browserFactory,
}) => {
  const noto = await widths(await loadMarkup(browser));

  const macosPage = await loadMarkup(await browserFactory({ query: MACOS }));
  const registered = await pageFaces(macosPage);
  const names = registered.map((f) => f.family).join(", ");
  for (const family of ["Arimo", "Inter Variable"]) {
    // Upright and italic share the family, so <i> gets the real italic.
    expect(registered.find((f) => f.family === family)?.styles, `${family} in ${names}`).toEqual(
      expect.arrayContaining(["Normal", "Italic"]),
    );
  }
  expect(names).not.toContain("Noto Sans");

  const m = await widths(macosPage);
  expect(Math.abs(m.sans - noto.sans)).toBeGreaterThan(2);
  expect(Math.abs(m.ui - m.sans)).toBeGreaterThan(2);

  // The renderer paints from the asset it fetches by path. Ink in the first line means the
  // path resolved; an unknown asset would paint nothing.
  const png = await decodePng(new Uint8Array(await macosPage.screenshot({ type: "png" })));
  const ink = bbox(png, 0, 40, (r, g, b) => r < 96 && g < 96 && b < 96);
  expect(ink, "no ink in the sans-serif line").not.toBeNull();
  expect(ink?.w ?? 0).toBeGreaterThan(m.sans * 0.8);
});

test("a pixel-free session shapes the macos profile identically", async ({ browserFactory }) => {
  // Pixel-free sessions fetch the .shaping.otf variants; the stripped tables must not move a
  // single advance.
  const paint = await widths(await loadMarkup(await browserFactory({ query: MACOS })));
  const pixelFreePage = await loadMarkup(
    await browserFactory({ query: MACOS, headers: { "x-kitesurf-skip-raster": "1" } }),
  );
  expect((await pageFaces(pixelFreePage)).map((f) => f.family)).toContain("Arimo");
  expect(await widths(pixelFreePage)).toEqual(paint);
});
