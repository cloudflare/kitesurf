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

// A page with a canvas fetches the full CJK files and keeps their outlines, so fillText paints.
test("canvas fillText paints Simplified Chinese and Japanese text", async ({ page }) => {
  await setContent(
    page,
    `<p lang=ja>日本語のテキスト</p><p lang=zh-CN>中文文本</p>
<canvas id=c width=400 height=120></canvas>`,
  );
  // A screenshot drains in-flight faces first, like any single-shot render.
  await page.screenshot();
  const ink: unknown = await page.evaluate(`(() => {
    const ctx = document.getElementById("c").getContext("2d");
    const ink = (text, font) => {
      ctx.clearRect(0, 0, 400, 120);
      ctx.font = font;
      ctx.fillText(text, 10, 80);
      const d = ctx.getImageData(0, 0, 400, 120).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 128) n++;
      return n;
    };
    return {
      sc: ink("中文文本", "40px sans-serif"),
      jp: ink("日本語のテキスト", "40px 'Hiragino Sans'"),
    };
  })()`);
  const count = (key: string): number => {
    const v: unknown = isRecord(ink) ? ink[key] : undefined;
    return typeof v === "number" ? v : -1;
  };
  expect(count("sc"), JSON.stringify(ink)).toBeGreaterThan(500);
  expect(count("jp"), JSON.stringify(ink)).toBeGreaterThan(500);
});

// SVG text shapes through usvg's own font database, which a full-mode page fills with the
// outline-bearing CJK faces.
test("SVG text paints Simplified Chinese and Japanese glyphs", async ({ page }) => {
  await page.setViewport({ width: 400, height: 180 });
  await setContent(
    page,
    `<style>body { margin: 0; background: #fff; }</style>
    <svg width=400 height=180 style="display: block">
      <text x=0 y=45 font-size=40 font-family=sans-serif>中文文本</text>
      <text x=0 y=105 font-size=40 font-family="Hiragino Sans">日本語かな</text>
      <text x=0 y=165 font-size=40 font-family=sans-serif>&#xE000;&#xE001;&#xE002;&#xE003;</text>
    </svg>`,
  );
  const png = await decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
  expect(bandDiff(png, 0, 120, 60), "SC band paints like the tofu band").toBeGreaterThan(500);
  expect(bandDiff(png, 60, 120, 60), "JP band paints like the tofu band").toBeGreaterThan(500);
});
