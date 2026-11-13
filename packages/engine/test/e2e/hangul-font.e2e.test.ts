// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Hangul gets its own script face. The CJK asset is the Noto Sans SC subset, which has no
// Hangul syllables, so before the face existed every Korean page rendered as .notdef tofu.

import type { CDPSession, Page } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";
import { decodePng, type DecodedPng } from "./png";
import { setContent } from "./set-content";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

// The faces arrive as a JSON string, so they are narrowed at runtime.
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

async function textWidth(page: Page, id: string): Promise<number> {
  const width: unknown = await page.evaluate(
    `document.getElementById(${JSON.stringify(id)}).getBoundingClientRect().width`,
  );
  if (typeof width !== "number") throw new Error(`#${id}: no width`);
  return width;
}

// Pixels that differ between two equal-height horizontal bands.
function bandDiff(png: DecodedPng, a: number, b: number, height: number): number {
  let diff = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = ((a + y) * png.width + x) * 4;
      const j = ((b + y) * png.width + x) * 4;
      if (Math.abs((png.data[i] ?? 0) - (png.data[j] ?? 0)) > 64) diff += 1;
    }
  }
  return diff;
}

test("Korean markup shapes and paints Hangul glyphs, not tofu", async ({ page, cdpSession }) => {
  await page.setViewport({ width: 400, height: 120 });
  // Two 60px bands: Hangul, then as many private-use codepoints, which no
  // bundled face maps. Without a Hangul face both bands are four .notdef
  // boxes and paint identically.
  await setContent(
    page,
    `<style>
      body { margin: 0; background: #fff; color: #000; }
      p { margin: 0; font: 40px/60px sans-serif; white-space: nowrap; }
    </style>
    <p lang=ko><span id=ko>대한민국</span></p>
    <p><span id=pua>&#xE000;&#xE001;&#xE002;&#xE003;</span></p>`,
  );

  const png = await decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
  // Noto Sans KR draws Hangul at 0.92em; the bands differ even where a
  // .notdef box comes close to that width.
  expect(await textWidth(page, "ko")).toBeGreaterThanOrEqual(4 * 40 * 0.8);
  expect(bandDiff(png, 0, 60, 60), "Hangul band paints like the tofu band").toBeGreaterThan(500);
  expect(await families(cdpSession)).toContain("Noto Sans KR");
});

test("script-inserted Hangul loads the Hangul face", async ({ page, cdpSession }) => {
  await setContent(
    page,
    `<p id=en>Latin only in the markup.</p>
    <script>
      en.insertAdjacentHTML("afterend", "<p lang=ko><span id=ko style='font-size:16px'>위키백과 대문입니다</span></p>");
    </script>`,
  );

  // A screenshot drains in-flight faces first, like any single-shot render.
  await page.screenshot();
  // Eight syllables plus a space at 16px; tofu would be 0.6em each.
  expect(await textWidth(page, "ko")).toBeGreaterThanOrEqual(8 * 16 * 0.8);
  expect(await families(cdpSession)).toContain("Noto Sans KR");
});
