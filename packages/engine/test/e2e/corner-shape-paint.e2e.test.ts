// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";
import { decodePng } from "./png";
import { setContent } from "./set-content";

type Rgb = [number, number, number];
type Probe = [label: string, x: number, y: number, colour: Rgb];

const WHITE: Rgb = [255, 255, 255];
const GREEN: Rgb = [0, 128, 0];

function box(left: number, top: number, style: string): string {
  return `<div style="position:absolute;left:${left}px;top:${top}px;width:100px;height:100px;background:rgb(0,128,0);${style}"></div>`;
}

async function expectProbes(page: Page, boxes: string, probes: Probe[]): Promise<void> {
  await page.setViewport({ width: 800, height: 200 });
  await setContent(page, `<style>body { margin: 0; background: #fff }</style>${boxes}`);
  const png = await decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
  const pixel = (x: number, y: number): Rgb => {
    const i = (y * png.width + x) * 4;
    if (x < 0 || y < 0 || x >= png.width || i + 2 >= png.data.length) {
      throw new Error(`(${x},${y}) is outside the ${png.width}x${png.height} screenshot`);
    }
    return [png.data[i] ?? 0, png.data[i + 1] ?? 0, png.data[i + 2] ?? 0];
  };
  for (const [label, x, y, colour] of probes) {
    const [r, g, b] = pixel(x, y);
    const off = Math.abs(r - colour[0]) + Math.abs(g - colour[1]) + Math.abs(b - colour[2]);
    expect(off, `${label}: rgb(${r},${g},${b}) at (${x},${y})`).toBeLessThan(40);
  }
}

test("corner-shape cuts the background", async ({ page }) => {
  await expectProbes(
    page,
    box(20, 20, "border-radius:50px") +
      box(160, 20, "border-radius:50px;corner-shape:bevel") +
      box(300, 20, "border-radius:50px;corner-shape:scoop") +
      box(440, 20, "border-radius:50px;corner-shape:squircle") +
      box(580, 20, "border-radius:30px;corner-shape:notch"),
    [
      ["round keeps (20,20) of its radius box", 40, 40, GREEN],
      ["round drops (10,10)", 30, 30, WHITE],
      ["bevel cuts (20,20) off below its chord", 180, 40, WHITE],
      ["bevel keeps (40,40)", 200, 60, GREEN],
      ["scoop cuts (20,20) inside its concave arc", 320, 40, WHITE],
      ["scoop keeps (40,40)", 340, 60, GREEN],
      ["squircle keeps (10,10), outside round's arc", 450, 30, GREEN],
      ["notch cuts its whole radius box", 605, 45, WHITE],
      ["notch keeps the cross between its corners", 620, 60, GREEN],
    ],
  );
});

test("corner-shape bends a solid border along the shape", async ({ page }) => {
  await expectProbes(
    page,
    `<div style="position:absolute;left:20px;top:20px;width:80px;height:80px;background:rgb(0,128,0);
      border:10px solid rgb(0,0,255);border-radius:50px;corner-shape:bevel"></div>
    <div style="position:absolute;left:160px;top:20px;width:80px;height:80px;background:rgb(0,128,0);
      border:10px solid rgb(0,0,255);border-top-color:rgb(255,0,0);border-radius:50px;corner-shape:scoop"></div>`,
    [
      ["the bevel border runs along the chord", 50, 50, [0, 0, 255]],
      ["the bevel's inner edge is the chord moved 10px in", 60, 60, GREEN],
      ["the scoop's top edge takes the top colour", 210, 34, [255, 0, 0]],
      ["the scoop's right edge takes the right colour", 245, 70, [0, 0, 255]],
    ],
  );
});

test("a thick border side keeps its colour to its own side of a shaped box", async ({ page }) => {
  const colours = "border-color:rgb(255,0,0) rgb(0,200,0) rgb(0,0,255) rgb(255,165,0)";
  const red: Rgb = [255, 0, 0];
  await expectProbes(
    page,
    `<div style="position:absolute;left:20px;top:20px;width:192px;height:24px;background:#fff;
      border-style:solid;border-width:4px 4px 12px 4px;${colours};border-radius:16px;corner-shape:bevel"></div>
    <div style="position:absolute;left:300px;top:20px;width:100px;height:60px;background:#fff;
      border-style:solid;border-width:6px 40px 6px 6px;${colours};border-radius:30px;corner-shape:scoop"></div>`,
    [
      ["the 12px bottom leaves the top edge its own colour", 120, 22, red],
      ["the bottom edge takes the bottom colour", 120, 54, [0, 0, 255]],
      ["the 40px right side leaves the far top-left arc its own colour", 325, 41, red],
      ["the right side takes the right colour", 426, 56, [0, 200, 0]],
    ],
  );
});

test("outset shadows keep each corner's radius and shape", async ({ page }) => {
  const shadow = "box-shadow:0 0 0 10px #000";
  await expectProbes(
    page,
    box(40, 40, `border-radius:50px;corner-shape:bevel;${shadow}`) +
      box(200, 40, `border-radius:50px 0 0 0;${shadow}`) +
      box(360, 40, `border-radius:20px;${shadow}`),
    [
      ["the bevel's shadow follows the chord, not an arc", 48, 48, WHITE],
      ["the bevel's shadow reaches 10px out along the chord", 56, 66, [0, 0, 0]],
      ["a sharp corner's shadow stays sharp", 308, 32, [0, 0, 0]],
      ["the round corner's radius grows by the spread", 200, 35, WHITE],
      ["a uniform radius grows by the spread too", 357, 37, WHITE],
    ],
  );
});
