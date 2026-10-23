// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";

import { targetIdForSession } from "./connect";
import { expect, test } from "./harness";
import { setContent } from "./set-content";

// V8 GC cannot be forced here, so these tests never assert that pins or nodes are released.

type BridgeStats = {
  ccRuns: number;
  ccSkipped: number;
  ccCarried: number;
  ccWeakened: number;
  ccDeadReads: number;
};

async function kitesurf(
  page: Page,
  method: "Kitesurf.getMemoryStats" | "Kitesurf.boaForceCollect",
): Promise<unknown> {
  const session = await page.createCDPSession();
  try {
    const targetId = await targetIdForSession(session);
    return await session.send(method, { targetId });
  } finally {
    await session.detach();
  }
}

function counter(source: unknown, key: keyof BridgeStats): number {
  const value: unknown =
    typeof source === "object" && source !== null ? Reflect.get(source, key) : undefined;
  if (typeof value !== "number") throw new Error(`bridge stats ${key} is not a number`);
  return value;
}

async function bridge(page: Page): Promise<BridgeStats> {
  const stats: unknown = await kitesurf(page, "Kitesurf.getMemoryStats");
  const pins: unknown =
    typeof stats === "object" && stats !== null ? Reflect.get(stats, "bridge") : undefined;
  return {
    ccRuns: counter(pins, "ccRuns"),
    ccSkipped: counter(pins, "ccSkipped"),
    ccCarried: counter(pins, "ccCarried"),
    ccWeakened: counter(pins, "ccWeakened"),
    ccDeadReads: counter(pins, "ccDeadReads"),
  };
}

// The second collection exercises keeper carry-over.
async function collectBoa(page: Page): Promise<void> {
  await kitesurf(page, "Kitesurf.boaForceCollect");
  await kitesurf(page, "Kitesurf.boaForceCollect");
}

const PAGE = `<div id=host></div><script>
window.v8kept = [];
</script>`;

const CYCLES = 2000;

// Runs in boa: each detached node's expando is a boa object pointing back at the node.
function makeCycles(n: number): void {
  const host = document.getElementById("host");
  if (!host) throw new Error("#host is missing");
  for (let i = 0; i < n; i++) {
    const el = document.createElement("div");
    Object.assign(el, { __fiber: { stateNode: el, i } });
    host.appendChild(el);
    host.removeChild(el);
  }
}

test("the collector weakens an unheld boa<->V8 cycle", async ({ page }) => {
  await setContent(page, PAGE);
  await collectBoa(page);
  const before = await bridge(page);
  await page.evaluate(makeCycles, CYCLES);
  await kitesurf(page, "Kitesurf.boaForceCollect");
  const after = await bridge(page);
  expect(after.ccWeakened - before.ccWeakened).toBeGreaterThanOrEqual(CYCLES);
});

test("a cycle V8 still holds by its node survives collection", async ({ page }) => {
  await setContent(page, PAGE);
  const before = await bridge(page);
  await page.evaluate((n: number) => {
    const kept: unknown = Reflect.get(window, "v8kept");
    const host = document.getElementById("host");
    if (!Array.isArray(kept) || !host) throw new Error("page fixture is missing");
    for (let i = 0; i < n; i++) {
      const el = document.createElement("div");
      Object.assign(el, { __fiber: { stateNode: el, i } });
      host.appendChild(el);
      host.removeChild(el);
      kept.push(el);
    }
  }, 200);
  await collectBoa(page);
  const after = await bridge(page);
  expect(after.ccWeakened - before.ccWeakened).toBeGreaterThanOrEqual(200);
  const ok = await page.evaluate(() => {
    const intact = (el: unknown, i: number): boolean => {
      if (!(el instanceof HTMLDivElement)) return false;
      const fiber: unknown = Reflect.get(el, "__fiber");
      return (
        typeof fiber === "object" &&
        fiber !== null &&
        Reflect.get(fiber, "stateNode") === el &&
        Reflect.get(fiber, "i") === i
      );
    };
    const kept: unknown = Reflect.get(window, "v8kept");
    return Array.isArray(kept) && kept.every(intact);
  });
  expect(ok).toBe(true);
  expect((await bridge(page)).ccDeadReads).toBe(0);
});

