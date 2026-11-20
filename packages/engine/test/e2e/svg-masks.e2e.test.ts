// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { decodePng, type DecodedPng } from "./png";

const CHANNEL_TOLERANCE = 2;

async function renderSvg(page: Page, svg: string): Promise<DecodedPng> {
  await page.setViewport({ width: 120, height: 110 });
  await setContent(page, `<style>body { margin: 0; background: white }</style>${svg}`);
  const screenshot = await page.screenshot();
  if (!(screenshot instanceof Uint8Array)) {
    throw new TypeError("expected page.screenshot() to return PNG bytes");
  }
  return decodePng(screenshot);
}

function expectPixel(png: DecodedPng, x: number, y: number, rgb: number[]) {
  const offset = (y * png.width + x) * 4;
  for (let channel = 0; channel < 3; channel++) {
    expect(Math.abs(png.data[offset + channel]! - rgb[channel]!)).toBeLessThanOrEqual(
      CHANNEL_TOLERANCE,
    );
  }
}

test("white SVG masks preserve fill and stroke opacity through transforms", async ({ page }) => {
  const png = await renderSvg(
    page,
    `<svg width="120" height="110">
       <defs>
         <mask id="fill" maskUnits="userSpaceOnUse" x="0" y="0" width="80" height="80">
           <path d="M0 40H80V80H0Z" fill="white" opacity="0.25"/>
         </mask>
         <mask id="line" maskUnits="userSpaceOnUse" x="0" y="0" width="80" height="80">
           <path d="M0 40H80" fill="none" stroke="white" stroke-width="4" opacity="0.8"/>
         </mask>
       </defs>
       <g transform="translate(10 10)">
         <rect width="80" height="80" fill="red" mask="url(#fill)"/>
         <rect width="80" height="80" fill="red" mask="url(#line)"/>
       </g>
     </svg>`,
  );
  expectPixel(png, 30, 30, [255, 255, 255]);
  expectPixel(png, 30, 70, [255, 191, 191]);
  expectPixel(png, 30, 49, [255, 51, 51]);
  expectPixel(png, 100, 70, [255, 255, 255]);
});

test("alpha SVG masks use coverage and clip to the mask region", async ({ page }) => {
  const png = await renderSvg(
    page,
    `<svg width="120" height="110">
       <defs>
         <mask id="alpha" style="mask-type: alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="40" height="80">
           <rect width="80" height="80" fill="black"/>
         </mask>
       </defs>
       <g transform="translate(10 10)" opacity="0.5">
         <rect width="80" height="80" fill="#00ff00" mask="url(#alpha)"/>
       </g>
     </svg>`,
  );
  expectPixel(png, 30, 30, [128, 255, 128]);
  expectPixel(png, 70, 30, [255, 255, 255]);
});

test("a mask with the default objectBoundingBox region follows the masked element", async ({
  page,
}) => {
  const png = await renderSvg(
    page,
    `<svg width="120" height="110">
       <defs>
         <mask id="left">
           <rect x="20" y="20" width="40" height="60" fill="white"/>
         </mask>
       </defs>
       <rect x="20" y="20" width="80" height="60" fill="blue" mask="url(#left)"/>
     </svg>`,
  );
  expectPixel(png, 40, 50, [0, 0, 255]);
  expectPixel(png, 80, 50, [255, 255, 255]);
});
