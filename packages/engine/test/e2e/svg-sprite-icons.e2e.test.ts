// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { decodePng } from "./png";

test("external svg sprite icons paint", async ({ page }) => {
  await page.setViewport({ width: 800, height: 400 });
  await page.goto("http://127.0.0.1:8787/__fixtures/sprite-icons.html", {
    waitUntil: "load",
    timeout: 30000,
  });

  const png = await decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
  const px = (x: number, y: number) => {
    const i = (y * png.width + x) * 4;
    return [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!];
  };
  const near = (got: number[], want: number[]) =>
    Math.abs(got[0]! - want[0]!) + Math.abs(got[1]! - want[1]!) + Math.abs(got[2]! - want[2]!) < 60;
  expect(near(px(70, 70), [22, 163, 74]), `ext href icon rgb(${px(70, 70)})`).toBe(true);
  expect(near(px(190, 70), [37, 99, 235]), `ext xlink:href icon rgb(${px(190, 70)})`).toBe(true);
  expect(near(px(310, 70), [220, 38, 38]), `local ref control rgb(${px(310, 70)})`).toBe(true);
});
