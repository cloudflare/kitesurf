// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("EventTarget bridges retain their names and function prototypes", async ({ page }) => {
  await setContent(page, "<p>x</p>");
  const methods = await page.evaluate(() =>
    [EventTarget.prototype.addEventListener, EventTarget.prototype.removeEventListener].map(
      (method) => ({
        name: method.name,
        length: method.length,
        prototype: Object.hasOwn(method, "prototype"),
      }),
    ),
  );
  expect(methods).toEqual([
    { name: "addEventListener", length: 2, prototype: true },
    { name: "removeEventListener", length: 2, prototype: true },
  ]);
});

test("a numeric non-options measure start retains the zero fallback", async ({ page }) => {
  await setContent(page, "<p>x</p>");
  const startTime = await page.evaluate(
    () => Reflect.apply(performance.measure, performance, ["numeric-start", 100]).startTime,
  );
  expect(startTime).toBe(0);
});

test("PerformanceMark preserves option rereads around name coercion", async ({ page }) => {
  await setContent(page, "<p>x</p>");
  const result = await page.evaluate(() => {
    const reads: string[] = [];
    let startReads = 0;
    let detailReads = 0;
    const mark = Reflect.construct(PerformanceMark, [
      {
        toString() {
          reads.push("name");
          return "accessor-mark";
        },
      },
      {
        get startTime() {
          reads.push("startTime");
          return ++startReads;
        },
        get detail() {
          reads.push("detail");
          return ++detailReads;
        },
      },
    ]);
    return { reads, startTime: mark.startTime, detail: mark.detail };
  });
  expect(result).toEqual({
    reads: ["startTime", "startTime", "name", "detail", "detail"],
    startTime: 2,
    detail: 2,
  });
});

test("measure reads numeric endpoints before detail without reading duration", async ({ page }) => {
  await setContent(page, "<p>x</p>");
  const result = await page.evaluate(() => {
    const reads: string[] = [];
    let startReads = 0;
    let endReads = 9;
    let detailReads = 0;
    const measure = performance.measure("accessor-measure", {
      get start() {
        reads.push("start");
        return ++startReads;
      },
      get end() {
        reads.push("end");
        return ++endReads;
      },
      get duration(): number {
        throw new Error("duration must not be read when end is numeric");
      },
      get detail() {
        reads.push("detail");
        return ++detailReads;
      },
    });
    return {
      reads,
      startTime: measure.startTime,
      duration: measure.duration,
      detail: measure.detail,
    };
  });
  expect(result).toEqual({
    reads: ["start", "start", "end", "end", "detail", "detail"],
    startTime: 2,
    duration: 9,
    detail: 2,
  });
});

test("inherited object keys are not media feature names", async ({ page }) => {
  await setContent(page, "<p>x</p>");
  expect(await page.evaluate(() => matchMedia("(constructor: undefined)").matches)).toBe(false);
});

test("ResizeObserver retains border dimensions when style lookup throws", async ({ page }) => {
  await setContent(page, "<p>x</p>");
  const dimensions = await page.evaluate(async () => {
    const target = document.createElement("div");
    target.getBoundingClientRect = () => new DOMRect(0, 0, 37, 19);
    document.body.appendChild(target);
    const previousGetComputedStyle = window.getComputedStyle;
    let observer: ResizeObserver | undefined;
    try {
      window.getComputedStyle = () => {
        throw new Error("style lookup failed");
      };
      return await new Promise<{ width: number; height: number }>((resolve, reject) => {
        observer = new ResizeObserver((entries) => {
          const entry = entries[0];
          if (!entry) {
            reject(new Error("missing resize entry"));
            return;
          }
          resolve({ width: entry.contentRect.width, height: entry.contentRect.height });
        });
        observer.observe(target);
      });
    } finally {
      observer?.disconnect();
      window.getComputedStyle = previousGetComputedStyle;
      target.remove();
    }
  });
  expect(dimensions).toEqual({ width: 37, height: 19 });
});
