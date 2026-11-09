// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { createHash } from "node:crypto";

import { expect, test } from "./harness";
import { setContent } from "./set-content";

// SHA-256 values captured from the unbanded renderer in the main tree.
const UNBANDED_RENDERER_HASHES = {
  viewportPng: "931f67454a35850c6895dbd6bb4d405d0522560bac9e9911b0ae6a786a2cf029",
  viewportJpeg: "704ba6839658da9f9d075e76934c0c49587ced17a29675a139dc3cdd4b410679",
  tallClipPng: "7cd17acd6085e1189b8437890a94a1483eeed1311f672857792d4664043c57a1",
} as const;

function pngDimensions(data: string): number[] {
  const bytes = Uint8Array.from(atob(data.slice(0, 32)), (byte) => byte.charCodeAt(0));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}

test("screenshot encodings match the unbanded renderer", async ({ page, cdpSession }) => {
  await page.setViewport({ width: 1280, height: 720 });
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><defs><linearGradient id="g"><stop stop-color="#fff"/><stop offset="1" stop-color="#f0a058"/></linearGradient></defs><rect width="120" height="80" fill="url(#g)"/><circle cx="60" cy="40" r="24" fill="#2943a3"/></svg>',
  ).toString("base64");
  await setContent(
    page,
    `<!doctype html><html><head><style>
      html,body{margin:0;width:1280px;height:3000px}body{font:28px Arial,sans-serif;color:#fff;
      background:linear-gradient(135deg,#0b1026 0%,#2943a3 55%,#f0a058 100%)}
      .card{position:absolute;left:133px;top:79px;width:710px;height:360px;padding:32px;
      transform:translate(17px,11px) rotate(-2deg);border-radius:24px;
      background:linear-gradient(110deg,rgba(255,255,255,.24),rgba(10,16,38,.72))}
      img{position:absolute;left:80px;top:510px;width:120px;height:80px}
    </style></head><body><section class="card"><h1>Kitesurf screenshot identity</h1>
      <p>Text over layered gradients, a transformed card, and an embedded image.</p></section>
      <img src="data:image/svg+xml;base64,${svg}" alt="gradient image"></body></html>`,
  );
  await page.waitForFunction(`document.querySelector("img")?.naturalWidth === 120`, {
    timeout: 30_000,
  });

  const cases = [
    ["viewportPng", { format: "png" }],
    ["viewportJpeg", { format: "jpeg", quality: 80 }],
    ["tallClipPng", { format: "png", clip: { x: 0, y: 0, width: 1280, height: 2560, scale: 1 } }],
  ] as const;
  for (const [name, params] of cases) {
    const screenshot = await cdpSession.send("Page.captureScreenshot", params);
    const hash = createHash("sha256").update(Buffer.from(screenshot.data, "base64")).digest("hex");
    expect(hash, `${name} SHA-256`).toBe(UNBANDED_RENDERER_HASHES[name]);
  }
}, 120_000);

test("captures full content and tall clips without changing the viewport", async ({
  page,
  cdpSession,
}) => {
  await page.setViewport({ width: 1280, height: 720 });
  await setContent(
    page,
    '<body style="margin:0"><div style="width:1280px;height:15000px;background:linear-gradient(red,blue)"></div></body>',
  );
  const full = await cdpSession.send("Page.captureScreenshot", { captureBeyondViewport: true });
  expect(pngDimensions(full.data)).toEqual([1280, 15000]);
  const memory = await cdpSession.send("Kitesurf.getMemoryStats", {});
  console.log(
    "[screenshot-full-page] wasm bytes",
    JSON.stringify({
      engine: memory.engine?.wasmBytes,
      pageScript: memory.total?.pageScriptBytes,
      renderer: memory.renderer?.wasmBytes,
    }),
  );
  const viewport = await cdpSession.send("Page.captureScreenshot", {});
  expect(pngDimensions(viewport.data)).toEqual([1280, 720]);
  const clip = await cdpSession.send("Page.captureScreenshot", {
    clip: { x: 0, y: 0, width: 1280, height: 6000, scale: 1 },
  });
  expect(pngDimensions(clip.data)).toEqual([1280, 6000]);
  for (const scale of [0, -1, 2, Number.NaN]) {
    await expect(
      cdpSession.send("Page.captureScreenshot", {
        clip: { x: 0, y: 0, width: 1280, height: 100, scale },
      }),
    ).rejects.toThrow("clip.scale other than 1 is not supported");
  }
  await expect(
    cdpSession.send("Page.captureScreenshot", {
      clip: { x: 0, y: 0, width: 65536, height: 1, scale: 1 },
    }),
  ).rejects.toThrow("exceeds the 65535 px per-side raster limit");
  await expect(
    cdpSession.send("Page.captureScreenshot", {
      format: "webp",
      clip: { x: 0, y: 0, width: 2561, height: 2560, scale: 1 },
    }),
  ).rejects.toThrow("WebP limits of 4096 px per side and 6553600 px total");
  await expect(
    cdpSession.send("Page.captureScreenshot", {
      format: "webp",
      clip: { x: 0, y: 0, width: 5000, height: 1000, scale: 1 },
    }),
  ).rejects.toThrow("requested 5000x1000 px exceeds WebP limits of 4096 px per side");
}, 120_000);

test("accepts the clip scale Playwright sends for a css-scale screenshot", async ({
  page,
  cdpSession,
}) => {
  await page.setViewport({ width: 1280, height: 720 });
  await setContent(
    page,
    '<body style="margin:0"><div style="width:1280px;height:3000px;background:linear-gradient(red,blue)"></div></body>',
  );
  await cdpSession.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 720,
    deviceScaleFactor: 2,
    mobile: false,
  });
  // Playwright divides the clip scale by deviceScaleFactor for scale: "css",
  // so a 2x emulated device sends 0.5 and expects CSS-pixel output.
  const cssScale = await cdpSession.send("Page.captureScreenshot", {
    clip: { x: 0, y: 0, width: 200, height: 100, scale: 0.5 },
  });
  expect(pngDimensions(cssScale.data)).toEqual([200, 100]);
  // A scale that does not cancel the emulated ratio stays unsupported.
  await expect(
    cdpSession.send("Page.captureScreenshot", {
      clip: { x: 0, y: 0, width: 200, height: 100, scale: 0.25 },
    }),
  ).rejects.toThrow("clip.scale other than 1 is not supported");
  await cdpSession.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
}, 120_000);

test("rejects oversized encoded output and keeps the renderer usable", async ({
  page,
  cdpSession,
}) => {
  const width = 2100;
  const height = 2100;
  await page.setViewport({ width: 1280, height: 720 });
  await page.goto("https://ks.invalid/__fixtures/oversized-image.html", {
    waitUntil: "load",
    timeout: 300_000,
  });
  await page.waitForFunction(`document.querySelector("img")?.complete === true`, {
    timeout: 30_000,
  });
  const image = await page.evaluate(`(() => {
    const image = document.querySelector("img");
    return { complete: image?.complete, width: image?.naturalWidth, height: image?.naturalHeight };
  })()`);
  expect(image).toEqual({ complete: true, width, height });
  await expect(
    cdpSession.send("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: 0, width, height, scale: 1 },
    }),
  ).rejects.toThrow(/exceeds 16777216 bytes/);
  const recovery = await cdpSession.send("Page.captureScreenshot", {
    format: "jpeg",
    clip: { x: 0, y: 0, width: 100, height: 100, scale: 1 },
  });
  expect(recovery.data.length).toBeGreaterThan(0);
}, 300_000);
