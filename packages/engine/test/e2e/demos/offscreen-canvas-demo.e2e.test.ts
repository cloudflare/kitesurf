// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("offscreen-canvas-demo", async ({ page }) => {
  const BASE = "http://127.0.0.1:8787";

  await page.goto(BASE + "/__fixtures/inline-script.html");

  const probe = await page.evaluate(() => {
    const attempt = (run: () => void) => {
      try {
        run();
        return "no-throw";
      } catch (error) {
        return error instanceof Error ? error.name : "threw";
      }
    };
    const out: {
      width?: number;
      height?: number;
      hasCtx?: boolean;
      measured?: number;
      webgl?: unknown;
      noNew?: string;
      oneArg?: string;
      error?: string;
    } = {};
    try {
      const oc = new OffscreenCanvas(120, 60);
      out.width = oc.width;
      out.height = oc.height;
      const ctx = oc.getContext("2d");
      out.hasCtx = !!ctx;
      ctx.font = "16px sans-serif";
      out.measured = ctx.measureText("Hello Radar").width;
      out.webgl = oc.getContext("webgl");
      out.noNew = attempt(() => {
        // @ts-expect-error deliberate call without `new`; the test checks it throws
        OffscreenCanvas(1, 1);
      });
      out.oneArg = attempt(() => {
        // @ts-expect-error deliberate missing height; the test checks it throws
        new OffscreenCanvas(1);
      });
    } catch (e) {
      out.error = String((e && e.message) || e);
    }
    return out;
  });

  expect(probe.error, "no throw: " + JSON.stringify(probe)).toBeUndefined();
  expect(probe.width, "constructor width").toBe(120);
  expect(probe.height, "constructor height").toBe(60);
  expect(probe.hasCtx, "2d context returned").toBe(true);
  expect(
    typeof probe.measured === "number" && probe.measured > 0,
    "measureText returned a real width: " + probe.measured,
  ).toBeTruthy();
  expect(probe.webgl, "unsupported context types answer null").toBeNull();
  expect(probe.noNew, "calling without new throws TypeError").toBe("TypeError");
  expect(probe.oneArg, "missing height throws TypeError").toBe("TypeError");
});
