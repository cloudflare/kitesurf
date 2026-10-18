// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { decodePng, sample, near } from "./png";

test("oopif-rerender", async ({ page }) => {
  await page.goto("http://localhost:8787/__fixtures/oopif-host-color-swap.html", {
    waitUntil: "load",
    timeout: 60000,
  });

  const shot1 = new Uint8Array(await page.screenshot({ type: "png" }));
  const png1 = decodePng(shot1);
  const firstColor = sample(png1, 200, 150);

  await new Promise((r) => setTimeout(r, 1500));

  const shot2 = new Uint8Array(await page.screenshot({ type: "png" }));
  const png2 = decodePng(shot2);
  const secondColor = sample(png2, 200, 150);

  expect(
    near(secondColor, [0, 255, 0]),
    `after 1500ms wait iframe should be green; got rgb(${secondColor.join(",")}) (first frame was rgb(${firstColor.join(",")}))`,
  ).toBe(true);

  const outside = sample(png2, 500, 150);
  expect(
    near(outside, [255, 255, 255]),
    `outside iframe should stay white; got rgb(${outside.join(",")})`,
  ).toBe(true);
});
