// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import type { Page } from "@cloudflare/puppeteer";
import { targetIdForSession } from "./connect";

async function paintPrepares(page: Page): Promise<number> {
  const session = await page.createCDPSession();
  const targetId = await targetIdForSession(session);
  try {
    const stats = await session.send("Kitesurf.getMemoryStats", { targetId });
    const paint = stats.paint;
    if (typeof paint?.prepares !== "number") {
      throw new Error(`no paint stats in ${JSON.stringify(stats).slice(0, 200)}`);
    }
    return paint.prepares;
  } finally {
    await session.detach().catch(() => {});
  }
}

test("IntersectionObserver reports geometry, thresholds, margins, and lifecycle", async ({
  page,
}) => {
  await page.setViewport({ width: 200, height: 100 });
  await setContent(
    page,
    `<style>html,body{margin:0}#below{margin-top:150px;width:40px;height:20px}#visible{width:40px;height:20px}</style><div id="visible"></div><div id="below"></div>`,
  );
  const result = await page.evaluate(
    () =>
      new Promise<any>((resolve) => {
        const below = document.getElementById("below")!;
        const visible = document.getElementById("visible")!;
        const seen: any[] = [];
        const observer = new IntersectionObserver(
          function (this: any, entries: any[]) {
            seen.push({
              thisIsObserver: this === observer,
              secondIsObserver: arguments[1] === observer,
              entries: entries.map((entry) => ({
                target: entry.target.id,
                is: entry.isIntersecting,
                ratio: entry.intersectionRatio,
                hasRects: !!entry.boundingClientRect && !!entry.intersectionRect,
                hasRoot: !!entry.rootBounds,
                time: typeof entry.time,
                isEntry: entry instanceof IntersectionObserverEntry,
                isVisible: entry.isVisible,
              })),
            });
            if (seen.length === 1) resolve(seen);
          },
          { threshold: [0, 0.5, 1] },
        );
        observer.observe(below);
        observer.observe(visible);
      }),
  );
  expect(result[0].entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: "below", is: false }),
      expect.objectContaining({ target: "visible", is: true, hasRoot: true }),
    ]),
  );
  expect(result[0].thisIsObserver).toBe(true);
  expect(result[0].secondIsObserver).toBe(true);
});

test("IntersectionObserver observers are independent and lifecycle methods drain records", async ({
  page,
}) => {
  await page.setViewport({ width: 200, height: 100 });
  await setContent(page, `<div id="target"></div>`);
  const result = await page.evaluate(() => {
    const target = document.getElementById("target")!;
    let first = 0;
    let second = 0;
    const one = new IntersectionObserver(() => {
      first++;
    });
    const two = new IntersectionObserver(() => {
      second++;
    });
    one.observe(target);
    two.observe(target);
    const drained = one.takeRecords().length;
    one.disconnect();
    two.unobserve(target);
    return {
      drained,
      first,
      second,
      oneMethods: ["observe", "unobserve", "disconnect", "takeRecords"].every(
        (name) => name in one,
      ),
    };
  });
  expect(result.drained).toBe(0);
  expect(result.first).toBe(0);
  expect(result.second).toBe(0);
  expect(result.oneMethods).toBe(true);
});

test("IntersectionObserver uses viewport coordinates after document scroll", async ({ page }) => {
  await page.setViewport({ width: 200, height: 100 });
  await setContent(
    page,
    `<style>html,body{margin:0}#before,#after{height:400px}#target{width:40px;height:20px}</style><div id="before"></div><div id="target"></div><div id="after"></div>`,
  );
  const result = await page.evaluate(
    () =>
      new Promise<any>((resolve) => {
        const target = document.getElementById("target")!;
        const entries: IntersectionObserverEntry[] = [];
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve(
            entries.map((entry) => ({
              isIntersecting: entry.isIntersecting,
              top: entry.boundingClientRect.top,
              rootTop: entry.rootBounds?.top,
            })),
          );
        };
        const observer = new IntersectionObserver((changes) => {
          entries.push(...changes);
          if (entries.length === 1) {
            setTimeout(() => window.scrollTo(0, 400), 0);
          } else {
            finish();
          }
        });
        observer.observe(target);
        setTimeout(finish, 500);
      }),
  );
  expect(result).toHaveLength(2);
  expect(result[0].isIntersecting).toBe(false);
  expect(result[1].isIntersecting).toBe(true);
  expect(result[1].top).toBeLessThan(100);
  expect(result[1].rootTop).toBe(0);
});

