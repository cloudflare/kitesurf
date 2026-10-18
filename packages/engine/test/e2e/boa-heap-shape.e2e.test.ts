// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import type { Page } from "@cloudflare/puppeteer";
import { targetIdForSession } from "./connect";

async function stats(page: Page) {
  const session = await page.createCDPSession();
  const targetId = await targetIdForSession(session);
  const s = await session.send("Kitesurf.getMemoryStats", { targetId });
  await session.detach().catch(() => {});
  return s;
}

async function forceCollect(page: Page): Promise<void> {
  const session = await page.createCDPSession();
  const targetId = await targetIdForSession(session);
  await session.send("Kitesurf.boaForceCollect", { targetId });
  await session.detach().catch(() => {});
}

test("fragmentation fixture: interleaved churn stays under the high-water bound", async ({
  page,
}) => {
  await setContent(page, "<p>heap-shape</p>");
  const kept = await page.evaluate(() => {
    const keep: unknown[] = [];
    let big: number[] = [];
    for (let round = 0; round < 200; round++) {
      for (let i = 0; i < 2000; i++) {
        const o = { a: i, b: "s" + i, c: round };
        if (i % 37 === 0) keep.push(o);
      }
      for (let i = 0; i < 200; i++) big.push(round * 1000 + i);
    }
    (globalThis as { __keep?: unknown }).__keep = { keep, big };
    return keep.length;
  });
  expect(kept).toBeGreaterThan(10000);
  const s = await stats(page);
  if (s.wasmDeltaBytes === undefined) throw new Error("wasmDeltaBytes missing from getMemoryStats");
  const deltaMiB = s.wasmDeltaBytes / 1048576;
  expect(deltaMiB, `wasm high-water ${deltaMiB.toFixed(1)} MiB`).toBeLessThan(16);
});

test("gc accounting parity: threshold keeps the live/0.7 shape", async ({ page }) => {
  await setContent(page, "<p>gc-parity</p>");
  await page.evaluate(() => {
    const keep: unknown[] = [];
    for (let i = 0; i < 100000; i++) keep.push({ x: i, s: "p" + i });
    return keep.length;
  });
  const held = await stats(page);
  if (!held.bridge) throw new Error("bridge gauges missing from getMemoryStats");
  const heap = held.bridge.boaHeapBytes;
  const threshold = held.bridge.boaGcThreshold;
  expect(heap, "burst is resident on the boa heap").toBeGreaterThan(2 * 1048576);
  expect(threshold, "threshold never drops below boa's 1 MiB floor").toBeGreaterThanOrEqual(
    1048576,
  );
  expect(threshold, "threshold keeps the ~live/0.7 shape (loose upper bound)").toBeLessThan(
    Math.max(heap * 3, 8 * 1048576),
  );

  await forceCollect(page);
  const dropped = await stats(page);
  if (!dropped.bridge) throw new Error("bridge gauges missing from getMemoryStats");
  expect(dropped.bridge.boaHeapBytes, "collect returns most of the burst").toBeLessThan(heap / 2);
});
