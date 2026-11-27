// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("PerformanceObserver delivers marks and measures in a later task", async ({ page }) => {
  await setContent(page, "<p>observer</p>");
  const result = await page.evaluate(async () => {
    const calls: unknown[] = [];
    let synchronous = true;
    const done = new Promise<void>((resolve) => {
      const callback = (
        list: PerformanceObserverEntryList,
        self: PerformanceObserver,
        options?: { droppedEntriesCount?: number },
      ) => {
        calls.push({
          synchronous,
          self: self === observer,
          names: list.getEntries().map((entry) => `${entry.entryType}:${entry.name}`),
          marks: list.getEntriesByType("mark").length,
          byName: list.getEntriesByName("m").length,
          dropped: options?.droppedEntriesCount,
        });
        observer.disconnect();
        resolve();
      };
      const observer = new PerformanceObserver(callback);
      observer.observe({ entryTypes: ["mark", "measure"] });
    });
    performance.mark("m");
    performance.measure("between", "m");
    synchronous = false;
    await done;
    return calls;
  });
  expect(result).toEqual([
    {
      synchronous: false,
      self: true,
      names: ["mark:m", "measure:between"],
      marks: 1,
      byName: 1,
      dropped: 0,
    },
  ]);
});

test("PerformanceObserver disconnect drops queued entries", async ({ page }) => {
  await setContent(page, "<p>observer</p>");
  const result = await page.evaluate(async () => {
    const delivered: string[][] = [];
    const observer = new PerformanceObserver((list) => {
      delivered.push(list.getEntries().map((entry) => entry.name));
    });
    observer.observe({ type: "mark" });
    performance.mark("before-disconnect");
    observer.disconnect();
    const afterDisconnect = observer.takeRecords().length;
    observer.observe({ type: "mark" });
    performance.mark("after-reobserve");
    const taken = observer.takeRecords().map((entry) => entry.name);
    performance.mark("delivered");
    await new Promise((resolve) => setTimeout(resolve, 50));
    observer.disconnect();
    return { afterDisconnect, taken, delivered };
  });
  expect(result).toEqual({
    afterDisconnect: 0,
    taken: ["after-reobserve"],
    delivered: [["delivered"]],
  });
});

test("PerformanceObserver buffered type observation replays earlier marks", async ({ page }) => {
  await setContent(page, "<p>observer</p>");
  const result = await page.evaluate(async () => {
    performance.mark("early");
    const names = await new Promise<string[]>((resolve) => {
      const observer = new PerformanceObserver((list) => {
        observer.disconnect();
        resolve(list.getEntries().map((entry) => entry.name));
      });
      observer.observe({ type: "mark", buffered: true });
    });
    const errors: string[] = [];
    const observer = new PerformanceObserver(() => {});
    observer.observe({ type: "mark" });
    try {
      observer.observe({ entryTypes: ["mark"] });
    } catch (error) {
      errors.push((error as Error).name);
    }
    try {
      observer.observe({});
    } catch (error) {
      errors.push((error as Error).name);
    }
    observer.disconnect();
    return { names, errors };
  });
  expect(result).toEqual({ names: ["early"], errors: ["InvalidModificationError", "TypeError"] });
});
