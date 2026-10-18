// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Browser } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";
import { targetIdForSession } from "./connect";

const FIXTURE = "https://ks.invalid/__fixtures/shaping-metrics.html";
const SPAN_IDS = ["r", "b", "i", "s", "m", "l"] as const;

interface FixtureMetrics {
  widths: Record<string, number>;
  wasmDeltaBytes: number;
}

async function measure(browser: Browser, fixtureUrl: string): Promise<FixtureMetrics> {
  const page = await browser.newPage();
  try {
    await page.goto(fixtureUrl, { waitUntil: "load", timeout: 60000 });
    const raw: unknown = await page.evaluate(
      `(${JSON.stringify(SPAN_IDS)}).reduce((out, id) => {
        out[id] = document.getElementById(id).getBoundingClientRect().width;
        return out;
      }, {})`,
    );
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`width probe returned ${typeof raw}`);
    }
    const widths: Record<string, number> = {};
    for (const id of SPAN_IDS) {
      const w: unknown = Reflect.get(raw, id);
      if (typeof w !== "number" || !Number.isFinite(w)) {
        throw new Error(`#${id} width: expected a number, got ${String(w)}`);
      }
      widths[id] = w;
    }

    const session = await page.createCDPSession();
    const targetId = await targetIdForSession(session);
    const stats = await session.send("Kitesurf.getMemoryStats", { targetId });
    const delta = stats.wasmDeltaBytes;
    if (typeof delta !== "number" || !(delta > 0)) {
      throw new Error(`wasmDeltaBytes: expected a positive number, got ${String(delta)}`);
    }
    return { widths, wasmDeltaBytes: delta };
  } finally {
    await page.close();
  }
}

test("font modes shape identically; Lazy and PixelFree heaps stay small", async ({
  browserFactory,
}) => {
  const fullBrowser = await browserFactory();
  const full = await measure(fullBrowser, `${FIXTURE}?canvas=1`);
  await fullBrowser.disconnect();

  const lazyBrowser = await browserFactory();
  const lazy = await measure(lazyBrowser, FIXTURE);
  await lazyBrowser.disconnect();

  const pixelFreeBrowser = await browserFactory({
    headers: { "x-kitesurf-skip-raster": "1" },
  });
  const pixelFree = await measure(pixelFreeBrowser, FIXTURE);
  await pixelFreeBrowser.disconnect();

  const widthOf = (id: string): number => {
    const w = full.widths[id];
    if (w === undefined) throw new Error(`#${id} width missing`);
    return w;
  };
  for (const id of SPAN_IDS) {
    expect(widthOf(id), `#${id} width`).toBeGreaterThan(0);
  }
  expect(widthOf("b")).toBeGreaterThan(widthOf("r"));

  expect(lazy.widths).toEqual(full.widths);
  expect(pixelFree.widths).toEqual(full.widths);

  expect(lazy.wasmDeltaBytes).toBeLessThan(full.wasmDeltaBytes - 2_000_000);
  expect(pixelFree.wasmDeltaBytes).toBeLessThan(full.wasmDeltaBytes - 2_000_000);
});
