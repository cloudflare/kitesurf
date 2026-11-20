// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";
import { decodePng } from "./png";
import { setContent } from "./set-content";

const GREEN =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAD0lEQVR4nGNgWMCAQMRxAARDCgHeFFL0AAAAAElFTkSuQmCC";
const IMG = `<img src="${GREEN}" style="display:block;width:100px;height:100px">`;

// Page script can reach the DomHandle that answers the renderer's resource requests, and answer
// them for its own images with other pixels.
const REPLACE_PIXELS = `<script>
  const dom = globalThis[Symbol.for("kitesurf.internals")].domDebug;
  dom.renderRbiResources = function (a, b, imageHashes) {
    const count = imageHashes.length / 8;
    const entry = 13 + 9 + 4 * 4 * 4;
    const out = new Uint8Array(4 + count * entry);
    const view = new DataView(out.buffer);
    view.setUint32(0, count, true);
    for (let i = 0; i < count; i++) {
      const at = 4 + i * entry;
      out[at] = 2;
      out.set(imageHashes.subarray(i * 8, i * 8 + 8), at + 1);
      view.setUint32(at + 9, 9 + 64, true);
      view.setUint32(at + 13, 4, true);
      view.setUint32(at + 17, 4, true);
      out[at + 21] = 0;
      for (let p = 0; p < 16; p++) out.set([255, 0, 0, 255], at + 22 + p * 4);
    }
    return out;
  };
</script>`;

async function centerPixel(page: Page, x = 50, y = 50): Promise<number[]> {
  const png = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));
  const i =
    (Math.round((y * png.height) / 200) * png.width + Math.round((x * png.width) / 200)) * 4;
  return [png.data[i] ?? 0, png.data[i + 1] ?? 0, png.data[i + 2] ?? 0];
}

test("a document's render resources do not reach the next document's screenshot", async ({
  page,
}) => {
  await page.setViewport({ width: 200, height: 200 });
  await setContent(page, `<!doctype html><body style="margin:0">${IMG}${REPLACE_PIXELS}`);
  expect((await centerPixel(page))[0]).toBeGreaterThan(200);
  await setContent(page, `<!doctype html><body style="margin:0">${IMG}<!-- next -->`);
  const [r, g] = await centerPixel(page);
  expect(r).toBeLessThan(80);
  expect(g).toBeGreaterThan(120);
}, 60_000);

// A response header cannot name a renderer resource: two images that claim the same font
// key must still paint their own bytes.
test("a font key on an image response does not re-key the image", async ({ page }) => {
  await page.setViewport({ width: 200, height: 200 });
  await page.goto("https://ks.invalid/__fixtures/font-key-images.html", { waitUntil: "load" });
  const red = await centerPixel(page);
  const orange = await centerPixel(page, 50, 150);
  expect(red[1]).toBeLessThan(20);
  expect(orange[1]).toBeGreaterThan(30);
}, 60_000);
