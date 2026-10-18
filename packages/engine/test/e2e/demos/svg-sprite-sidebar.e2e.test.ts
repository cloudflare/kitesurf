// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { decodePng, sample, near } from "./png";

test("svg-sprite-sidebar", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/svg-sprite-sidebar.html", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  const shot = new Uint8Array(await page.screenshot({ type: "png" }));
  const png = decodePng(shot);

  const blue: [number, number, number] = [0, 81, 195];
  const white: [number, number, number] = [255, 255, 255];

  const cases: Array<[string, number, number, [number, number, number]]> = [
    ["icon center is CSS blue", 22, 21, blue],
    ["icon upper half (transform applied)", 22, 14, blue],
    ["below icon is background (not shifted down)", 22, 36, white],
    ["above icon is background", 22, 8, white],
    ["right of icon is background", 40, 21, white],
  ];
  for (const [label, x, y, want] of cases) {
    const got = sample(png, x, y);
    expect(
      near(got, want),
      `${label} @(${x},${y}): got rgb(${got.join(",")}) want rgb(${want.join(",")})`,
    ).toBe(true);
  }
});
