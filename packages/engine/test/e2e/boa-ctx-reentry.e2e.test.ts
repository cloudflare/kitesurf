// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// V8 callbacks re-enter Boa under the live Context borrow; nested access
// must reborrow rather than create a sibling `&mut`. The bridge's re-entry counters from
// `Kitesurf.getMemoryStats` show whether nested access stayed chaperoned.

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import type { Page } from "@cloudflare/puppeteer";
import { targetIdForSession } from "./connect";

interface ReentryStats {
  ctxReentryDepth: number;
  ctxReentryMax: number;
  ctxUnchaperoned: number;
}

async function reentry(page: Page): Promise<ReentryStats> {
  const session = await page.createCDPSession();
  const targetId = await targetIdForSession(session);
  const stats = await session.send("Kitesurf.getMemoryStats", { targetId });
  await session.detach().catch(() => {});
  const bridge = stats.bridge;
  if (
    !bridge ||
    typeof bridge.ctxReentryDepth !== "number" ||
    typeof bridge.ctxReentryMax !== "number" ||
    typeof bridge.ctxUnchaperoned !== "number"
  ) {
    throw new Error(`no re-entry stats in ${JSON.stringify(stats).slice(0, 200)}`);
  }
  return bridge;
}

test("a V8 callback invoked from boa nests the context borrow", async ({ page }) => {
  await setContent(page, `<p>nest</p><script>globalThis.__apply = (fn, arg) => fn(arg);<\/script>`);
  const out = await page.evaluate(() => {
    const w = globalThis as typeof globalThis & {
      __apply(fn: (o: { n: number }) => number, arg: { n: number }): number;
    };
    return w.__apply((o) => o.n * 6, { n: 7 });
  });
  expect(out, "the nested borrow must return the real value").toBe(42);
  const stats = await reentry(page);
  expect(
    stats.ctxReentryMax,
    "V8 calling back into boa re-entered under a live borrow",
  ).toBeGreaterThan(1);
  expect(stats.ctxUnchaperoned, "every re-entry arrived through a with_v8 publication").toBe(0);
});

test("a V8 native reading a boa object's properties nests", async ({ page }) => {
  await setContent(page, "<p>walk</p>");
  const qs = await page.evaluate(() => {
    const w = globalThis as typeof globalThis & {
      URLSearchParams: new (init: Record<string, string>) => { toString(): string };
    };
    return new w.URLSearchParams({ a: "1", b: "2" }).toString();
  });
  expect(qs, "every property V8 read back through boa must be right").toBe("a=1&b=2");
  const stats = await reentry(page);
  expect(
    stats.ctxReentryMax,
    "V8 reading a boa object re-entered under a live borrow",
  ).toBeGreaterThan(1);
  expect(stats.ctxUnchaperoned, "no unwrapped boa->V8 call site on this path").toBe(0);
});

test("the depth counter unwinds — it is a depth, not a total", async ({ page }) => {
  await setContent(
    page,
    `<p>unwind</p><script>globalThis.__apply = (fn, arg) => fn(arg);<\/script>`,
  );
  const total = await page.evaluate(() => {
    const w = globalThis as typeof globalThis & {
      __apply(fn: (o: { i: number }) => number, arg: { i: number }): number;
    };
    let n = 0;
    for (let i = 0; i < 50; i++) n += w.__apply((o) => o.i, { i });
    return n;
  });
  expect(total, "50 nested round trips all returned their value").toBe(1225);
  const stats = await reentry(page);
  expect(stats.ctxReentryDepth, "no borrow is live between evaluates").toBe(0);
  expect(stats.ctxReentryMax, "but the run did nest").toBeGreaterThan(1);
});

test("the chaperone counter names an unwrapped boa->V8 call site", async ({ page }) => {
  await setContent(page, "<p>chaperone</p>");
  const clean = await reentry(page);
  expect(clean.ctxUnchaperoned, "baseline is clean before the hijack").toBe(0);

  await page.evaluate(() => {
    const g = globalThis as typeof globalThis & {
      __probe: { marker: number };
      __ks_thisfwd: (...args: unknown[]) => unknown;
      __cb: () => number;
    };
    g.__probe = { marker: 7 };
    const original = g.__ks_thisfwd;
    g.__ks_thisfwd = function (...args: unknown[]) {
      void g.__probe.marker;
      return original(...args);
    };
    g.__cb = () => 1;
    return 1;
  });

  const after = await reentry(page);
  expect(
    after.ctxUnchaperoned,
    "the detector must notice a re-entry that skipped with_v8",
  ).toBeGreaterThan(0);
  expect(after.ctxReentryDepth, "and still unwind to nothing live").toBe(0);
});

test("a broad sweep of the traps leaves the chaperone counter clean", async ({ page }) => {
  await setContent(page, "<div id=t data-x=1>sweep</div>");
  const out = await page.evaluate(async () => {
    const el = document.getElementById("t");
    if (!el) throw new Error("missing #t");
    const seen: string[] = [];
    const probe = el as typeof el & {
      __mine?: { deep: { n: number } };
      __def?: number;
    };
    probe.__mine = { deep: { n: 3 } };
    seen.push(String("__mine" in el));
    seen.push(String(probe.__mine.deep.n));
    delete probe.__mine;
    seen.push(String("__mine" in el));
    const rect = el.getBoundingClientRect().toJSON();
    seen.push(String(Object.keys(rect).length > 0));
    seen.push(String(Object.getOwnPropertyDescriptor(rect, "width") !== undefined));
    Object.defineProperty(el, "__def", { value: 9, enumerable: true, configurable: true });
    seen.push(String(probe.__def));
    seen.push(el.getAttribute("data-x") ?? "null");
    seen.push(String(new globalThis.URL("https://x.test/a").protocol));
    const settled = await Promise.resolve(41).then((n) => n + 1);
    seen.push(String(settled));
    return seen.join("|");
  });
  expect(out, "every trap round-tripped its real value").toBe(
    "true|3|false|true|true|9|1|https:|42",
  );
  expect(
    (await reentry(page)).ctxUnchaperoned,
    "no trap reached V8 without publishing its borrow first",
  ).toBe(0);
});

test("a set through a boa-V8-boa prototype chain stays chaperoned", async ({ page }) => {
  await setContent(
    page,
    `<p>chain</p><script>globalThis.__v8CreateFrom = (proto) => Object.create(proto);<\/script>`,
  );
  const clean = await reentry(page);
  expect(clean.ctxUnchaperoned, "baseline is clean").toBe(0);

  const out = await page.evaluate(() => {
    const createFrom = (
      globalThis as typeof globalThis & {
        __v8CreateFrom(proto: object): object;
      }
    ).__v8CreateFrom;
    const crossed = createFrom({ a: 1 });
    const receiver = Object.create(crossed) as Record<string, number>;
    receiver.k = 1;
    receiver.k = 2;
    return receiver.k;
  });
  expect(out).toBe(2);
  expect(
    (await reentry(page)).ctxUnchaperoned,
    "descriptor and prototype probes publish before re-entering boa",
  ).toBe(0);
});
