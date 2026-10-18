// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import type { Page } from "@cloudflare/puppeteer";
import { targetIdForSession } from "./connect";

interface BridgeStats {
  v8Pins: number;
  boaPins: number;
  wrappers: number;
  releasedV8: number;
  releasedBoa: number;
}

async function bridgeStats(page: Page): Promise<BridgeStats> {
  const session = await page.createCDPSession();
  const targetId = await targetIdForSession(session);
  const stats = await session.send("Kitesurf.getMemoryStats", { targetId });
  await session.detach().catch(() => {});
  const bridge = stats.bridge;
  if (!bridge) throw new Error(`no bridge stats in ${JSON.stringify(stats).slice(0, 200)}`);
  return bridge;
}

test("bridge pin counters are exposed and numeric", async ({ page }) => {
  await setContent(page, "<p>pins</p>");
  await page.evaluate(() => document.body.tagName);
  const b = await bridgeStats(page);
  for (const k of ["v8Pins", "boaPins", "wrappers", "releasedV8", "releasedBoa"] as const) {
    expect(typeof b[k], k).toBe("number");
  }
  expect(b.v8Pins, "evaluate crossed the bridge at least once").toBeGreaterThan(0);
});

test("fresh crossings mint pins; identical crossings dedupe", async ({ page }) => {
  await setContent(page, "<div id=t>x</div>");
  await page.evaluate(() => document.getElementById("t")?.tagName ?? "missing #t");

  const mints = (b: BridgeStats) => b.boaPins + b.releasedBoa;
  const before = await bridgeStats(page);
  await page.evaluate(() => {
    const d = document.getElementById("t");
    if (!d) throw new Error("missing #t");
    for (let i = 0; i < 300; i++) d.onclick = function () {};
  });
  const afterFresh = await bridgeStats(page);
  expect(
    mints(afterFresh) - mints(before),
    "300 fresh closures crossing boa->V8 each mint a pin",
  ).toBeGreaterThanOrEqual(300);

  await page.evaluate(() => {
    const d = document.getElementById("t");
    if (!d) throw new Error("missing #t");
    const f = function () {};
    for (let i = 0; i < 300; i++) d.onclick = f;
  });
  const afterSame = await bridgeStats(page);
  expect(
    mints(afterSame) - mints(afterFresh),
    "re-crossing ONE closure dedupes via the identity stamp",
  ).toBeLessThan(100);
});

test("wrapper death releases the boa pin (Phase 3 eviction)", async ({ page }) => {
  // A GC can run while the 200 wrappers are minted, and a baseline read after that already
  // holds their releases, so count from before. Big arrays land in old space: a major GC.
  await setContent(
    page,
    `<div id=t>gc</div><script>globalThis.__pressure = function () {
      let a = []; for (let i = 0; i < 16; i++) a.push(new Array(1 << 17).fill(i));
      return a.length;
    };<\/script>`,
  );
  const before = await bridgeStats(page);
  await page.evaluate(() => {
    const d = document.getElementById("t");
    if (!d) throw new Error("missing #t");
    // Only the LAST wrapper stays reachable from the shim; the other
    // 199 become garbage the FinalizationRegistry must reclaim.
    for (let i = 0; i < 200; i++) d.onclick = function () {};
  });
  let released = (await bridgeStats(page)).releasedBoa - before.releasedBoa;
  for (let round = 0; round < 200 && released < 150; round++) {
    await page.evaluate(() =>
      (globalThis as typeof globalThis & { __pressure(): number }).__pressure(),
    );
    released = (await bridgeStats(page)).releasedBoa - before.releasedBoa;
  }
  expect(released, "most of the 199 dead wrappers released their boa pins").toBeGreaterThanOrEqual(
    150,
  );
});

test("burst-minted wrappers release under GC pressure (stranding regression)", async ({ page }) => {
  await setContent(
    page,
    `<p>burst</p><script>
      globalThis.__hammer = (n) => { const cb = globalThis.__cb; for (let i = 0; i < n; i++) cb(); return n; };
      globalThis.__pressure = () => { let a = []; for (let i = 0; i < 200000; i++) a.push({ x: i }); return a.length; };
    <\/script>`,
  );
  await page.evaluate(() => {
    (globalThis as { __cb?: unknown }).__cb = () => ({});
    return 1;
  });
  const before = await bridgeStats(page);
  await page.evaluate(() =>
    (globalThis as typeof globalThis & { __hammer(n: number): number }).__hammer(5000),
  );
  let released = 0;
  for (let round = 0; round < 40 && released < 4500; round++) {
    await page.evaluate(() =>
      (globalThis as typeof globalThis & { __pressure(): number }).__pressure(),
    );
    const now = await bridgeStats(page);
    released = now.releasedBoa - before.releasedBoa;
  }
  expect(released, "≥90% of 5000 burst mints must release, not strand").toBeGreaterThanOrEqual(
    4500,
  );
}, 120000);

test("boa GC collecting a proxy releases its V8 pin (Phase 4 eviction)", async ({ page }) => {
  await setContent(page, "<div id=t>p4</div>");
  const before = await bridgeStats(page);
  await page.evaluate(() => {
    const d = document.getElementById("t");
    if (!d) throw new Error("missing #t");
    for (let i = 0; i < 500; i++) d.getBoundingClientRect();
  });
  let releasedV8 = 0;
  for (let round = 0; round < 30 && releasedV8 === 0; round++) {
    await page.evaluate(() => {
      const a: unknown[] = [];
      for (let i = 0; i < 50000; i++) a.push({ x: i });
      return a.length;
    });
    const now = await bridgeStats(page);
    releasedV8 = now.releasedV8 - before.releasedV8;
  }
  expect(releasedV8, "boa GC + drain released V8 pins").toBeGreaterThan(0);
});

test("repeated method reads reuse one pin (Phase 1 dedupe)", async ({ page }) => {
  await setContent(page, "<div id=t>m</div>");
  await page.evaluate(() => document.getElementById("t"));
  const before = await bridgeStats(page);
  await page.evaluate(() => {
    for (let i = 0; i < 300; i++) {
      document.getElementById("t");
      void document.body.appendChild;
    }
  });
  const after = await bridgeStats(page);
  expect(
    after.v8Pins - before.v8Pins,
    "300 reads of the same methods must not pin per read",
  ).toBeLessThan(100);
});
