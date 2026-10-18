// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { waitForTitle } from "../waits";
import { decodePng, sample, near } from "./png";
import { setContent } from "../set-content";
import html from "../html/canvas-2d-draw.html?raw";

test("canvas-2d-draw-demo", async ({ page }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded", timeout: 30000 });

  const title = await waitForTitle(page, "CANVASDRAW:", {
    prefix: true,
    timeout: 20000,
  });
  expect(title.startsWith("CANVASDRAW:"), "fixture never reported").toBeTruthy();
  const api = JSON.parse(title.slice("CANVASDRAW:".length));
  expect(api.ctxOk, "getContext('2d') non-null").toBe(true);
  expect(api.fillStyleSerialized, "fillStyle 'red' serializes to hex").toBe("#ff0000");
  expect(api.invalidIgnored, "invalid color assignment ignored").toBe("#ff0000");
  expect(api.redAt, "fillRect red readback").toBe("255,0,0,255");
  expect(api.blueAt, "arc+fill blue circle readback").toBe("0,0,255,255");
  expect(api.greenAt, "translated fillRect readback").toBe("0,128,0,255");
  expect(api.notchAt, "clearRect notch is transparent").toBe("0,0,0,0");
  expect(api.clippedAt, "black fill lands inside clip").toBe("0,0,0,255");
  expect(api.unclippedAt, "gradient survives outside clip").not.toBe("0,0,0,255");
  expect(api.measuredWidth, "measureText width > 0").toBeGreaterThan(5);
  expect(api.textInkDelta, "fillText added inked pixels").toBeGreaterThan(10);
  expect(api.dataUrlOk, "toDataURL returns a real PNG").toBe(true);
  expect(api.pointIn, "isPointInPath inside clip rect path").toBe(true);

  await new Promise((r) => setTimeout(r, 500));
  const shot = new Uint8Array(await page.screenshot({ type: "png" }));
  const png = decodePng(shot);

  const cases: Array<[string, number, number, [number, number, number]]> = [
    ["fillRect red", 40 + 50, 30 + 40, [255, 0, 0]],
    ["circle blue", 40 + 150, 30 + 40, [0, 0, 255]],
    ["translated green", 40 + 50, 30 + 100, [0, 128, 0]],
    ["stroke white", 40 + 50, 30 + 120, [255, 255, 255]],
    ["gradient left ~red", 40 + 104, 30 + 150, [250, 20, 0]],
    ["gradient right ~yellow", 40 + 196, 30 + 150, [255, 245, 0]],
    ["clearRect notch grey", 40 + 5, 30 + 65, [128, 128, 128]],
    ["clipped black", 40 + 130, 30 + 14, [0, 0, 0]],
    ["page background grey", 40 + 260, 30 + 40, [128, 128, 128]],
  ];
  for (const [label, x, y, want] of cases) {
    const got = sample(png, x, y);
    expect(
      near(got, want, 25),
      `${label} @(${x},${y}): got rgb(${got.join(",")}) want rgb(${want.join(",")})`,
    ).toBe(true);
  }
});
