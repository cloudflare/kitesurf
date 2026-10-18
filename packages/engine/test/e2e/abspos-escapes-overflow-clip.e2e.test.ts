// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { bbox, decodePng } from "./png";

const isRed = (r: number, g: number, b: number) => r > 150 && g < 80 && b < 80;

const shell = (clipCss: string, boxCss: string) => `<!doctype html>
<meta charset="utf-8">
<style>
  html, body, .clip { margin: 0; height: 100% }
  body { background: #fff }
  .clip { ${clipCss} }
  .box { background: #e00; ${boxCss} }
</style>
<div class="clip"><div class="box"></div></div>`;

const ABS = "position: absolute; left: 0; top: 0; width: 300px; height: 40px";
const PINNED = "position: absolute; inset: 0";

test("an abspos box escapes a static ancestor's overflow clip", async ({ page }) => {
  await page.setViewport({ width: 400, height: 200 });

  const paint = async (html: string) => {
    await setContent(page, html, { waitUntil: "domcontentloaded" });
    const png = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));
    return bbox(png, 0, 200, isRed);
  };

  const escaped = await paint(shell("width: 120px; overflow: hidden", ABS));
  expect(escaped).not.toBeNull();
  expect(escaped!.x).toBe(0);
  expect(escaped!.w).toBe(300);

  const pinned = await paint(shell("width: 120px; overflow: hidden", PINNED));
  expect(pinned).toEqual({ x: 0, y: 0, w: 400, h: 200 });

  const clipped = await paint(shell("width: 120px; overflow: hidden; position: relative", ABS));
  expect(clipped).not.toBeNull();
  expect(clipped!.w).toBe(120);

  const inFlow = await paint(shell("width: 120px; overflow: hidden", "width: 300px; height: 40px"));
  expect(inFlow).not.toBeNull();
  expect(inFlow!.w).toBe(120);

  const fixed = await paint(
    shell(
      "width: 120px; overflow: hidden",
      "position: fixed; left: 0; top: 0; width: 300px; height: 40px",
    ),
  );
  expect(fixed).not.toBeNull();
  expect(fixed!.w).toBe(300);

  const noClip = await paint(shell("width: 120px", ABS));
  expect(noClip).not.toBeNull();
  expect(noClip!.w).toBe(300);
});
