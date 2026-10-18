// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "../harness";

test("screenshot-demo", async ({ page }) => {
  const OUT_PATH =
    process.env.KITESURF_PNG_OUT ??
    fileURLToPath(new URL("./screenshot-demo-output.png", import.meta.url));

  const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>scrn-1</title>
<style>
  body { margin: 0; padding: 24px; font-family: sans-serif; background: #fafbfc; color: #222; }
  h1 { color: #c0392b; margin: 0 0 12px 0; font-size: 28px; }
  .row { display: flex; gap: 12px; margin-top: 16px; }
  .card { background: #4a90e2; color: white; padding: 12px 16px; border-radius: 6px; flex: 1; }
  .card.alt { background: #50c878; }
  .footer { margin-top: 24px; color: #666; font-size: 14px; }
</style></head>
<body>
  <h1>kitesurf screenshots are real</h1>
  <p>This page is rendered inside workerd via Blitz: stylo for cascade, taffy for layout, vello_cpu for raster, png for encoding.</p>
  <div class="row">
    <div class="card">First card</div>
    <div class="card alt">Second card</div>
  </div>
  <p class="footer">Slice scrn-1 — Page.captureScreenshot</p>
</body></html>`;

  await page.goto(`data:text/html,${encodeURIComponent(HTML)}`, { timeout: 15000 });

  console.log("[screenshot-demo] calling page.screenshot()...");
  const t0 = Date.now();
  const buf = await page.screenshot({ type: "png" });
  const elapsed = Date.now() - t0;
  console.log(`[screenshot-demo] got ${buf.length} bytes in ${elapsed}ms`);

  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  let sigOk = true;
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) {
      sigOk = false;
      break;
    }
  }
  expect(sigOk, "valid PNG signature").toBeTruthy();
  expect(buf.length, "PNG non-trivial (>= 500 bytes)").toBeGreaterThanOrEqual(500);

  const w = (buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19];
  const h = (buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23];
  console.log(`[screenshot-demo] PNG dimensions: ${w}x${h}`);
  expect({ w, h }, "PNG dimensions are 800x600").toStrictEqual({ w: 800, h: 600 });

  try {
    writeFileSync(OUT_PATH, buf);
  } catch {
    /* no writable fs in the e2e pool; the dimension check above gates */
  }
  console.log(`[screenshot-demo] PNG written to ${OUT_PATH}`);
});
