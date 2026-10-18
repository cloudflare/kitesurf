// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const FIXTURE_ORIGIN = "https://ks.invalid";
const FONT_TIMEOUT_MS = 10_000;
const MIN_FONT_WIDTH_DELTA_PX = 30;

test("linked font aliases and weight descriptors use the Bungee fixture", async ({
  page,
  cdpSession,
}) => {
  const fontResponses = new Map<string, number>();
  await cdpSession.send("Network.enable");
  cdpSession.on("Network.responseReceived", ({ type, response }) => {
    if (type === "Font") fontResponses.set(response.url, response.status);
  });

  await page.goto(`${FIXTURE_ORIGIN}/__fixtures/webfont-link.html`, { waitUntil: "load" });
  for (const suffix of ["", "?v=med"]) {
    await expect
      .poll(() => fontResponses.get(`${FIXTURE_ORIGIN}/__fixtures/bungee.woff2${suffix}`), {
        timeout: FONT_TIMEOUT_MS,
      })
      .toBe(200);
  }

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const width = (id: string): number => {
            const element = document.getElementById(id);
            if (!element) throw new Error(`Missing font fixture element: ${id}`);
            return element.getBoundingClientRect().width;
          };
          const fallback = width("fallback");
          return Math.min(
            ...["fixture", "fixturedesc", "fixturedesc500", "duo400", "duo500"].map((id) =>
              Math.abs(width(id) - fallback),
            ),
          );
        }),
      { timeout: FONT_TIMEOUT_MS },
    )
    .toBeGreaterThanOrEqual(MIN_FONT_WIDTH_DELTA_PX);
});
