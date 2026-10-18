// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import {
  CLASS_DEFERRED,
  CLASS_FONT,
  CLASS_IMAGE,
  CLASS_IMAGE_VIEWPORT,
  CLASS_MEDIA,
  CLASS_STYLESHEET,
  FETCH_CONCURRENCY_GLOBAL,
  FETCH_CONCURRENCY_PER_HOST,
  FetchSlots,
  allHintsLazy,
  classForImageHints,
  classForKind,
  fetchHostKey,
} from "../../page-script/src/fetch-slots.ts";

const settled = async (p: Promise<void>): Promise<boolean> => {
  let done = false;
  void p.then(() => {
    done = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  return done;
};

describe("fetchHostKey", () => {
  it("buckets by host, ignoring scheme/path/port-less differences", () => {
    expect(fetchHostKey("https://a.example/x.png")).toBe("a.example");
    expect(fetchHostKey("http://a.example/y.css")).toBe("a.example");
    expect(fetchHostKey("https://b.example/x.png")).toBe("b.example");
  });

  it("separates ports — a different port is a different connection pool", () => {
    expect(fetchHostKey("https://a.example:8443/x")).toBe("a.example:8443");
    expect(fetchHostKey("https://a.example/x")).toBe("a.example");
  });

  it("lumps unparseable and relative URLs into one bucket", () => {
    expect(fetchHostKey("/relative.png")).toBe(fetchHostKey("not a url"));
    expect(fetchHostKey("data:image/png;base64,AAAA")).toBe(fetchHostKey("/relative.png"));
  });
});

describe("FetchSlots", () => {
  it("admits six per host and queues the seventh", async () => {
    const s = new FetchSlots();
    const url = (i: number) => `https://a.example/${i}.png`;
    for (let i = 0; i < FETCH_CONCURRENCY_PER_HOST; i++) {
      expect(await settled(s.acquire(url(i)))).toBe(true);
    }
    const seventh = s.acquire(url(99));
    expect(await settled(seventh)).toBe(false);
    expect(s.stats().global).toBe(FETCH_CONCURRENCY_PER_HOST);

    s.release(url(0));
    expect(await settled(seventh)).toBe(true);
    expect(s.stats().global).toBe(FETCH_CONCURRENCY_PER_HOST);
  });

  it("does NOT let one saturated host block another host", async () => {
    const s = new FetchSlots();
    for (let i = 0; i < FETCH_CONCURRENCY_PER_HOST; i++) {
      await s.acquire(`https://busy.example/${i}`);
    }
    expect(await settled(s.acquire("https://other.example/1"))).toBe(true);
  });

  it("enforces the global ceiling across hosts", async () => {
    const s = new FetchSlots(2, 3);
    expect(await settled(s.acquire("https://a.example/1"))).toBe(true);
    expect(await settled(s.acquire("https://a.example/2"))).toBe(true);
    expect(await settled(s.acquire("https://b.example/1"))).toBe(true);
    const blocked = s.acquire("https://b.example/2");
    expect(await settled(blocked)).toBe(false);
    s.release("https://a.example/1");
    expect(await settled(blocked)).toBe(true);
  });

  it("prefers a ceiling waiter whose host has room over one that doesn't", async () => {
    const s = new FetchSlots(1, 2);
    await s.acquire("https://a.example/1");
    await s.acquire("https://b.example/1");
    const bAgain = s.acquire("https://b.example/2");
    const c = s.acquire("https://c.example/1");
    expect(await settled(bAgain)).toBe(false);
    expect(await settled(c)).toBe(false);
    s.release("https://a.example/1");
    expect(await settled(bAgain)).toBe(false);
    expect(await settled(c)).toBe(true);
  });

  it("never exceeds either cap under a mixed burst", async () => {
    const perHost = 3;
    const global = 5;
    const s = new FetchSlots(perHost, global);
    let live = 0;
    let peak = 0;
    const perHostLive = new Map<string, number>();
    let peakPerHost = 0;
    const runs: Promise<void>[] = [];
    for (const h of ["a", "b", "c", "d"]) {
      for (let i = 0; i < 10; i++) {
        const url = `https://${h}.example/${i}`;
        runs.push(
          (async () => {
            await s.acquire(url);
            live++;
            peak = Math.max(peak, live);
            const n = (perHostLive.get(h) ?? 0) + 1;
            perHostLive.set(h, n);
            peakPerHost = Math.max(peakPerHost, n);
            await new Promise((r) => setTimeout(r, 1));
            live--;
            perHostLive.set(h, (perHostLive.get(h) ?? 1) - 1);
            s.release(url);
          })(),
        );
      }
    }
    await Promise.all(runs);
    expect(peak).toBeLessThanOrEqual(global);
    expect(peakPerHost).toBeLessThanOrEqual(perHost);
    expect(s.stats()).toMatchObject({ global: 0, hosts: 0, queued: 0 });
  });

  it("drains fully when every request targets one host", async () => {
    const s = new FetchSlots();
    const urls = Array.from({ length: 20 }, (_, i) => `https://a.example/${i}`);
    await Promise.all(
      urls.map(async (u) => {
        await s.acquire(u);
        await new Promise((r) => setTimeout(r, 1));
        s.release(u);
      }),
    );
    expect(s.stats()).toMatchObject({ global: 0, hosts: 0, queued: 0 });
  });

  it("admits a queued stylesheet before earlier-queued images", async () => {
    const s = new FetchSlots(2, 24);
    await s.acquire("https://a.example/1.png", CLASS_IMAGE);
    await s.acquire("https://a.example/2.png", CLASS_IMAGE);
    const img3 = s.acquire("https://a.example/3.png", CLASS_IMAGE);
    const img4 = s.acquire("https://a.example/4.png", CLASS_IMAGE);
    const css = s.acquire("https://a.example/late.css", CLASS_STYLESHEET);
    expect(await settled(css)).toBe(false);
    s.release("https://a.example/1.png");
    expect(await settled(css)).toBe(true);
    expect(await settled(img3)).toBe(false);
    expect(await settled(img4)).toBe(false);
  });

  it("lets one synchronous burst compete before any slot is granted", async () => {
    const s = new FetchSlots(6, 24);
    const imgs = Array.from({ length: 6 }, (_, i) =>
      s.acquire(`https://a.example/${i}.png`, CLASS_IMAGE),
    );
    const css = s.acquire("https://a.example/late.css", CLASS_STYLESHEET);
    expect(await settled(css)).toBe(true);
    const imgSettled = await Promise.all(imgs.map((p) => settled(p)));
    expect(imgSettled.filter(Boolean).length).toBe(5);
    expect(imgSettled[5]).toBe(false);
    expect(s.stats().queued).toBe(1);
  });

  it("orders FIFO within a class", async () => {
    const s = new FetchSlots(1, 24);
    await s.acquire("https://a.example/0.png", CLASS_IMAGE);
    const first = s.acquire("https://a.example/1.png", CLASS_IMAGE);
    const second = s.acquire("https://a.example/2.png", CLASS_IMAGE);
    s.release("https://a.example/0.png");
    expect(await settled(first)).toBe(true);
    expect(await settled(second)).toBe(false);
  });

  it("counts uncontended admissions and 30ms misorder-window hits", async () => {
    let t = 1_000;
    const s = new FetchSlots(1, 24, () => t);
    await s.acquire("https://a.example/0.png", CLASS_IMAGE);
    expect(s.stats().uncontended).toBe(1);
    const img = s.acquire("https://a.example/1.png", CLASS_IMAGE);
    expect(await settled(img)).toBe(false);
    s.release("https://a.example/0.png");
    expect(await settled(img)).toBe(true);
    expect(s.stats().uncontended).toBe(1);
    t += 29;
    const css = s.acquire("https://a.example/late.css", CLASS_STYLESHEET);
    expect(s.stats().misorderHits).toBe(1);
    s.release("https://a.example/1.png");
    expect(await settled(css)).toBe(true);
  });

  it("misorder hits are host-scoped and window-bounded", async () => {
    let t = 1_000;
    const s = new FetchSlots(1, 24, () => t);
    await s.acquire("https://a.example/0.png", CLASS_IMAGE);
    const img = s.acquire("https://a.example/1.png", CLASS_IMAGE);
    expect(await settled(img)).toBe(false);
    s.release("https://a.example/0.png");
    expect(await settled(img)).toBe(true);
    void s.acquire("https://other.example/x.css", CLASS_STYLESHEET);
    expect(s.stats().misorderHits).toBe(0);
    t += 31;
    void s.acquire("https://a.example/late.css", CLASS_STYLESHEET);
    expect(s.stats().misorderHits).toBe(0);
  });

  it("maps resource kinds to browser-shaped classes", () => {
    expect(classForKind("Stylesheet")).toBe(CLASS_STYLESHEET);
    expect(classForKind("Font")).toBe(CLASS_FONT);
    expect(classForKind("Image")).toBe(CLASS_IMAGE);
    expect(classForKind("Media")).toBe(CLASS_MEDIA);
    expect(classForKind("Other")).toBe(CLASS_IMAGE);
    expect(classForKind("")).toBe(CLASS_IMAGE);
    expect(CLASS_STYLESHEET).toBeLessThan(CLASS_FONT);
    expect(CLASS_FONT).toBeLessThan(CLASS_IMAGE_VIEWPORT);
    expect(CLASS_IMAGE_VIEWPORT).toBeLessThan(CLASS_IMAGE);
    expect(CLASS_IMAGE).toBeLessThan(CLASS_MEDIA);
    expect(CLASS_MEDIA).toBeLessThan(CLASS_DEFERRED);
  });

  it("poke() re-drains without an acquire or release event", async () => {
    const s = new FetchSlots(1, 24);
    let boost = false;
    s.setBoostProbe((url) => (boost && url.includes("hero") ? CLASS_IMAGE_VIEWPORT : null));
    await s.acquire("https://a.example/hold.png", CLASS_IMAGE);
    const plain = s.acquire("https://a.example/plain.png", CLASS_IMAGE);
    const hero = s.acquire("https://a.example/hero.png", CLASS_IMAGE);
    boost = true;
    s.poke();
    s.release("https://a.example/hold.png");
    expect(await settled(hero)).toBe(true);
    expect(await settled(plain)).toBe(false);
  });

  it("boosts viewport images over earlier-queued default images", async () => {
    const s = new FetchSlots(1, 24);
    s.setBoostProbe((url) => (url.includes("hero") ? CLASS_IMAGE_VIEWPORT : null));
    await s.acquire("https://a.example/hold.png", CLASS_IMAGE);
    const plain = s.acquire("https://a.example/plain.png", CLASS_IMAGE);
    const hero = s.acquire("https://a.example/hero.png", CLASS_IMAGE);
    s.release("https://a.example/hold.png");
    expect(await settled(hero)).toBe(true);
    expect(await settled(plain)).toBe(false);
  });

  it("only default-class images consult the boost probe", async () => {
    const s = new FetchSlots(6, 24);
    const seen: string[] = [];
    s.setBoostProbe((url) => {
      seen.push(url);
      return null;
    });
    await s.acquire("https://a.example/x.css", CLASS_STYLESHEET);
    await s.acquire("https://a.example/x.woff2", CLASS_FONT);
    await s.acquire("https://a.example/lazy.png", CLASS_DEFERRED);
    await s.acquire("https://a.example/x.png", CLASS_IMAGE);
    expect(seen).toEqual(["https://a.example/x.png"]);
  });

  it("a throwing boost probe reads as no-boost", async () => {
    const s = new FetchSlots(6, 24);
    s.setBoostProbe(() => {
      throw new Error("layout not queryable");
    });
    const img = s.acquire("https://a.example/x.png", CLASS_IMAGE);
    expect(await settled(img)).toBe(true);
  });

  it("merges author hints per shared URL: any-high wins, all-lazy demotes", () => {
    const img = (priority: string, lazy: boolean) => ({ priority, lazy });
    expect(classForImageHints([])).toBe(CLASS_IMAGE);
    expect(classForImageHints([img("", false)])).toBe(CLASS_IMAGE);
    expect(classForImageHints([img("high", false)])).toBe(CLASS_FONT);
    expect(classForImageHints([img("high", false), img("", true)])).toBe(CLASS_FONT);
    expect(classForImageHints([img("", true)])).toBe(CLASS_DEFERRED);
    expect(classForImageHints([img("low", false)])).toBe(CLASS_DEFERRED);
    expect(classForImageHints([img("", true), img("low", false)])).toBe(CLASS_DEFERRED);
    expect(classForImageHints([img("", true), img("", false)])).toBe(CLASS_IMAGE);
  });

  it("load exclusion is orthogonal to admission class (lazy only)", () => {
    const img = (priority: string, lazy: boolean) => ({ priority, lazy });
    expect(classForImageHints([img("high", true)])).toBe(CLASS_FONT);
    expect(allHintsLazy([img("high", true)])).toBe(true);
    expect(classForImageHints([img("low", false)])).toBe(CLASS_DEFERRED);
    expect(allHintsLazy([img("low", false)])).toBe(false);
    expect(allHintsLazy([img("", true), img("", false)])).toBe(false);
    expect(allHintsLazy([])).toBe(false);
  });

  it("keeps the defaults a browser-shaped six under a bounded ceiling", () => {
    expect(FETCH_CONCURRENCY_PER_HOST).toBe(6);
    expect(FETCH_CONCURRENCY_GLOBAL).toBeGreaterThan(FETCH_CONCURRENCY_PER_HOST);
    expect(FETCH_CONCURRENCY_GLOBAL).toBeLessThanOrEqual(32);
  });
});
