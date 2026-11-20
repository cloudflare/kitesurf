// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Inline <svg> paints from an XML snapshot of its subtree, so character
// data must be escaped on the way out. One bare `&` in a label (radar's
// AS treemap has "AT&T") failed the whole parse and blanked every shape.

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { decodePng, type DecodedPng } from "./png";

const sample = (png: DecodedPng, x: number, y: number): number[] => [
  ...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3),
];

test("svg text with & or < still paints the svg", async ({ page }) => {
  await page.setViewport({ width: 200, height: 160 });
  await setContent(
    page,
    `<style>body { margin: 0; background: #fff } svg { display: block }</style>
     <svg width="200" height="40"><rect width="40" height="40" fill="#f00"/><text x="50" y="25">AT&amp;T</text></svg>
     <svg width="200" height="40"><rect width="40" height="40" fill="#f00"/><text x="50" y="25">a &lt; b</text></svg>
     <svg width="200" height="40"><rect width="40" height="40" fill="#f00"/><title>x &amp; y</title></svg>
     <svg width="200" height="40"><style>g > rect { fill: #00f }</style><g><rect width="40" height="40" fill="#f00"/></g></svg>`,
    { waitUntil: "domcontentloaded" },
  );

  const png = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));
  expect(sample(png, 20, 20), "text with &").toEqual([255, 0, 0]);
  expect(sample(png, 20, 60), "text with <").toEqual([255, 0, 0]);
  expect(sample(png, 20, 100), "title with &").toEqual([255, 0, 0]);
  // A child combinator in an svg <style> still reaches usvg's CSS.
  expect(sample(png, 20, 140), "svg <style> with >").toEqual([0, 0, 255]);
});
