// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { decodePng, encodePng } from "./png";

test("page-renderer-relaunch-cache", async ({ page, cdpSession }) => {
  const SIDE = 96;
  const rgba = new Uint8Array(SIDE * SIDE * 4);
  for (let i = 0; i < SIDE * SIDE; i++) {
    rgba[i * 4] = (i * 31) & 255;
    rgba[i * 4 + 1] = (i * 7) & 255;
    rgba[i * 4 + 2] = 200;
    rgba[i * 4 + 3] = 255;
  }
  const imgB64 = Buffer.from(encodePng(SIDE, SIDE, rgba)).toString("base64");
  const HTML = `<!doctype html>
<html><body style="margin:0;background:#fff">
<h1 style="font-family:sans-serif">relaunch fixture</h1>
<img id="pat" width="${SIDE}" height="${SIDE}" src="data:image/png;base64,${imgB64}">
</body></html>`;
  await page.goto(`data:text/html,${encodeURIComponent(HTML)}`, {
    timeout: 20_000,
  });
  await new Promise((r) => setTimeout(r, 400));

  const info = () => cdpSession.send("Kitesurf.getRendererInfo");

  const shot1 = new Uint8Array(await page.screenshot({ type: "png" }));
  const before = await info();
  expect(before.framesRendered).toBeGreaterThanOrEqual(1);

  const disposed = await cdpSession.send("Kitesurf.disposeRenderer");
  expect(disposed.disposed).toBe(true);

  const shot2 = new Uint8Array(await page.screenshot({ type: "png" }));
  const after = await info();
  expect(after.framesRendered).toBeGreaterThan(before.framesRendered);

  const a = decodePng(shot1);
  const b = decodePng(shot2);
  expect({ w: b.width, h: b.height }).toStrictEqual({ w: a.width, h: a.height });
  let differing = 0;
  for (let i = 0; i < a.width * a.height * 4; i += 4) {
    if (Math.abs(a.pixels[i] - b.pixels[i]) > 8) differing += 1;
  }
  expect(
    differing / (a.width * a.height),
    "post-relaunch frame matches pre-relaunch frame",
  ).toBeLessThan(0.01);
});
