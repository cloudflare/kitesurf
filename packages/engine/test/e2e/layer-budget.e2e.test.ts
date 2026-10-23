// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { bbox, decodePng } from "./png";

const HTML = `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>layer budget</title>
<style>
  body { margin: 0; background: #fff }
  /* The visually-hidden pattern, stacked: an empty clip on a 1x1 box, so a
     correctly clipped span contributes no magenta at all. */
  .sr { position: absolute; top: 10px; left: 10px; width: 1px; height: 1px;
        overflow: hidden; clip: rect(0, 0, 0, 0); clip-path: inset(50%);
        font: 16px monospace; color: #f0f; white-space: pre }
</style>
</head>
<body>
${Array.from({ length: 1400 }, (_, i) => `<span class="sr">HIDDEN LABEL ${i}</span>`).join("\n")}
</body>
</html>`;

test("clips are still honoured past 1024 sibling clipped boxes", async ({ page }) => {
  await page.setViewport({ width: 600, height: 300 });
  await setContent(page, HTML, { waitUntil: "domcontentloaded" });

  const spans = await page.evaluate(() => document.querySelectorAll(".sr").length);
  expect(spans).toBeGreaterThan(1024);

  const png = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));
  const magenta = (r: number, g: number, b: number) => r > 150 && g < 80 && b > 150;
  expect(bbox(png, 0, png.height, magenta)).toBeNull();
}, 120_000);
