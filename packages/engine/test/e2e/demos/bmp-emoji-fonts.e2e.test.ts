// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";
import { expect, test } from "../harness";
import { setContent } from "../set-content";
import { decodePng } from "./png";

// U+2705 and U+274C are below U+1F000 and do not use U+FE0F. They use emoji presentation by
// default. Only the color emoji font contains them.
const ROW_STYLE = "font-size:64px;line-height:80px;font-family:sans-serif;margin:0";

async function colorfulPixels(page: Page): Promise<number> {
  const png = decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
  let colorful = 0;
  for (let y = 0; y < Math.min(90, png.height); y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.pixels[i] as number;
      const g = png.pixels[i + 1] as number;
      const b = png.pixels[i + 2] as number;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 60) colorful += 1;
    }
  }
  return colorful;
}

const cases: [string, string][] = [
  ["literal in the markup", `<p style="${ROW_STYLE}">\u2705\u274C</p>`],
  ["character references", `<p style="${ROW_STYLE}">&#x2705;&#10060;</p>`],
  [
    "written by script",
    `<p id=row style="${ROW_STYLE}"></p>
    <script>row.textContent = String.fromCodePoint(0x2705, 0x274c);</script>`,
  ],
];

for (const [name, html] of cases) {
  test(`BMP emoji ${name} paints in color`, async ({ page }) => {
    await setContent(page, `<body style="margin:0;background:#fff">${html}</body>`);
    await expect.poll(() => colorfulPixels(page), { timeout: 5_000 }).toBeGreaterThan(500);
  });
}
