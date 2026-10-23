// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { decodePng } from "./png";

function isDarkPixel(png: Awaited<ReturnType<typeof decodePng>>, index: number): boolean {
  const channel = (offset: number) => png.data[index + offset] ?? 255;
  return channel(0) < 100 && channel(1) < 100 && channel(2) < 100;
}

function inkRuns(
  png: Awaited<ReturnType<typeof decodePng>>,
  y: number,
): { runs: number; ink: number } {
  let runs = 0;
  let ink = 0;
  let inRun = false;
  for (let x = 0; x < png.width; x++) {
    const i = (y * png.width + x) * 4;
    if (isDarkPixel(png, i)) {
      ink++;
      if (!inRun) runs++;
      inRun = true;
    } else {
      inRun = false;
    }
  }
  return { runs, ink };
}

test("SVG stroke-dasharray survives the scene wire", async ({ page }) => {
  await page.setViewport({ width: 400, height: 100 });
  await setContent(
    page,
    `<style>body { margin: 0; background: #fff }</style>
     <svg id="s" viewBox="0 0 400 60" style="width:400px">
       <line x1="0" y1="15" x2="400" y2="15" stroke="#000000" stroke-width="6" stroke-dasharray="20 20"/>
       <line x1="0" y1="45" x2="400" y2="45" stroke="#000000" stroke-width="6"/>
     </svg>`,
    { waitUntil: "domcontentloaded" },
  );

  const png = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));
  const dashed = inkRuns(png, 15);
  const solid = inkRuns(png, 45);

  expect(dashed.runs).toBe(10);
  expect(dashed.ink).toBeGreaterThan(150);
  expect(dashed.ink).toBeLessThan(250);
  expect(solid.runs).toBe(1);
  expect(solid.ink).toBeGreaterThan(390);
}, 120_000);