test("IntersectionObserver zeroes every rect for a boxless target", async ({ page }) => {
  await page.setViewport({ width: 200, height: 100 });
  await setContent(
    page,
    `<style>html,body{margin:0}#target{display:none}</style><div id="target"></div>`,
  );
  const result = await page.evaluate(
    () =>
      new Promise<any>((resolve) => {
        const target = document.getElementById("target")!;
        new IntersectionObserver(([entry]: any[]) =>
          resolve({
            target: [entry.boundingClientRect.width, entry.boundingClientRect.height],
            intersection: [entry.intersectionRect.width, entry.intersectionRect.height],
            root: [entry.rootBounds?.width, entry.rootBounds?.height],
            isIntersecting: entry.isIntersecting,
          }),
        ).observe(target);
      }),
  );
  expect(result.target).toEqual([0, 0]);
  expect(result.intersection).toEqual([0, 0]);
  expect(result.root).toEqual([0, 0]);
  expect(result.isIntersecting).toBe(false);
});

test("IntersectionObserver reports a target outside an explicit root as non-intersecting", async ({
  page,
}) => {
  await page.setViewport({ width: 200, height: 100 });
  await setContent(
    page,
    `<style>html,body{margin:0}#root,#target{width:40px;height:20px}</style><div id="root"></div><div id="target"></div>`,
  );
  const result = await page.evaluate(
    () =>
      new Promise<any>((resolve) => {
        const root = document.getElementById("root")!;
        const target = document.getElementById("target")!;
        new IntersectionObserver(
          ([entry]: any[]) =>
            resolve({
              isIntersecting: entry.isIntersecting,
              ratio: entry.intersectionRatio,
            }),
          { root },
        ).observe(target);
      }),
  );
  expect(result).toEqual({ isIntersecting: false, ratio: 0 });
});

test("IntersectionObserver measures SVG descendants from the SVG snapshot", async ({ page }) => {
  await page.setViewport({ width: 200, height: 100 });
  await setContent(
    page,
    `<style>html,body{margin:0}</style><svg width="100" height="100" viewBox="0 0 100 100"><rect id="target" x="10" y="20" width="30" height="40"/></svg>`,
  );
  const result = await page.evaluate(
    () =>
      new Promise<any>((resolve) => {
        const target = document.getElementById("target")!;
        new IntersectionObserver(([entry]: any[]) =>
          resolve({
            rect: [
              entry.boundingClientRect.x,
              entry.boundingClientRect.y,
              entry.boundingClientRect.width,
              entry.boundingClientRect.height,
            ],
            ratio: entry.intersectionRatio,
            isIntersecting: entry.isIntersecting,
          }),
        ).observe(target);
      }),
  );
  expect(result).toEqual({ rect: [10, 20, 30, 40], ratio: 1, isIntersecting: true });
});

test("IntersectionObserver reports callback errors and continues delivery", async ({ page }) => {
  await page.setViewport({ width: 200, height: 100 });
  await setContent(page, `<div id="target"></div>`);
  const result = await page.evaluate(
    () =>
      new Promise<any>((resolve) => {
        const target = document.getElementById("target")!;
        const errors: string[] = [];
        let secondCallback = false;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve({ errors, secondCallback });
        };
        window.onerror = (_message, _source, _line, _column, error) => {
          errors.push(error?.message || String(error));
          if (secondCallback) finish();
        };
        new IntersectionObserver(() => {
          throw new Error("intersection callback failed");
        }).observe(target);
        new IntersectionObserver(() => {
          secondCallback = true;
          if (errors.length > 0) finish();
        }).observe(target);
        setTimeout(finish, 500);
      }),
  );
  expect(
    result.errors.some((message: string) => message.includes("intersection callback failed")),
  ).toBe(true);
  expect(result.secondCallback).toBe(true);
});

