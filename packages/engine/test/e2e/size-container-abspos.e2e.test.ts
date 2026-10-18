// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Inline-size containment does not establish layout containment, so a size container
// does not claim out-of-flow boxes (CSSWG issue 10544).
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { bbox, decodePng } from "./png";

const isGreen = (r: number, g: number, b: number) => r < 40 && g > 100 && b < 40;

test("an abspos box escapes a size container to its positioned ancestor", async ({ page }) => {
  await page.setViewport({ width: 200, height: 200 });
  await setContent(
    page,
    `<!doctype html>
<style>body { margin: 0; background: #fff }</style>
<div style="position: relative; width: 100px; height: 100px; background: #e00">
  <div style="container-type: inline-size; height: 0">
    <div style="position: absolute; inset: 0; background: rgb(0, 128, 0)"></div>
  </div>
</div>`,
    { waitUntil: "domcontentloaded" },
  );
  const png = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));
  expect(bbox(png, 0, 200, isGreen)).toEqual({ x: 0, y: 0, w: 100, h: 100 });
});
