// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("a canvas keeps its natural size in a narrower container, as in Chrome", async ({ page }) => {
  const svg = encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"/>`,
  );
  await setContent(
    page,
    `<style>body { margin: 0 } div { width: 200px; height: 100px; position: relative }</style>
    <div><canvas id="flow" width="400" height="300"></canvas></div>
    <div><canvas id="abspos" width="400" height="300" style="position: absolute; top: 0; left: 0"></canvas></div>
    <div style="width: 100px"><canvas id="default"></canvas></div>
    <div><canvas id="capped" width="400" height="300" style="max-width: 100%"></canvas></div>
    <div><img id="img" src="data:image/svg+xml,${svg}"></div>`,
  );
  await page.waitForFunction(
    () => (document.getElementById("img")?.getBoundingClientRect().width ?? 0) > 0,
  );
  const sizes = await page.evaluate(() =>
    Object.fromEntries(
      ["flow", "abspos", "default", "capped", "img"].map((id) => {
        const r = document.getElementById(id)?.getBoundingClientRect();
        return [id, r ? [r.width, r.height] : null];
      }),
    ),
  );
  expect(sizes).toEqual({
    flow: [400, 300],
    abspos: [400, 300],
    default: [300, 150],
    capped: [200, 150],
    img: [200, 150],
  });
});
