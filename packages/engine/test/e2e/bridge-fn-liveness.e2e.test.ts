// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A V8 closure held by a boa proxy remains callable after a forced Boa GC.
import { expect } from "vitest";

import { test } from "./harness";
import { setContent } from "./set-content";
import type { Page } from "@cloudflare/puppeteer";
import { targetIdForSession } from "./connect";

async function targetSession(page: Page) {
  const session = await page.createCDPSession();
  const targetId = await targetIdForSession(session);
  return { session, targetId };
}

async function forceCollect(page: Page): Promise<void> {
  const { session, targetId } = await targetSession(page);
  await session.send("Kitesurf.boaForceCollect", { targetId });
  await session.detach().catch(() => {});
}

async function bridgeStats(page: Page) {
  const { session, targetId } = await targetSession(page);
  const stats = await session.send("Kitesurf.getMemoryStats", { targetId });
  await session.detach().catch(() => {});
  if (!stats.bridge) throw new Error("no bridge gauges in getMemoryStats");
  return stats.bridge;
}

test("a held V8 closure stays callable while sibling proxies are collected", async ({ page }) => {
  await setContent(page, "<script>window.mk = (i) => () => i;</script>");
  await page.evaluate(() => {
    const mk: unknown = Reflect.get(globalThis, "mk");
    if (typeof mk !== "function") throw new Error("window.mk is not a function");
    Reflect.set(globalThis, "held", mk(42));
    for (let i = 0; i < 2000; i++) mk(i)();
  });
  await forceCollect(page);
  expect(
    await page.evaluate(() => {
      const held: unknown = Reflect.get(globalThis, "held");
      if (typeof held !== "function") throw new Error("window.held is not a function");
      return held();
    }),
  ).toBe(42);
});

// A pin is released with its last proxy. Churn
// closures and method reads, then check the pins and weak slots come back down.
test("V8 functions and method receivers handed to boa release their pins", async ({ page }) => {
  await setContent(
    page,
    `<script>
    window.mk = (i) => () => i;
    window.mkObj = (mark) => ({ mark, getMark() { return this.mark; } });
  </script>`,
  );
  await forceCollect(page);
  const before = await bridgeStats(page);
  await page.evaluate(() => {
    const mk: unknown = Reflect.get(globalThis, "mk");
    const mkObj: unknown = Reflect.get(globalThis, "mkObj");
    if (typeof mk !== "function" || typeof mkObj !== "function")
      throw new Error("missing factories");
    for (let i = 0; i < 2000; i++) {
      mk(i)();
      mkObj(i).getMark();
    }
  });
  await forceCollect(page);
  await page.evaluate(() => 0); // drains the queued releases
  await forceCollect(page);
  const after = await bridgeStats(page);
  expect(after.v8Pins - before.v8Pins, "V8 pins return near baseline").toBeLessThan(200);
  expect(after.weakBoa - before.weakBoa, "weak slots return near baseline").toBeLessThan(200);
}, 60_000);

// A cached method proxy calls with the receiver it was read from. That receiver's pin
// must outlive the receiver's own proxy, or a reused slot hands the call another `this`.
test("a held method keeps its receiver after the receiver's proxy is collected", async ({
  page,
}) => {
  await setContent(
    page,
    `<script>
    window.mkObj = (mark) => ({ mark, getMark() { return this.mark; } });
  </script>`,
  );
  await page.evaluate(() => {
    const mkObj: unknown = Reflect.get(globalThis, "mkObj");
    if (typeof mkObj !== "function") throw new Error("missing mkObj");
    Reflect.set(globalThis, "holder", { m: mkObj(7).getMark });
  });
  await forceCollect(page);
  await page.evaluate(() => 0);
  await forceCollect(page);
  const mark = await page.evaluate(() => {
    function requireFunction(value: unknown, message: string): Function {
      if (typeof value !== "function") throw new Error(message);
      return value;
    }

    const mkObj = requireFunction(Reflect.get(globalThis, "mkObj"), "missing mkObj");
    for (let i = 100; i < 2100; i++) mkObj(i).mark; // reuses any released pin slot
    const holder: unknown = Reflect.get(globalThis, "holder");
    const method: unknown =
      typeof holder === "object" && holder !== null ? Reflect.get(holder, "m") : undefined;
    const m = requireFunction(method, "holder.m is not a function");
    return Reflect.apply(m, undefined, []);
  });
  expect(mark).toBe(7);
}, 60_000);