test("IntersectionObserver exposes the WebIDL-shaped API surface", async ({ page }) => {
  await page.setViewport({ width: 200, height: 100 });
  await setContent(page, `<div id="root"></div>`);
  const result = await page.evaluate(() => {
    const root = document.getElementById("root")!;
    const observer = new IntersectionObserver(() => {}, {
      root: document,
      rootMargin: "",
      threshold: [],
    });
    const EntryCtor = IntersectionObserverEntry as any;
    const entry = new EntryCtor({
      time: 0,
      rootBounds: null,
      boundingClientRect: {},
      intersectionRect: {},
      isIntersecting: false,
      isVisible: false,
      intersectionRatio: 0,
      target: root,
    });
    const rootDescriptor = Object.getOwnPropertyDescriptor(IntersectionObserver.prototype, "root");
    return {
      rootIsDocument: observer.root === document,
      rootMargin: observer.rootMargin,
      thresholds: [...observer.thresholds],
      rootPrototypeProperty: Boolean(rootDescriptor),
      ownRoot: Object.prototype.hasOwnProperty.call(observer, "root"),
      entryTarget: entry.target === root,
      entryIsIntersecting: entry.isIntersecting,
    };
  });
  expect(result).toEqual({
    rootIsDocument: true,
    rootMargin: "0px 0px 0px 0px",
    thresholds: [0],
    rootPrototypeProperty: true,
    ownRoot: false,
    entryTarget: true,
    entryIsIntersecting: false,
  });
});

test("IntersectionObserver returns the margin-expanded root bounds", async ({ page }) => {
  await page.setViewport({ width: 200, height: 100 });
  await setContent(page, `<div id="target"></div>`);
  const result = await page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const target = document.getElementById("target")!;
        new IntersectionObserver(
          ([entry]: any[]) =>
            resolve([
              entry.rootBounds.left,
              entry.rootBounds.top,
              entry.rootBounds.right,
              entry.rootBounds.bottom,
            ]),
          { rootMargin: "10px 20px 30px 40px" },
        ).observe(target);
      }),
  );
  expect(result).toEqual([-40, -10, 220, 130]);
});

test("IntersectionObserver converts absolute margin units before expanding root bounds", async ({
  page,
}) => {
  await page.setViewport({ width: 200, height: 100 });
  await setContent(page, `<div id="target"></div>`);
  const result = await page.evaluate(
    () =>
      new Promise<any>((resolve) => {
        const observer = new IntersectionObserver(
          ([entry]: any[]) =>
            resolve({
              rootMargin: observer.rootMargin,
              scrollMargin: (observer as IntersectionObserver & { scrollMargin: string })
                .scrollMargin,
              rootBounds: [
                entry.rootBounds.left,
                entry.rootBounds.top,
                entry.rootBounds.right,
                entry.rootBounds.bottom,
              ],
            }),
          {
            rootMargin: "1in 2cm 10% 2pc",
            scrollMargin: "10mm 10q",
          } as IntersectionObserverInit & { scrollMargin: string },
        );
        observer.observe(document.getElementById("target")!);
      }),
  );
  expect(result).toEqual({
    rootMargin: "96px 75px 10% 32px",
    scrollMargin: "37px 9px 37px 9px",
    rootBounds: [-32, -96, 275, 110],
  });
});