test("a cycle V8 reaches only through the boa side survives collection", async ({ page }) => {
  await setContent(page, PAGE);
  const before = await bridge(page);
  // V8 holds the fibers' wrappers, not the nodes, so only the keeper ties each node to its fiber.
  await page.evaluate((n: number) => {
    const fibers: unknown[] = [];
    Reflect.set(window, "fibers", fibers);
    const host = document.getElementById("host");
    if (!host) throw new Error("#host is missing");
    for (let i = 0; i < n; i++) {
      const el = document.createElement("span");
      el.id = "n" + i;
      const fiber = { stateNode: el, i };
      Object.assign(el, { __fiber: fiber });
      host.appendChild(el);
      host.removeChild(el);
      fibers.push(fiber);
    }
  }, 200);
  await collectBoa(page);
  const after = await bridge(page);
  expect(after.ccWeakened - before.ccWeakened).toBeGreaterThanOrEqual(200);
  const ok = await page.evaluate(() => {
    const fibers: unknown = Reflect.get(window, "fibers");
    if (!Array.isArray(fibers)) return false;
    return fibers.every((fiber: unknown, i: number) => {
      if (typeof fiber !== "object" || fiber === null) return false;
      const el: unknown = Reflect.get(fiber, "stateNode");
      return el instanceof HTMLSpanElement && el.id === "n" + i;
    });
  });
  expect(ok).toBe(true);
  expect((await bridge(page)).ccDeadReads).toBe(0);
});

// getAttribute takes the DOM fast path; getAttributeNS crosses to V8.
for (const method of ["getAttribute", "getAttributeNS"] as const) {
  test(`a bound ${method} kept by V8 holds its receiver`, async ({ page }) => {
    await setContent(page, PAGE);
    const before = await bridge(page);
    await page.evaluate(
      ({ n, m }: { n: number; m: string }) => {
        const getters: unknown[] = [];
        const host = document.getElementById("host");
        if (!host) throw new Error("#host is missing");
        for (let i = 0; i < n; i++) {
          const el = document.createElement("i");
          el.id = "g" + i;
          Object.assign(el, { __fiber: { stateNode: el, i } });
          host.appendChild(el);
          host.removeChild(el);
          const get: unknown = Reflect.get(el, m);
          if (typeof get !== "function") throw new Error(`${m} is not a function`);
          getters.push(m === "getAttribute" ? get.bind(el) : get);
        }
        Reflect.set(globalThis, "getters", getters);
      },
      { n: 50, m: method },
    );
    await collectBoa(page);
    const after = await bridge(page);
    expect(after.ccWeakened - before.ccWeakened).toBeGreaterThanOrEqual(50);
    const ok = await page.evaluate((ns: boolean) => {
      function returnsExpectedId(get: unknown, index: number, useNamespace: boolean): boolean {
        if (typeof get !== "function") return false;
        try {
          const id: unknown = useNamespace ? get(null, "id") : get("id");
          return id === "g" + index;
        } catch {
          return false;
        }
      }

      const raw: unknown = Reflect.get(globalThis, "getters");
      if (!Array.isArray(raw)) return 0;
      const getters: unknown[] = raw;
      let n = 0;
      for (const [i, get] of getters.entries()) {
        if (returnsExpectedId(get, i, ns)) n++;
      }
      return n;
    }, method === "getAttributeNS");
    expect(ok).toBe(50);
    expect((await bridge(page)).ccDeadReads).toBe(0);
  });
}

test("a retained unbound fast method preserves caller receiver semantics after collection", async ({
  page,
}) => {
  await setContent(page, PAGE);
  const before = await bridge(page);
  await page.evaluate(() => {
    const host = document.getElementById("host");
    if (!host) throw new Error("#host is missing");
    const getters: unknown[] = [];
    for (let i = 0; i < 50; i++) {
      const el = document.createElement("i");
      Object.assign(el, { __fiber: { stateNode: el, i } });
      host.appendChild(el);
      host.removeChild(el);
      getters.push(el.getAttribute);
    }
    Reflect.set(globalThis, "getters", getters);
  });
  const probe = () =>
    page.evaluate(() => {
      function isIllegalInvocation(get: Function): boolean {
        try {
          Reflect.apply(get, undefined, ["id"]);
          return false;
        } catch (error) {
          return String(error) === "TypeError: Illegal invocation";
        }
      }

      function updateReceiverStats(
        stats: { illegalInvocations: number; foreignReceivers: number },
        get: unknown,
        host: HTMLElement,
      ) {
        if (typeof get !== "function") throw new Error("retained getter is not a function");
        if (isIllegalInvocation(get)) stats.illegalInvocations++;
        if (get.call(host, "id") === "host") stats.foreignReceivers++;
        return stats;
      }

      const raw: unknown = Reflect.get(globalThis, "getters");
      const host = document.getElementById("host");
      if (!Array.isArray(raw) || !host) throw new Error("missing getters or #host");
      return raw.reduce((stats, get) => updateReceiverStats(stats, get, host), {
        illegalInvocations: 0,
        foreignReceivers: 0,
      });
    });
  const expected = { illegalInvocations: 50, foreignReceivers: 50 };
  expect(await probe()).toEqual(expected);
  await collectBoa(page);
  expect((await bridge(page)).ccWeakened - before.ccWeakened).toBeGreaterThanOrEqual(50);
  expect(await probe()).toEqual(expected);
  expect((await bridge(page)).ccDeadReads).toBe(0);
});

