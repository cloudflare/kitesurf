// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { decodePng, sample, near } from "./png";

test("iframe-bitmap-paint", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/iframe-bitmap.html", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  const rc = await page.evaluate(() => {
    const el = document.querySelector("iframe#tgt") as any;
    if (!el) return { ok: false, why: "iframe not found" };
    const nodeId: number = el._id;
    if (typeof nodeId !== "number" || nodeId <= 0) {
      return { ok: false, why: `bad _id: ${nodeId}` };
    }
    const W = 200,
      H = 150;
    const rgba = new Uint8Array(W * H * 4);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = 255;
      rgba[i + 1] = 0;
      rgba[i + 2] = 0;
      rgba[i + 3] = 255;
    }
    const dom = (globalThis as any).__ks_dom_debug;
    if (!dom || typeof dom.setIframeImage !== "function") {
      return { ok: false, why: "setIframeImage not exposed" };
    }
    const result = dom.setIframeImage(nodeId, W, H, rgba);
    return { ok: true, nodeId, rc: result };
  });
  expect(rc.ok, `push failed: ${JSON.stringify(rc)}`).toBe(true);
  expect((rc as any).rc >= 0, `setIframeImage returned error rc=${(rc as any).rc}`).toBe(true);

  const shot = new Uint8Array(await page.screenshot({ type: "png" }));
  const png = decodePng(shot);

  const cases: Array<[string, number, number, [number, number, number]]> = [
    ["iframe center red", 120, 95, [255, 0, 0]],
    ["iframe top-left red", 25, 25, [255, 0, 0]],
    ["iframe bottom-right red", 215, 165, [255, 0, 0]],
    ["outside iframe (right) white", 300, 95, [255, 255, 255]],
    ["outside iframe (below) white", 120, 200, [255, 255, 255]],
  ];
  for (const [label, x, y, want] of cases) {
    const got = sample(png, x, y);
    expect(
      near(got, want),
      `${label} @(${x},${y}): got rgb(${got.join(",")}) want rgb(${want.join(",")})`,
    ).toBe(true);
  }
});
