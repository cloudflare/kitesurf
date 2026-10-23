// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("detached canvas defers queued draws until explicit readback", async ({ page }) => {
  await setContent(
    page,
    `<script>
    globalThis.detachedCanvas = document.createElement("canvas");
    detachedCanvas.width = 2;
    detachedCanvas.height = 2;
    globalThis.detachedContext = detachedCanvas.getContext("2d");
    detachedContext.fillStyle = "red";
    detachedContext.fillRect(0, 0, 2, 2);
  </script>`,
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const ctx: unknown = Reflect.get(globalThis, "detachedContext");
        if (typeof ctx !== "object" || ctx === null) throw new Error("missing canvas context");
        const debug: unknown = Reflect.get(ctx, "__ksDbg");
        if (typeof debug !== "object" || debug === null)
          throw new Error("missing canvas debug state");
        return Reflect.get(debug, "last");
      }),
    )
    .toBe("detached");
  const result = await page.evaluate(() => {
    const canvas: unknown = Reflect.get(globalThis, "detachedCanvas");
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("missing canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("missing context");
    const debug: unknown = Reflect.get(ctx, "__ksDbg");
    if (typeof debug !== "object" || debug === null) throw new Error("missing canvas debug state");
    const sentBefore: unknown = Reflect.get(debug, "opsSent");
    const pixel = Array.from(ctx.getImageData(1, 1, 1, 1).data);
    const sentAfter: unknown = Reflect.get(debug, "opsSent");
    document.body.appendChild(canvas);
    return { sentBefore, sentAfter, pixel, connected: canvas.isConnected };
  });
  expect(result.sentBefore).toBe(0);
  expect(result.sentAfter).toBeGreaterThan(0);
  expect(result.pixel).toEqual([255, 0, 0, 255]);
  expect(result.connected).toBe(true);
});