test("the timer skips idle epochs and resumes after a change", async ({ page }) => {
  await setContent(page, PAGE);
  await page.evaluate(makeCycles, 50);
  await expect
    .poll(async () => (await bridge(page)).ccSkipped, { timeout: 15_000 })
    .toBeGreaterThan(0);
  const idle = await bridge(page);
  await page.evaluate(makeCycles, 50);
  await expect
    .poll(async () => (await bridge(page)).ccRuns, { timeout: 15_000 })
    .toBeGreaterThan(idle.ccRuns);
});

test("epochs keep and back off from an unchanged gray graph", async ({ page }) => {
  await setContent(page, PAGE);
  await page.evaluate((n: number) => {
    const host = document.getElementById("host");
    const kept: unknown = Reflect.get(window, "v8kept");
    if (!host || !Array.isArray(kept)) throw new Error("#host or v8kept is missing");
    for (let i = 0; i < n; i++) {
      const el = document.createElement("div");
      Object.assign(el, { __fiber: { stateNode: el, i } });
      kept.push(el);
    }
    // Local boa allocations change the heap size each tick without changing the gray graph,
    // so only carry-over and back-off, not the idle skip, can satisfy the checks below.
    setInterval(() => {
      Array.from({ length: 64 }, (_, i) => ({ i }));
    }, 50);
  }, 20);
  await expect
    .poll(async () => (await bridge(page)).ccCarried, { timeout: 30_000 })
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await bridge(page)).ccSkipped, { timeout: 30_000 })
    .toBeGreaterThan(0);
  expect((await bridge(page)).ccDeadReads).toBe(0);
});

// A boa WeakMap value is reachable through its key, so it must stay readable while V8 holds the
// key's wrapper, even after the value's own wrapper is dropped.
test("a WeakMap value stays reachable through its V8-held key", async ({ page }) => {
  await setContent(page, `${PAGE}<div id=holder></div>`);
  const n = 200;
  await page.evaluate((count: number) => {
    const holder = document.getElementById("holder");
    if (!holder) throw new Error("#holder is missing");
    const wm = new WeakMap<object, { el: Event }>();
    Reflect.set(globalThis, "wm", wm);
    for (let i = 0; i < count; i++) {
      const k = { i };
      Reflect.set(holder, "__k" + i, k);
      const o = { el: new Event("t" + i) };
      wm.set(k, o);
      Reflect.set(holder, "__t" + i, o);
    }
  }, n);
  await collectBoa(page);
  await page.evaluate((count: number) => {
    const holder = document.getElementById("holder");
    if (!holder) throw new Error("#holder is missing");
    for (let i = 0; i < count; i++) Reflect.set(holder, "__t" + i, null);
  }, n);
  for (let round = 0; round < 20; round++) {
    await page.evaluate(() => {
      const holder = document.getElementById("holder");
      if (holder) Reflect.set(holder, "__s", "x".repeat(1 << 20) + Math.random());
    });
  }
  await collectBoa(page);
  const intact = await page.evaluate((count: number) => {
    function hasExpectedEvent(
      wm: WeakMap<object, unknown>,
      holder: Element,
      index: number,
    ): boolean {
      try {
        const value: unknown = wm.get(Reflect.get(holder, "__k" + index));
        const event: unknown =
          typeof value === "object" && value !== null ? Reflect.get(value, "el") : undefined;
        return event instanceof Event && event.type === "t" + index;
      } catch {
        // A dead V8 handle throws, which counts as a miss.
        return false;
      }
    }

    const holder = document.getElementById("holder");
    const wm: unknown = Reflect.get(globalThis, "wm");
    if (!holder || !(wm instanceof WeakMap)) return -1;
    let ok = 0;
    for (let i = 0; i < count; i++) if (hasExpectedEvent(wm, holder, i)) ok++;
    return ok;
  }, n);
  expect(intact).toBe(n);
  expect((await bridge(page)).ccDeadReads).toBe(0);
});
