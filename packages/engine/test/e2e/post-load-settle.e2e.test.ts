// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import settleProbe from "./html/settle-probe.html?raw";
import settleStatic from "./html/settle-static.html?raw";
import settleChained from "./html/settle-chained.html?raw";
import resourceQuietChain from "./html/resource-quiet-chain.html?raw";
import settleMicrotaskChain from "./html/settle-microtask-chain.html?raw";
import settleLateTimer from "./html/settle-late-timer.html?raw";
import settleTimerTicker from "./html/settle-timer-ticker.html?raw";
import settleMutationTicker from "./html/settle-mutation-ticker.html?raw";

const TURNS_EXPR = `JSON.stringify({
  turns: (globalThis.__ks_zeroTurns | 0) - (globalThis.__ks_mine | 0),
  mine: globalThis.__ks_mine | 0,
  step: (document.getElementById("h") || {}).getAttribute
    ? document.getElementById("h").getAttribute("data-step")
    : null,
  title: document.title
})`;

async function settleReport(page: Page, html: string) {
  await setContent(page, settleProbe + html, { waitUntil: "load" });
  const raw = await page.evaluate(TURNS_EXPR);
  return JSON.parse(String(raw)) as {
    turns: number;
    mine: number;
    step: string | null;
    title: string;
  };
}

test("a quiet page settles in zero macrotask turns", async ({ page }) => {
  const r = await settleReport(page, settleStatic);
  expect(r.mine).toBe(0);
  expect(r.turns).toBe(0);
});

test("work chained off load still fully settles before load fires", async ({ page }) => {
  const r = await settleReport(page, settleChained);
  expect(r.step).toBe("3");
  expect(r.title).toBe("SETTLED:3");
  expect(r.turns).toBeGreaterThan(0);
  expect(r.turns).toBeLessThanOrEqual(4);
});

test("the local resource quiet window drains chained pre-load tasks", async ({ page }) => {
  const r = await settleReport(page, resourceQuietChain);
  expect(r.step).toBe("3");
  expect(r.title).toBe("RESOURCE_QUIET_SETTLED");
});

test("a deep microtask chain still lands before load fires", async ({ page }) => {
  const r = await settleReport(page, settleMicrotaskChain);
  expect(r.step).toBe("deep");
  expect(r.title).toBe("CHAIN_SETTLED");
  expect(r.turns).toBeLessThanOrEqual(1);
});

test("an outstanding long timer does not buy settle turns", async ({ page }) => {
  const r = await settleReport(page, settleLateTimer);
  expect(r.title).toBe("SETTLE_LATE_READY");
  expect(r.turns).toBeLessThanOrEqual(1);
});

test("a self-rescheduling ticker without mutations does not extend the settle", async ({
  page,
}) => {
  const r = await settleReport(page, settleTimerTicker);
  expect(r.title).toBe("TIMER_TICKER_READY");
  expect(r.turns).toBeLessThanOrEqual(1);
});

test("indefinite mutations are bounded by the pass cap", async ({ page }) => {
  const r = await settleReport(page, settleMutationTicker);
  expect(r.title).toBe("MUTATION_TICKER_READY");
  expect(r.turns).toBeGreaterThan(0);
  expect(r.turns).toBeLessThanOrEqual(4);
});
