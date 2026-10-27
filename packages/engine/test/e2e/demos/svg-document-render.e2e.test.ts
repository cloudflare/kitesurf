// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { decodePng, sample, near, type DecodedPng } from "./png";

const URL_BASE = "http://127.0.0.1:8787/__fixtures/svg-document.svg";

function bbox(
  png: DecodedPng,
  want: [number, number, number],
): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (near(sample(png, x, y), want, 6)) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

async function shoot(page: any, which: string): Promise<DecodedPng> {
  await page.goto(`${URL_BASE}?case=${which}`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await new Promise((r) => setTimeout(r, 400));
  return decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
}

test("svg-document-render", async ({ page }) => {
  {
    const png = await shoot(page, "sized");
    const blue = bbox(png, [0, 81, 195]);
    expect(blue, "no blue rect — SVG document did not render").not.toBeNull();
    expect(blue!.x0, "blue starts at the left edge").toBe(0);
    expect(blue!.y0, "blue starts at the top edge (no body margin)").toBe(0);
    expect(blue!.x1, "blue is 100px wide").toBe(99);
    expect(blue!.y1, "blue is 120px tall").toBe(119);
    expect(near(sample(png, 150, 60), [238, 238, 238]), "grey backdrop").toBe(true);
  }

  {
    const png = await shoot(page, "prologue");
    const green = bbox(png, [0, 128, 0]);
    expect(green, "prologue case did not render").not.toBeNull();
    expect([green!.x0, green!.y0, green!.x1, green!.y1]).toEqual([0, 0, 99, 99]);
  }

  {
    const png = await shoot(page, "viewbox");
    const purple = bbox(png, [128, 0, 128]);
    expect(purple, "viewbox case did not render").not.toBeNull();
    const vw = png.width;
    const vh = png.height;
    const scale = Math.min(vw / 100, vh / 50);
    const drawnH = Math.round(50 * scale);
    expect(purple!.x0).toBe(0);
    expect(purple!.x1).toBe(vw - 1);
    const bar = Math.round((vh - drawnH) / 2);
    expect(Math.abs(purple!.y0 - bar), `top bar ~${bar}, got ${purple!.y0}`).toBeLessThanOrEqual(1);
    expect(Math.abs(purple!.y1 - (bar + drawnH - 1))).toBeLessThanOrEqual(1);
  }

  {
    const png = await shoot(page, "metadata");
    const green = bbox(png, [0, 128, 0]);
    expect(green, "nothing rendered after <metadata> -- svg was truncated").not.toBeNull();
    expect([green!.x0, green!.y0, green!.x1, green!.y1]).toEqual([0, 0, 119, 59]);
  }

  {
    const png = await shoot(page, "styled");
    expect(near(sample(png, 60, 30), [255, 136, 0]), "currentColor fill applied").toBe(true);
  }
});
