// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Han takes the regional face its `lang` asks for: Japanese and Traditional Chinese text no
// longer borrows the Simplified Chinese glyph forms. 直 and 骨 differ in all three regions.

import type { CDPSession } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";
import { decodePng, type DecodedPng } from "./png";
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

test("Han follows the lang to the SC, JP or TC face", async ({ page, cdpSession }) => {
  await page.setViewport({ width: 300, height: 320 });
  await setContent(
    page,
    `<style>
      body { margin: 0; background: #fff; color: #000; }
      p { margin: 0; font: 48px/80px sans-serif; white-space: nowrap; }
    </style>
    <p lang=zh-CN>直骨</p>
    <p lang=zh-CN>直骨</p>
    <p lang=ja>直骨</p>
    <p lang=zh-TW>直骨</p>`,
  );

  const png = await decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
  expect(bandDiff(png, 0, 80, 80), "same lang, same glyphs").toBe(0);
  expect(bandDiff(png, 0, 160, 80), "ja draws the SC forms").toBeGreaterThan(50);
  expect(bandDiff(png, 0, 240, 80), "zh-TW draws the SC forms").toBeGreaterThan(50);
  expect(bandDiff(png, 160, 240, 80), "zh-TW draws the JP forms").toBeGreaterThan(50);
  const names = await families(cdpSession);
  expect(names).toEqual(expect.arrayContaining(["PingFang SC", "Hiragino Sans", "PingFang TC"]));
});

test("a page without Japanese or Traditional Chinese loads neither face", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, `<p lang=zh-CN>中文</p>`);
  await page.screenshot();
  const names = await families(cdpSession);
  expect(names).toContain("PingFang SC");
  expect(names).not.toContain("Hiragino Sans");
  expect(names).not.toContain("PingFang TC");
});
