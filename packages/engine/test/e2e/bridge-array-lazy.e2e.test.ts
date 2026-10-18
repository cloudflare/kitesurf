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

const PROBE_HTML = `<div id=t>arr</div><script>
  globalThis.__isArr = (a) => Array.isArray(a);
  globalThis.__inst = (a) => a instanceof Array;
  globalThis.__json = (a) => JSON.stringify(a);
  globalThis.__spread = (a) => [...a].join(",");
  globalThis.__forof = (a) => { let s = 0; for (const x of a) s += x; return s; };
  globalThis.__from = (a) => Array.from(a).length;
  globalThis.__concat = (a) => a.concat([9]).length;
  globalThis.__slice = (a) => a.slice(1).join(",");
  globalThis.__map = (a) => a.map((x) => x * 2).join(",");
  globalThis.__u8 = (a) => new Uint8Array(a).join(",");
  globalThis.__len = (a) => a.length;
  globalThis.__gopdLen = (a) => {
    const d = Object.getOwnPropertyDescriptor(a, "length");
    return { c: d.configurable, w: d.writable, v: d.value };
  };
  globalThis.__names = (a) => Object.getOwnPropertyNames(a).join(",");
  globalThis.__mutate = (a) => { a[0] = 42; a.push(7); return a.length; };
  globalThis.__truncate = (a) => { a.length = 1; return a.length; };
  globalThis.__delLen = (a) => Reflect.deleteProperty(a, "length");
  globalThis.__keepLen = () => globalThis.__keep.length;
  globalThis.__is = (a, b) => Object.is(a, b);
  globalThis.__read3 = () => {
    const b = globalThis.__big;
    return [b[0].i, b[1].i, b[2].i].join(",");
  };
  globalThis.__dropBig = () => { globalThis.__big = null; };
  globalThis.__pressure = () => {
    let a = []; for (let i = 0; i < 200000; i++) a.push({ x: i }); return a.length;
  };
  globalThis.__cloneV8Holey = () => {
    const a = [1, , 3]; a.foo = "bar";
    const c = structuredClone(a);
    return { hole: !(1 in c), foo: c.foo, len: c.length };
  };
<\/script>`;

test("V8 sees an Array: isArray, instanceof, CDP subtype, by-value round-trip", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, PROBE_HTML);
  const r = await page.evaluate(() => {
    const g = globalThis as typeof globalThis & {
      __isArr(a: unknown): boolean;
      __inst(a: unknown): boolean;
    };
    const a = [1, 2, 3];
    return { isArr: g.__isArr(a), inst: g.__inst(a) };
  });
  expect(r).toEqual({ isArr: true, inst: true });

  const evalRes = (await cdpSession.send("Runtime.evaluate", {
    expression: "[1,2,3]",
  })) as { result: { subtype?: string } };
  expect(evalRes.result.subtype, "CDP RemoteObject subtype").toBe("array");

  const byValue = await page.evaluate(() => [1, { a: 2 }, [3]]);
  expect(byValue).toEqual([1, { a: 2 }, [3]]);
});

test("reads through [[Get]]: JSON, holes, iteration, natives, typed arrays", async ({ page }) => {
  await setContent(page, PROBE_HTML);
  const r = await page.evaluate(() => {
    const g = globalThis as typeof globalThis & {
      __json(a: unknown): string;
      __spread(a: unknown): string;
      __forof(a: unknown): number;
      __from(a: unknown): number;
      __concat(a: unknown): number;
      __slice(a: unknown): string;
      __map(a: unknown): string;
      __u8(a: unknown): string;
      __len(a: unknown): number;
    };
    // eslint-disable-next-line no-sparse-arrays
    const holey = [1, , 3];
    return {
      json: g.__json([1, [2, 3], { x: 1 }]),
      holes: g.__json(holey),
      spread: g.__spread([1, 2, 3]),
      forof: g.__forof([1, 2, 3]),
      from: g.__from([4, 5]),
      concat: g.__concat([1, 2]),
      slice: g.__slice([1, 2, 3]),
      map: g.__map([1, 2, 3]),
      u8: g.__u8([1, 2, 255]),
      len: g.__len([9, 9, 9, 9]),
    };
  });
  expect(r).toEqual({
    json: '[1,[2,3],{"x":1}]',
    holes: "[1,null,3]",
    spread: "1,2,3",
    forof: 6,
    from: 2,
    concat: 3,
    slice: "2,3",
    map: "2,4,6",
    u8: "1,2,255",
    len: 4,
  });
});

