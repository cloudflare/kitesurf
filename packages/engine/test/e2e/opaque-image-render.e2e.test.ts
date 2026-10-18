// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// PageScript sees dimensions, not withheld bytes.
import type { Page } from "@cloudflare/puppeteer";

import { readEngineMemory } from "./cdp-read";
import { expect, test } from "./harness";
import { decodePng } from "./png";

const FIXTURE = "https://ks.invalid/__fixtures/image-paint.html";
const CROSS_IMAGE = "https://ks-other.invalid/__fixtures/solid-red.png";
const SAME_IMAGE = "/__fixtures/solid-red.png";

function pixel(
  png: Awaited<ReturnType<typeof decodePng>>,
  x: number,
  y: number,
): [number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.data[i] ?? 0, png.data[i + 1] ?? 0, png.data[i + 2] ?? 0];
}

function isRed([r, g, b]: [number, number, number]): boolean {
  return r > 200 && g < 80 && b < 80;
}

async function imageStore(page: Page): Promise<{ count: number; bytes: number }> {
  const session = await page.createCDPSession();
  const mem = await readEngineMemory(session);
  return { count: mem.retainedImageCount, bytes: mem.retainedImageBytes };
}

async function settleImages(page: Page): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const ok = await page.evaluate(`
      ["a", "b"].every((id) => document.getElementById(id).naturalWidth > 0)
    `);
    if (ok === true) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("image-paint.html images never reported a size");
}

test("a withheld cross-origin image still rasters, alongside a same-origin one", async ({
  page,
}) => {
  await page.setViewport({ width: 200, height: 200 });
  await page.goto(FIXTURE, { waitUntil: "load" });

  const rects = (await page.evaluate(`
    (() => {
      const r = (id) => {
        const b = document.getElementById(id).getBoundingClientRect();
        return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
      };
      return { a: r("a"), b: r("b") };
    })()
  `)) as { a: { x: number; y: number }; b: { x: number; y: number } };

  const png = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));
  expect(isRed(pixel(png, rects.a.x, rects.a.y))).toBe(true);
  expect(isRed(pixel(png, rects.b.x, rects.b.y))).toBe(true);
  expect(rects.a.y).not.toBe(rects.b.y);
}, 120_000);

test("only a withheld image is keyed — a readable one keeps its bytes", async ({ page }) => {
  const before = await imageStore(page);
  await page.goto(FIXTURE, { waitUntil: "load" });
  await settleImages(page);
  const after = await imageStore(page);

  expect(after.count - before.count).toBe(1);
  expect(after.bytes).toBeGreaterThan(before.bytes);

  const out = (await page.evaluate(`
    (async () => {
      const read = async (u) => {
        try {
          const r = await fetch(u);
          return {
            key: r.headers.get("x-kitesurf-resource-key"),
            bytes: (await r.arrayBuffer()).byteLength,
          };
        } catch (e) {
          return { threw: (e && e.name) ? e.name : String(e) };
        }
      };
      return {
        same: await read(${JSON.stringify(SAME_IMAGE)}),
        cross: await read(${JSON.stringify(CROSS_IMAGE)}),
      };
    })()
  `)) as {
    same: { key: string | null; bytes: number; threw?: string };
    cross: { key?: string | null; bytes?: number; threw?: string };
  };
  expect(out.same.threw).toBeUndefined();
  expect(out.same.key).toBeNull();
  expect(out.same.bytes).toBeGreaterThan(0);
  expect(out.cross.threw).toBe("TypeError");
}, 120_000);

test("a withheld image arrives as dimensions, and nothing else", async ({ page }) => {
  await page.goto(FIXTURE, { waitUntil: "load" });
  await settleImages(page);
  const out = (await page.evaluate(`
    (async () => {
      const b = document.getElementById("b");
      // Dimensions are all an image contributes to layout, and they
      // came over as metadata; the pixels have to be unreachable.
      // Read the size BEFORE the canvas work: a refused draw drops the
      // element back to 0, which would read as "no metadata arrived".
      const w = b.naturalWidth;
      const h = b.naturalHeight;
      const complete = b.complete;
      const cv = document.createElement("canvas");
      cv.width = 8;
      cv.height = 8;
      document.body.appendChild(cv);
      const cx = cv.getContext("2d");
      let read = "";
      try {
        cx.drawImage(b, 0, 0);
        await new Promise((r) => setTimeout(r, 300));
        const d = cx.getImageData(4, 4, 1, 1).data;
        read = d[0] + "," + d[1] + "," + d[2] + "," + d[3];
      } catch (e) {
        read = "THREW:" + ((e && e.name) ? e.name : String(e));
      }
      let fetched = "";
      try {
        const r = await fetch(${JSON.stringify(CROSS_IMAGE)});
        fetched = "OK:" + (await r.arrayBuffer()).byteLength;
      } catch (e) {
        fetched = "THREW:" + ((e && e.name) ? e.name : String(e));
      }
      return { w, h, complete, read, fetched };
    })()
  `)) as Record<string, unknown>;
  expect(out.w).toBe(8);
  expect(out.h).toBe(8);
  expect(out.complete).toBe(true);
  expect(String(out.read)).toContain("SecurityError");
  expect(out.fetched).toBe("THREW:TypeError");
}, 120_000);

test("there is no route back: the engine store is not page-reachable", async ({ page }) => {
  const before = await imageStore(page);
  await page.goto(FIXTURE, { waitUntil: "load" });
  await settleImages(page);
  const after = await imageStore(page);
  expect(after.count - before.count).toBe(1);

  const out = (await page.evaluate(`
    (async () => {
      const pull = async (u) => {
        try {
          const p = await fetch(u);
          return p.ok ? "BYTES:" + (await p.arrayBuffer()).byteLength : "STATUS:" + p.status;
        } catch (e) {
          return "THREW:" + (e && e.name ? e.name : String(e));
        }
      };
      // Top bit set, i.e. shaped like an engine-minted key. Identity
      // is minted, never derived, so this is the best a page can do.
      const key = "9223372036854775809";
      return {
        sentinel: await pull("http://kitesurf-resources/" + key),
        asPath: await pull("/__ks_resource/" + key),
        learnKey: await pull(${JSON.stringify(CROSS_IMAGE)}),
      };
    })()
  `)) as { sentinel: string; asPath: string; learnKey: string };
  expect(out.sentinel.startsWith("BYTES:")).toBe(false);
  expect(out.asPath.startsWith("BYTES:")).toBe(false);
  expect(out.learnKey.startsWith("BYTES:")).toBe(false);
}, 120_000);

test("same-origin SVG keeps its bytes, since usvg parses in the isolate", async ({ page }) => {
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  const out = (await page.evaluate(`
    fetch("/__fixtures/svg-document.svg?case=sized").then(async (r) => ({
      w: r.headers.get("x-kitesurf-image-width"),
      bodyBytes: (await r.arrayBuffer()).byteLength,
    }))
  `)) as Record<string, unknown>;
  expect(out.w).toBeNull();
  expect(out.bodyBytes as number).toBeGreaterThan(0);
}, 120_000);

test("an image with no engine key still paints (hash fallback)", async ({ page }) => {
  await page.setViewport({ width: 200, height: 200 });
  await page.setContent(
    `<html><body style="margin:0;background:#fff">` +
      `<img id="d" style="display:block;width:40px;height:40px" ` +
      `src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR42mP4z8DwHx9mGBkKAMLXf4HVAzL9AAAAAElFTkSuQmCC">` +
      `</body></html>`,
  );
  const png = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));
  expect(isRed(pixel(png, 20, 20))).toBe(true);
}, 120_000);