test("IntersectionObserver clips through scroll containers and expands them by scrollMargin", async ({
  page,
}) => {
  await page.setViewport({ width: 200, height: 100 });
  await setContent(
    page,
    `<style>html,body{margin:0}#scroller{overflow:hidden;width:100px;height:50px}#spacer{height:60px}#target{width:40px;height:20px}</style><div id="scroller"><div id="spacer"></div><div id="target"></div></div>`,
  );
  const result = await page.evaluate(() => {
    const target = document.getElementById("target")!;
    const observe = (init: IntersectionObserverInit & { scrollMargin?: string }) =>
      new Promise<any>((resolve) => {
        new IntersectionObserver(
          ([entry]: any[]) =>
            resolve({
              isIntersecting: entry.isIntersecting,
              ratio: entry.intersectionRatio,
              intersection: [entry.intersectionRect.top, entry.intersectionRect.bottom],
            }),
          init,
        ).observe(target);
      });
    return Promise.all([observe({}), observe({ scrollMargin: "20px" })]);
  });
  expect(result).toEqual([
    { isIntersecting: false, ratio: 0, intersection: [0, 0] },
    { isIntersecting: true, ratio: 0.5, intersection: [60, 70] },
  ]);
});

test("IntersectionObserver keeps the static x of a fixed target with auto insets", async ({
  page,
}) => {
  await page.setViewport({ width: 200, height: 100 });
  await setContent(
    page,
    `<style>body{margin:8px}#target{position:fixed;top:-1000px;width:0;height:0}</style><div id="target"></div>`,
  );
  const result = await page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        new IntersectionObserver(([entry]: any[]) =>
          resolve([entry.boundingClientRect.left, entry.boundingClientRect.top]),
        ).observe(document.getElementById("target")!);
      }),
  );
  expect(result).toEqual([8, -1000]);
});

test("IntersectionObserver sees an inline-block target on its nowrap line", async ({ page }) => {
  await page.setViewport({ width: 200, height: 100 });
  await setContent(
    page,
    `<style>body{margin:8px}.s{display:inline-block;width:300px}#t{display:inline-block;width:50px;height:50px}</style><div id="line" style="white-space:nowrap"><div class="s"></div> <div id="t"></div> <div class="s"></div></div>`,
  );
  const result = await page.evaluate(
    () =>
      new Promise<any>((resolve) => {
        new IntersectionObserver(([entry]: any[]) =>
          resolve({
            top: entry.boundingClientRect.top,
            sameLine: entry.boundingClientRect.left > 300,
            lineHasStrutDescent:
              document.getElementById("line")!.getBoundingClientRect().height > 50,
            isIntersecting: entry.isIntersecting,
          }),
        ).observe(document.getElementById("t")!);
      }),
  );
  expect(result).toEqual({
    top: 8,
    sameLine: true,
    lineHasStrutDescent: true,
    isIntersecting: false,
  });
});

test("IntersectionObserver clips by ancestor clip-path insets, grown by scrollMargin", async ({
  page,
}) => {
  await page.setViewport({ width: 200, height: 100 });
  await setContent(
    page,
    `<style>html,body{margin:0}#clip{clip-path:inset(0 0 10px 0)}#scroller{overflow:hidden;clip-path:inset(0 0 30px 0);height:50px}#spacer{height:25px}#t1,#t2{width:40px;height:20px}</style><div id="clip"><div id="t1"></div></div><div id="scroller"><div id="spacer"></div><div id="t2"></div></div>`,
  );
  const result = await page.evaluate(() => {
    const observe = (id: string, init: IntersectionObserverInit & { scrollMargin?: string }) =>
      new Promise<any>((resolve) => {
        new IntersectionObserver(
          ([entry]: any[]) => resolve([entry.isIntersecting, entry.intersectionRatio]),
          init,
        ).observe(document.getElementById(id)!);
      });
    return Promise.all([
      observe("t1", {}),
      observe("t2", {}),
      observe("t2", { scrollMargin: "10px" }),
    ]);
  });
  expect(result).toEqual([
    [true, 0.5],
    [false, 0],
    [true, 0.25],
  ]);
});