test("Array-target proxy invariants: gopd(length) and ownKeys", async ({ page }) => {
  await setContent(page, PROBE_HTML);
  const r = await page.evaluate(() => {
    const g = globalThis as typeof globalThis & {
      __gopdLen(a: unknown): unknown;
      __names(a: unknown): unknown;
    };
    const a = [7, 8];
    return { gopd: g.__gopdLen(a), names: String(g.__names(a)) };
  });
  expect(r.gopd, "length must report non-configurable + writable").toEqual({
    c: false,
    w: true,
    v: 2,
  });
  const names = r.names.split(",");
  expect(names).toContain("length");
  expect(names).toContain("0");
  expect(names).toContain("1");
});

test("V8-side writes reach the boa original", async ({ page }) => {
  await setContent(page, PROBE_HTML);
  const r = await page.evaluate(() => {
    const g = globalThis as typeof globalThis & {
      __mutate(a: unknown): number;
      __truncate(a: unknown): number;
      __delLen(a: unknown): boolean;
    };
    const a = [1, 2, 3];
    const lenAfter = g.__mutate(a);
    const localView = a.join(",");
    const truncated = g.__truncate(a);
    return { lenAfter, localView, after: a.join(","), truncated, del: g.__delLen(a) };
  });
  expect(r).toEqual({
    lenAfter: 4,
    localView: "42,2,3,7",
    truncated: 1,
    after: "42",
    del: false,
  });
});

test("live view + identity across crossings (I2/I3)", async ({ page }) => {
  await setContent(page, PROBE_HTML);
  const r = await page.evaluate(() => {
    const g = globalThis as typeof globalThis & {
      __keepLen(): number;
      __is(a: unknown, b: unknown): boolean;
      window: Record<string, unknown>;
    };
    const a = [1, 2, 3];
    g.window.__keep = a;
    a.push(4);
    return {
      liveLen: g.__keepLen(),
      sameWrapper: g.__is(a, a),
      roundTrip: g.window.__keep === a,
    };
  });
  expect(r, "snapshot would read stale length 3").toEqual({
    liveLen: 4,
    sameWrapper: true,
    roundTrip: true,
  });
});

test("structuredClone materializes bridged arrays with snapshot semantics", async ({ page }) => {
  await setContent(page, PROBE_HTML);
  const r = await page.evaluate(() => {
    const sc = (globalThis as typeof globalThis & { structuredClone(v: unknown): unknown })
      .structuredClone;
    const src: [number, { x: number }, number[]] = [1, { x: 2 }, [3]];
    const c = sc(src) as [number, { x: number }, number[]];
    const deep = JSON.stringify(c);
    src[1].x = 99;
    return { deep, snap: c[1].x, distinct: (c as unknown) !== (src as unknown) };
  });
  expect(r).toEqual({ deep: '[1,{"x":2},[3]]', snap: 2, distinct: true });
});

