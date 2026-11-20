// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { decodePng } from "./png";

interface CanvasProbeResult {
  same: string;
  sameNat: string;
  crossNat: string;
  cross: string;
  crossSvg: string;
}

declare global {
  interface Window {
    __ks_canvas_ready: Promise<void>;
    __ks_canvas: CanvasProbeResult | null;
  }
}

const FIXTURE = "https://ks.invalid/__fixtures/canvas-drawimage.html";

test("same-origin drawImage composites and stays readable", async ({ page }) => {
  await page.goto(FIXTURE, { waitUntil: "load" });
  const out = await page.evaluate(async () => {
    await window.__ks_canvas_ready;
    const result = window.__ks_canvas;
    if (result === null) throw new Error("canvas fixture did not report results");
    return result;
  });
  expect(out.sameNat).toBe("8x8:true");
  expect(out.crossNat).toBe("8x8:true");
  expect(out.same).toBe("255,0,0,255");
}, 120_000);

test.for(["src", "base", "invalid"] as const)(
  "canvas sources recheck %s changes rather than caller fields",
  { timeout: 120_000 },
  async (changed, { page }) => {
    await page.goto(FIXTURE, { waitUntil: "load" });
    await page.evaluate(async () => window.__ks_canvas_ready);
    const results = await page.evaluate((changed) => {
      const image = document.getElementById("same");
      if (!(image instanceof HTMLImageElement)) {
        throw new Error("canvas fixture image is missing");
      }
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 8;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas 2D context is unavailable");
      context.drawImage(image, 0, 0);
      const same = Array.from(context.getImageData(4, 4, 1, 1).data);
      if (changed === "src") {
        image.setAttribute("src", "https://ks-other.invalid/__fixtures/solid-red.png");
      } else if (changed === "base") {
        const base = document.createElement("base");
        base.href = "https://ks-other.invalid/";
        document.head.appendChild(base);
      } else {
        image.setAttribute("src", "http://[");
      }
      const imageId = Reflect.get(image, "_id");
      if (typeof imageId !== "number") throw new Error("fixture image has no node id");
      const forged = {
        _id: imageId,
        tagName: "CANVAS",
        src: "data:,",
        complete: true,
        naturalWidth: 8,
      };
      const drawImage = (source: unknown): void => {
        Reflect.apply(context.drawImage, context, [source, 0, 0]);
      };
      const createPattern = (source: unknown): unknown =>
        Reflect.apply(context.createPattern, context, [source, "repeat"]);
      const taint = (usePattern: boolean) => {
        canvas.width = 8;
        if (usePattern) {
          const pattern = createPattern(forged);
          if (!pattern) throw new Error("fixture source must create a pattern");
          if (!Reflect.set(context, "fillStyle", pattern)) {
            throw new Error("canvas rejected the fixture pattern");
          }
          context.fillRect(0, 0, 8, 8);
        } else {
          drawImage(forged);
        }
        try {
          context.getImageData(0, 0, 1, 1);
          return "readable";
        } catch (error) {
          const name =
            typeof error === "object" && error !== null ? Reflect.get(error, "name") : null;
          return typeof name === "string" ? name : String(error);
        }
      };
      return { same, drawn: taint(false), patterned: taint(true) };
    }, changed);
    expect(results).toEqual({
      same: [255, 0, 0, 255],
      drawn: "SecurityError",
      patterned: "SecurityError",
    });
  },
);

// The loader fetches the srcset candidate, not the src attribute (blitz
// select_image_url), so the taint decision has to cover both.
test.for(["srcset", "picture"] as const)(
  "a cross-origin %s candidate taints the canvas",
  { timeout: 120_000 },
  async (kind, { page }) => {
    await page.goto(FIXTURE, { waitUntil: "load" });
    const out = await page.evaluate(async (kind) => {
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const img = document.createElement("img");
      // Same-origin src (7x4); the cross-origin candidate is 8x8, so naturalWidth
      // proves which URL the loader actually fetched.
      img.setAttribute("src", "/__fixtures/tiny.png");
      const cross = "https://ks-other.invalid/__fixtures/solid-red.png 2x";
      if (kind === "srcset") {
        img.setAttribute("srcset", cross);
        document.body.appendChild(img);
      } else {
        const picture = document.createElement("picture");
        const source = document.createElement("source");
        source.setAttribute("srcset", cross);
        picture.appendChild(source);
        picture.appendChild(img);
        document.body.appendChild(picture);
      }
      for (let i = 0; i < 100 && img.naturalWidth === 0; i++) await sleep(50);
      const natural = `${img.naturalWidth}x${img.naturalHeight}`;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 8;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas 2D context is unavailable");
      context.drawImage(img, 0, 0);
      await sleep(300);
      try {
        const pixel = context.getImageData(4, 4, 1, 1).data;
        return `readable:${natural}:${pixel[0]},${pixel[1]},${pixel[2]},${pixel[3]}`;
      } catch (error) {
        const name =
          typeof error === "object" && error !== null ? Reflect.get(error, "name") : null;
        return `${typeof name === "string" ? name : String(error)}:${natural}`;
      }
    }, kind);
    expect(out).toBe("SecurityError:8x8");
  },
);

test("cross-origin drawImage taints the canvas and paints nothing", async ({ page }) => {
  await page.goto(FIXTURE, { waitUntil: "load" });
  const out = await page.evaluate(async () => {
    await window.__ks_canvas_ready;
    const result = window.__ks_canvas;
    if (result === null) throw new Error("canvas fixture did not report results");
    return result;
  });
  expect(out.cross.startsWith("THREW:")).toBe(true);
  expect(out.cross).toContain("SecurityError");
  expect(out.crossSvg.startsWith("THREW:")).toBe(true);
  expect(out.crossSvg).toContain("SecurityError");

  const box = await page.evaluate(() => {
    const canvas = document.getElementById("c3");
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error("canvas fixture c3 is missing");
    }
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    };
  });
  const png = await decodePng(new Uint8Array(await page.screenshot()));
  let svgPixels = 0;
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i] ?? 0;
      const g = png.data[i + 1] ?? 0;
      const b = png.data[i + 2] ?? 0;
      if (b > 120 && r < 100 && g < 120) svgPixels++;
    }
  }
  expect(svgPixels).toBe(0);
}, 120_000);