test("IntersectionObserver stays silent for a target in a detached document until adopted", async ({
  page,
}) => {
  await page.setViewport({ width: 200, height: 100 });
  await setContent(page, `<style>html,body{margin:0}</style>`);
  const result = await page.evaluate(async () => {
    const target = document.implementation.createHTMLDocument("").createElement("div");
    target.style.cssText = "width:40px;height:20px";
    const entries: boolean[] = [];
    new IntersectionObserver((records) => {
      for (const record of records) entries.push(record.isIntersecting);
    }).observe(target);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const beforeAdopt = entries.length;
    document.body.appendChild(document.adoptNode(target));
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { beforeAdopt, entries };
  });
  expect(result).toEqual({ beforeAdopt: 0, entries: [true] });
});

test("IntersectionObserver bounds paint prep during per-frame mutations", async ({ page }) => {
  await page.setViewport({ width: 200, height: 100 });
  await setContent(
    page,
    `<style>html,body{margin:0}.target{width:20px;height:20px}</style><div id="text">start</div>${"<div>filler</div>".repeat(1000)}${"<div class=target></div>".repeat(20)}`,
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const targets = document.querySelectorAll(".target");
        const observer = new IntersectionObserver((entries) => {
          if (entries.length === targets.length) resolve();
        });
        targets.forEach((target) => observer.observe(target));
        (window as any).__costObserver = observer;
      }),
  );
  const before = await paintPrepares(page);
  const started = Date.now();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const text = document.getElementById("text")!.firstChild!;
        let frames = 0;
        const tick = () => {
          text.textContent = String(++frames);
          if (frames === 60) {
            (window as any).__costObserver.disconnect();
            resolve();
          } else {
            requestAnimationFrame(tick);
          }
        };
        requestAnimationFrame(tick);
      }),
  );
  const elapsed = Date.now() - started;
  const after = await paintPrepares(page);
  expect(
    after - before,
    `60 frames in ${elapsed} ms should not prep each frame`,
  ).toBeLessThanOrEqual(Math.ceil(elapsed / 250) + 8);
});

test("IntersectionObserver reports a quiet layout mutation promptly", async ({ page }) => {
  await page.setViewport({ width: 200, height: 100 });
  await setContent(
    page,
    `<style>html,body{margin:0}#target{margin-top:150px;width:40px;height:20px}</style><div id="target"></div>`,
  );
  const result = await page.evaluate(
    () =>
      new Promise<{ initial: boolean; entered: boolean }>((resolve) => {
        const target = document.getElementById("target")!;
        let initial = false;
        let entered = false;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          observer.disconnect();
          resolve({ initial, entered });
        };
        const observer = new IntersectionObserver((entries) => {
          const entry = entries[0]!;
          if (!initial) {
            initial = !entry.isIntersecting;
            target.style.marginTop = "0px";
            requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(finish, 0)));
            setTimeout(finish, 300);
          } else if (entry.isIntersecting) {
            entered = true;
          }
        });
        observer.observe(target);
      }),
  );
  expect(result.initial).toBe(true);
  expect(result.entered, "layout mutation must be delivered by the next frame tasks").toBe(true);
});

test("IntersectionObserver samples element scroll without paint prep", async ({ page }) => {
  await page.setViewport({ width: 200, height: 100 });
  await setContent(
    page,
    `<style>html,body{margin:0}#scroller{overflow:auto;width:100px;height:50px}#spacer{height:80px}#target{width:40px;height:20px}</style><div id="scroller"><div id="spacer"></div><div id="target"></div></div>`,
  );
  const initial = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        let entered: (value: boolean) => void;
        (window as any).__scrollEntered = new Promise<boolean>((done) => {
          entered = done;
        });
        const observer = new IntersectionObserver((entries) => {
          if (entries[0]!.isIntersecting) {
            observer.disconnect();
            entered(true);
          } else {
            resolve(false);
          }
        });
        observer.observe(document.getElementById("target")!);
      }),
  );
  expect(initial).toBe(false);
  const before = await paintPrepares(page);
  const entered = await page.evaluate(() => {
    document.getElementById("scroller")!.scrollTop = 60;
    return Promise.race([
      (window as any).__scrollEntered as Promise<boolean>,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
    ]);
  });
  const after = await paintPrepares(page);
  expect(entered).toBe(true);
  expect(after - before, "element scroll should reuse committed layout").toBe(0);
});