test("array args to jsg natives materialize (File/Blob C++ IsArray)", async ({ page }) => {
  await setContent(page, PROBE_HTML);
  const r = await page.evaluate(async () => {
    const file = new File(["hello ", "world"], "a.txt", { type: "text/plain" });
    const blob = new Blob(["bin"]);
    const text = await file.text();
    const sliced = blob.slice(0, 1);
    return {
      name: file.name,
      size: file.size,
      text,
      blobSize: blob.size,
      ownIsBlob: blob instanceof Blob,
      slicedIsBlob: sliced instanceof Blob,
      fileIsFile: file instanceof File,
      fileIsBlob: file instanceof Blob,
    };
  });
  expect(r).toEqual({
    name: "a.txt",
    size: 11,
    text: "hello world",
    blobSize: 3,
    ownIsBlob: true,
    slicedIsBlob: true,
    fileIsFile: true,
    fileIsBlob: true,
  });
});

test("Blob shim preserves the native prototype's introspection surface", async ({ page }) => {
  await setContent(page, PROBE_HTML);
  const r = await page.evaluate(() => {
    const keys = Reflect.ownKeys(Blob.prototype).map(String);
    let newless = "";
    try {
      // The shim exposes the constructor type, but this probe intentionally calls it.
      const callableBlob = Blob as typeof Blob & ((parts?: unknown) => unknown);
      callableBlob(["x"]);
    } catch (e) {
      newless = (e as Error).constructor.name;
    }
    return {
      hasSlice: keys.includes("slice"),
      hasSize: keys.includes("size"),
      ctorName: Blob.prototype.constructor.name,
      blobName: Blob.name,
      blobLen: Blob.length,
      newless,
    };
  });
  expect(r).toEqual({
    hasSlice: true,
    hasSize: true,
    ctorName: "Blob",
    blobName: "Blob",
    blobLen: 0,
    newless: "TypeError",
  });
});

test("bridged builtins throw loudly instead of flattening silently", async ({ page }) => {
  await setContent(page, PROBE_HTML);
  const r = await page.evaluate(() => {
    const sc = (globalThis as typeof globalThis & { structuredClone(v: unknown): unknown })
      .structuredClone;
    try {
      const c = sc(new Map([["a", 1]]));
      return { threw: false, shape: JSON.stringify(c) };
    } catch (e) {
      return { threw: true, name: (e as { name?: string })?.name ?? "unknown" };
    }
  });
  expect(r.threw, `silent flatten would return ${JSON.stringify(r)}`).toBe(true);
  expect((r as { name?: string }).name).toBe("DataCloneError");
});

test("clone preserves holes and non-index props on arrays, both realms", async ({ page }) => {
  await setContent(page, PROBE_HTML);
  const v8 = await page.evaluate(() =>
    (globalThis as typeof globalThis & { __cloneV8Holey(): unknown }).__cloneV8Holey(),
  );
  expect(v8).toEqual({ hole: true, foo: "bar", len: 3 });

  const boa = await page.evaluate(() => {
    const sc = (globalThis as typeof globalThis & { structuredClone(v: unknown): unknown })
      .structuredClone;
    // eslint-disable-next-line no-sparse-arrays
    const a = [1, , 3] as number[] & Record<string, unknown>;
    a.foo = "bar";
    const c = sc(a) as Record<string, unknown> & unknown[];
    return { hole: !(1 in c), foo: c.foo, len: c.length };
  });
  expect(boa).toEqual({ hole: true, foo: "bar", len: 3 });
});

test("structuredClone still throws DataCloneError on functions", async ({ page }) => {
  await setContent(page, PROBE_HTML);
  const name = await page.evaluate(() => {
    try {
      (globalThis as typeof globalThis & { structuredClone(v: unknown): unknown }).structuredClone({
        f: function () {},
      });
      return "no-throw";
    } catch (e) {
      return (e as { name?: string })?.name ?? "unknown";
    }
  });
  expect(name).toBe("DataCloneError");
});

test("cyclic arrays cross without crashing and clone preserves the cycle", async ({ page }) => {
  await setContent(page, PROBE_HTML);
  const r = await page.evaluate(() => {
    const g = globalThis as typeof globalThis & {
      __len(a: unknown): number;
      structuredClone(v: unknown): unknown;
      window: Record<string, unknown>;
    };
    const a: unknown[] = [1];
    a.push(a);
    g.window.__cyc = a;
    const len = g.__len(a);
    const c = g.structuredClone(a) as unknown[];
    return { len, cycle: c[1] === c };
  });
  expect(r).toEqual({ len: 2, cycle: true });
});

