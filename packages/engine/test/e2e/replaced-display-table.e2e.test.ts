// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("replaced elements with display:table keep their replaced size", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><title>t</title>
    <canvas id="c" style="display:table">fallback</canvas>
    <video id="v" style="display:table"><source src="x.mp4"></video>
    <iframe id="f" style="display:table">fallback</iframe>`,
  );
  const sizes = await page.evaluate(`["c", "v", "f"].map((id) => {
    const r = document.getElementById(id).getBoundingClientRect();
    return id + ":" + Math.round(r.width) + "x" + Math.round(r.height);
  }).join(" ")`);
  expect(sizes).toBe("c:300x150 v:300x150 f:304x154");
}, 60_000);
