// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { readChildFrameCount, readRendererInfo } from "../cdp-read";
import { expect, test, type BrowserFactory } from "../harness";
import { decodePng, near, sample } from "./png";

const SKIP_SPECULATIVE_RASTER_HEADER = "x-kitesurf-skip-raster";

const FIXTURE = "https://ks.invalid/__fixtures/oopif-host-color-swap.html";

async function loadFixtureAndProbe(
  browserFactory: BrowserFactory,
  headers: Record<string, string>,
) {
  const browser = await browserFactory({ headers });
  const page = await browser.newPage();
  const session = await page.createCDPSession();
  await page.goto(FIXTURE, { waitUntil: "load", timeout: 60_000 });
  return {
    page,
    session,
    rendererInfo: () => readRendererInfo(session),
  };
}

test("skip-speculative-raster: no renderer isolate on a pixel-free connection", async ({
  browserFactory,
}) => {
  const { page, session, rendererInfo } = await loadFixtureAndProbe(browserFactory, {
    [SKIP_SPECULATIVE_RASTER_HEADER]: "1",
  });
  expect(
    await readChildFrameCount(session),
    "cross-origin child frame attached (the fixture exercises OOPIF)",
  ).toBeGreaterThanOrEqual(1);

  const info = await rendererInfo();
  expect(info.active, `no renderer manager after load; got ${JSON.stringify(info)}`).toBe(false);
  expect(info.framesRendered, "no frames rasterized").toBe(0);

  await new Promise((r) => setTimeout(r, 1500));
  const png = decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
  const iframeCenter = sample(png, 200, 150);
  expect(
    near(iframeCenter, [0, 255, 0]),
    `iframe still composites on demand; got rgb(${iframeCenter.join(",")})`,
  ).toBe(true);
  const after = await rendererInfo();
  expect(after.active, "renderer spun up for the screenshot").toBe(true);
});

test("skip-speculative-raster: default connection still rasters at load", async ({
  browserFactory,
}) => {
  const { rendererInfo } = await loadFixtureAndProbe(browserFactory, {});
  const info = await rendererInfo();
  expect(info.active, `renderer manager active after load; got ${JSON.stringify(info)}`).toBe(true);
  expect(
    info.framesRendered,
    "load-time OOPIF composite rasterized the child",
  ).toBeGreaterThanOrEqual(1);
});
