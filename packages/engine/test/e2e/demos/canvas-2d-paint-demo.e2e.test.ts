// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { waitForTitle } from "../waits";
import { decodePng, sample, near } from "./png";
import { setContent } from "../set-content";
import html from "../html/canvas-2d.html?raw";

declare global {
  interface Window {
    draw(color: string): void;
  }
}

const PUSH_BACKSTOP_MS = 600_000;
const SCREENSHOT_PAINT_TIMEOUT_MS = 15_000;

test("a canvas drawn after its last push shows in the next frame", async ({ page }) => {
  await setContent(
    page,
    `<body style="margin:0"><canvas id=c width=40 height=40></canvas><script>
      globalThis.__KS_CANVAS_PUSH_MS = ${PUSH_BACKSTOP_MS};
      const ctx = c.getContext("2d");
      globalThis.draw = (color) => { ctx.fillStyle = color; ctx.fillRect(0, 0, 40, 40); };
    </script>`,
  );
  const shoot = async () =>
    sample(decodePng(new Uint8Array(await page.screenshot({ type: "png" }))), 20, 20);

  await page.evaluate(() => window.draw("red"));
  expect(await shoot()).toEqual([255, 0, 0]);
  await page.evaluate(() => window.draw("blue"));
  expect(await shoot()).toEqual([0, 0, 255]);
});

test("full-plane putImageData snapshots the latest pending pixels", async ({ page }) => {
  await setContent(page, "<canvas width=2 height=1></canvas>");
  const pixels = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const context = canvas?.getContext("2d");
    if (!context) throw new Error("canvas 2D context is unavailable");
    const image = context.createImageData(2, 1);
    image.data.set([255, 0, 0, 255, 255, 0, 0, 255]);
    context.putImageData(image, 0, 0);
    image.data.set([0, 0, 255, 255, 0, 0, 255, 255]);
    context.putImageData(image, 0, 0);
    image.data.fill(0);
    const coalesced = Array.from(context.getImageData(0, 0, 2, 1).data);
    image.data.set([0, 255, 0, 255, 0, 255, 0, 255]);
    context.putImageData(image, 0, 0);
    image.data.fill(0);
    return [coalesced, Array.from(context.getImageData(0, 0, 2, 1).data)];
  });
  expect(pixels).toEqual([
    [0, 0, 255, 255, 0, 0, 255, 255],
    [0, 255, 0, 255, 0, 255, 0, 255],
  ]);
});

test("canvas-2d-paint-demo", async ({ page }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded", timeout: 30000 });

  const title = await waitForTitle(page, "CANVAS2D:", {
    prefix: true,
    timeout: 20000,
  });
  expect(title.startsWith("CANVAS2D:"), "fixture never reported").toBe(true);
  const api: unknown = JSON.parse(title.slice("CANVAS2D:".length));
  expect(api).toEqual({
    ctxOk: true,
    sameCtx: true,
    webglNull: true,
    roundTrip: "0,128,0",
  });

  let png: ReturnType<typeof decodePng> | undefined;
  await expect
    .poll(
      async () => {
        png = decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
        return sample(png, 90, 70);
      },
      { timeout: SCREENSHOT_PAINT_TIMEOUT_MS },
    )
    .toEqual([255, 0, 0]);
  if (png === undefined) throw new Error("canvas screenshot was not captured");

  const cases: Array<[string, number, number, [number, number, number]]> = [
    ["top-left red", 40 + 50, 30 + 40, [255, 0, 0]],
    ["top-right green", 40 + 150, 30 + 40, [0, 128, 0]],
    ["bottom-left blue", 40 + 50, 30 + 120, [0, 0, 255]],
    ["bottom-right yellow", 40 + 150, 30 + 120, [255, 255, 0]],
    ["page background grey", 40 + 260, 30 + 40, [128, 128, 128]],
  ];
  for (const [label, x, y, want] of cases) {
    const got = sample(png, x, y);
    expect(
      near(got, want),
      `${label} @(${x},${y}): got rgb(${got.join(",")}) want rgb(${want.join(",")})`,
    ).toBe(true);
  }
});
