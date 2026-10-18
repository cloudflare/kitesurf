// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import type { Page } from "@cloudflare/puppeteer";
import { targetIdForSession } from "./connect";

const ORIGIN = "http://127.0.0.1:8787";

interface InternerStats {
  internerLen: number;
  internerReclaims: number;
  internerPendingMods: number;
}

async function internerStats(page: Page): Promise<InternerStats> {
  const session = await page.createCDPSession();
  const targetId = await targetIdForSession(session);
  const stats = await session.send("Kitesurf.getMemoryStats", { targetId });
  await session.detach().catch(() => {});
  const bridge = stats.bridge;
  if (!bridge || typeof bridge.internerLen !== "number") {
    throw new Error(`no interner stats in ${JSON.stringify(stats).slice(0, 200)}`);
  }
  return {
    internerLen: bridge.internerLen,
    internerReclaims: bridge.internerReclaims ?? 0,
    internerPendingMods: bridge.internerPendingMods ?? 0,
  };
}

async function settleAndStats(page: Page, priorReclaims: number): Promise<InternerStats> {
  let stats = await internerStats(page);
  for (let i = 0; i < 20 && stats.internerReclaims <= priorReclaims; i++) {
    await page.evaluate("1 + 1");
    stats = await internerStats(page);
  }
  return stats;
}

test("a parse burst's interner entries are reclaimed at the eval tail", async ({ page }) => {
  await setContent(page, "<p>interner</p>");
  await page.evaluate("1 + 1");
  const before = await internerStats(page);

  const n = 3000;
  const decls = Array.from({ length: n }, (_, i) => `let ks_uniq_ident_${i} = ${i};`).join("");
  const src = `(() => { ${decls} globalThis.__ks_keep = () => "alive"; return ks_uniq_ident_1 + ks_uniq_ident_${n - 1}; })()`;
  expect(await page.evaluate(src)).toBe(1 + (n - 1));

  const after = await settleAndStats(page, before.internerReclaims);
  expect(after.internerReclaims, "truncation must have fired").toBeGreaterThan(
    before.internerReclaims,
  );
  expect(
    after.internerLen - before.internerLen,
    `${n} burst identifiers must not stay interned`,
  ).toBeLessThan(200);

  expect(await page.evaluate("globalThis.__ks_keep()")).toBe("alive");
  expect(await page.evaluate(src)).toBe(1 + (n - 1));
});

test("module batches parse correctly across interner reclaims", async ({ page }) => {
  await page.goto(`${ORIGIN}/__fixtures/dynimport.html`, { waitUntil: "networkidle0" });

  const one = `${ORIGIN}/__fixtures/interner-batch-one.js`;
  const two = `${ORIGIN}/__fixtures/interner-batch-two.js`;

  expect(await page.evaluate(`import(${JSON.stringify(one)}).then(m => m.value)`)).toBe(42);
  const mid = await internerStats(page);
  const settled = await settleAndStats(page, 0);
  expect(settled.internerReclaims, "reclaim must fire between batches").toBeGreaterThan(0);

  expect(await page.evaluate(`import(${JSON.stringify(two)}).then(m => m.value)`)).toBe(24);
  expect(await page.evaluate(`import(${JSON.stringify(two)}).then(m => m.tag)`)).toBe("batch-two");

  expect(await page.evaluate(`import(${JSON.stringify(one)}).then(m => m.probe())`)).toBe(
    "one-alive",
  );
  expect(await page.evaluate(`import(${JSON.stringify(one)}).then(m => m.value)`)).toBe(42);

  const end = await settleAndStats(page, settled.internerReclaims);
  expect(end.internerLen).toBeLessThan(mid.internerLen + 500);
});

test("a stranded (unlinkable) module cannot pin the reclaim gate", async ({ page }) => {
  await page.goto(`${ORIGIN}/__fixtures/dynimport.html`, { waitUntil: "networkidle0" });

  const broken = `${ORIGIN}/__fixtures/interner-broken.js`;
  expect(
    await page.evaluate(`import(${JSON.stringify(broken)}).then(() => "linked", () => "rejected")`),
  ).toBe("rejected");

  const before = await internerStats(page);
  const after = await settleAndStats(page, before.internerReclaims);
  expect(after.internerReclaims, "eviction must reopen the gate").toBeGreaterThan(
    before.internerReclaims,
  );
  expect(after.internerPendingMods, "stranded module must be evicted").toBe(0);

  expect(
    await page.evaluate(`import(${JSON.stringify(broken)}).then(() => "linked", () => "rejected")`),
  ).toBe("rejected");
  const one = `${ORIGIN}/__fixtures/interner-batch-one.js`;
  expect(await page.evaluate(`import(${JSON.stringify(one)}).then(m => m.value)`)).toBe(42);
});
