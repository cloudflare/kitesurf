// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

test("Runtime.getHeapUsage returns wasm bytes after a navigate", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/lifecycle.html", {
    waitUntil: "domcontentloaded",
  });
  const cdp = await page.createCDPSession();
  const usage = (await cdp.send("Runtime.getHeapUsage")) as {
    usedSize: number;
    totalSize: number;
  };
  expect(usage.usedSize).toBeGreaterThan(1_000_000);
  expect(usage.totalSize).toBeGreaterThanOrEqual(usage.usedSize);

  await page.screenshot({ type: "png" });
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId: "kitesurf-page-renderer",
    flatten: true,
  });
  expect(sessionId).toBeTruthy();
  const rendererSession = cdp.connection()?.session(sessionId);
  if (!rendererSession) throw new Error(`no session ${sessionId} on the connection`);
  const rendererUsage = await rendererSession.send("Runtime.getHeapUsage");
  expect(rendererUsage.usedSize).toBeGreaterThan(1_000_000);
  expect(rendererUsage.totalSize).toBeGreaterThanOrEqual(rendererUsage.usedSize);
}, 120_000);

test("getMemoryStats.total covers engine + pageScripts + renderer", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/lifecycle.html", {
    waitUntil: "domcontentloaded",
  });
  const cdp = await page.createCDPSession();
  await page.screenshot({ type: "png" });

  const { total, engine, renderer } = await cdp.send("Kitesurf.getMemoryStats");
  if (!total || !engine || !renderer) {
    throw new Error("getMemoryStats without a targetId must carry the aggregates");
  }
  expect(total.engineBytes).toBeGreaterThan(0);
  expect(total.pageScriptBytes).toBeGreaterThan(0);
  expect(total.rendererBytes).toBeGreaterThan(0);
  expect(total.bytes).toBe(total.engineBytes + total.pageScriptBytes + total.rendererBytes);
  expect(total.engineBytes).toBe(engine.accountedBytes);
  expect(total.rendererBytes).toBe(renderer.wasmBytes);

  const rowOf = async (targetId: string): Promise<number> => {
    const { sessionId } = await cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const session = cdp.connection()?.session(sessionId);
    if (!session) throw new Error(`no session ${sessionId} on the connection`);
    return (await session.send("Runtime.getHeapUsage")).usedSize;
  };
  const SLACK = 16 * 1024 * 1024;
  const mainRow = (await cdp.send("Runtime.getHeapUsage")).usedSize;
  const engineRow = await rowOf("kitesurf-engine");
  const rendererRow = await rowOf("kitesurf-page-renderer");
  for (const [part, row] of [
    [total.pageScriptBytes, mainRow],
    [total.engineBytes, engineRow],
    [total.rendererBytes, rendererRow],
  ] as Array<[number, number]>) {
    expect(row).toBeGreaterThanOrEqual(part);
    expect(row).toBeLessThanOrEqual(part + SLACK);
  }
}, 120_000);