test("MessageChannel delivers an unmutated snapshot of a bridged array", async ({ page }) => {
  await setContent(page, PROBE_HTML);
  const r = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const MC = (
          globalThis as typeof globalThis & {
            MessageChannel: new () => {
              port1: { onmessage: ((ev: { data: [number, { x: number }] }) => void) | null };
              port2: { postMessage(v: unknown): void };
            };
          }
        ).MessageChannel;
        const mc = new MC();
        const msg: [number, { x: number }] = [1, { x: 2 }];
        mc.port1.onmessage = (ev) => {
          resolve({ data: JSON.stringify(ev.data), snap: ev.data[1].x });
        };
        mc.port2.postMessage(msg);
        msg[1].x = 99;
      }),
  );
  expect(r).toEqual({ data: '[1,{"x":2}]', snap: 2 });
});

test("pushState state deep-equals (pins today's by-reference storage)", async ({ page }) => {
  await setContent(page, PROBE_HTML);
  const r = await page.evaluate(() => {
    const h = (
      globalThis as typeof globalThis & {
        history: { pushState(s: unknown, t: string, u: string): void; state: unknown };
      }
    ).history;
    const st = { a: [1, 2] };
    h.pushState(st, "", "#lazy");
    return { deep: JSON.stringify(h.state), same: h.state === st };
  });
  expect(r.deep).toBe('{"a":[1,2]}');
  expect(r.same).toBe(true);
});

test("pin economy: big array crossing is O(1), elements pin lazily", async ({ page }) => {
  await setContent(page, PROBE_HTML);
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { window: Record<string, unknown> }).window.__warm = [
      { i: 0 },
    ];
  });
  const mints = (b: BridgeStats) => b.boaPins + b.releasedBoa;
  const before = await bridgeStats(page);
  await page.evaluate(() => {
    const arr: Array<{ i: number }> = [];
    for (let i = 0; i < 5000; i++) arr.push({ i });
    (globalThis as typeof globalThis & { window: Record<string, unknown> }).window.__big = arr;
  });
  const afterCross = await bridgeStats(page);
  expect(
    mints(afterCross) - mints(before),
    "5000-element array must cross as ONE proxy (was one pin per element)",
  ).toBeLessThan(100);

  const read = await page.evaluate(() =>
    (globalThis as typeof globalThis & { __read3(): string }).__read3(),
  );
  expect(read).toBe("0,1,2");
  const afterRead = await bridgeStats(page);
  const delta = mints(afterRead) - mints(afterCross);
  expect(delta, "reading 3 elements pins ~3").toBeGreaterThanOrEqual(3);
  expect(delta, "reading 3 elements must not pin the world").toBeLessThan(50);
});

test("a dropped V8-held array releases its pins under GC pressure", async ({ page }) => {
  await setContent(page, PROBE_HTML);
  await page.evaluate(() => {
    const g = globalThis as typeof globalThis & {
      window: Record<string, unknown>;
      __read3(): string;
    };
    const arr: Array<{ i: number }> = [];
    for (let i = 0; i < 50; i++) arr.push({ i });
    g.window.__big = arr;
    g.__read3();
  });
  const before = await bridgeStats(page);
  await page.evaluate(() => (globalThis as typeof globalThis & { __dropBig(): void }).__dropBig());
  let released = 0;
  for (let round = 0; round < 40 && released === 0; round++) {
    await page.evaluate(() =>
      (globalThis as typeof globalThis & { __pressure(): number }).__pressure(),
    );
    const now = await bridgeStats(page);
    released = now.releasedBoa - before.releasedBoa;
  }
  expect(released, "wrapper death must release array pins").toBeGreaterThan(0);
});
