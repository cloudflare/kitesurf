// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { targetIdForSession } from "./connect";

test("page timers share one native wake without losing timer semantics", async ({ page }) => {
  await setContent(page, "");

  const timeoutReport = (await page.evaluate(`(async () => {
    const timeoutIds = [];
    let timeoutError = null;
    try {
      for (let i = 0; i < 11000; i++) {
        timeoutIds.push(setTimeout(() => {}, 5000));
      }
    } catch (error) {
      timeoutError = error.name;
    }

    let zeroFired = false;
    const zeroStartedAt = Date.now();
    await new Promise((resolve) => setTimeout(() => {
      zeroFired = true;
      resolve();
    }, 0));
    const zeroDelay = Date.now() - zeroStartedAt;
    for (const id of timeoutIds) clearTimeout(id);
    return { timeoutError, zeroFired, zeroDelay };
  })()`)) as { timeoutError: string | null; zeroFired: boolean; zeroDelay: number };

  expect(timeoutReport.timeoutError).toBe(null);
  expect(timeoutReport.zeroFired).toBe(true);
  expect(timeoutReport.zeroDelay).toBeLessThan(1000);

  const stringTimerError = await page.evaluate(`(() => {
    const ids = [];
    let errorName = null;
    try {
      for (let i = 0; i < 11000; i++) ids.push(setTimeout("void 0", 5000));
    } catch (error) {
      errorName = error.name;
    }
    for (const id of ids) clearTimeout(String(id));
    return errorName;
  })()`);
  expect(stringTimerError).toBe(null);

  const intervalError = await page.evaluate(`(() => {
    const intervalIds = [];
    let intervalError = null;
    try {
      for (let i = 0; i < 11000; i++) {
        intervalIds.push(setInterval(() => {}, 5000));
      }
    } catch (error) {
      intervalError = error.name;
    }
    for (const id of intervalIds) clearInterval(id);
    return intervalError;
  })()`);
  expect(intervalError).toBe(null);

  const clearingReport = await page.evaluate(`(async () => {
    const crossCleared = [];
    const timeoutId = setTimeout(() => { crossCleared.push("timeout"); }, 0);
    clearInterval(timeoutId);
    const intervalId = setInterval(() => { crossCleared.push("interval"); }, 0);
    clearTimeout(intervalId);

    let selfClearingIntervalCalls = 0;
    await new Promise((resolve) => {
      const id = setInterval(() => {
        selfClearingIntervalCalls++;
        clearInterval(id);
        setTimeout(resolve, 5);
      }, 0);
    });
    return { crossCleared, selfClearingIntervalCalls };
  })()`);
  expect(clearingReport).toEqual({
    crossCleared: [],
    selfClearingIntervalCalls: 1,
  });

  const compatibilityReport = (await page.evaluate(`(async () => {
    const startedAt = performance.now();
    await new Promise((resolve) => setTimeout(resolve, "20"));
    const coercedDelay = performance.now() - startedAt;

    const originalDateNow = Date.now;
    Date.now = () => 0;
    let firedWithPatchedDate = false;
    await new Promise((resolve) => setTimeout(() => {
      firedWithPatchedDate = true;
      resolve();
    }, 5));
    Date.now = originalDateNow;

    let repeatedIntervalCalls = 0;
    await new Promise((resolve) => {
      const id = setInterval(() => {
        repeatedIntervalCalls++;
        if (repeatedIntervalCalls === 3) {
          clearInterval(id);
          resolve();
        }
      }, 1);
    });
    return { coercedDelay, firedWithPatchedDate, repeatedIntervalCalls };
  })()`)) as {
    coercedDelay: number;
    firedWithPatchedDate: boolean;
    repeatedIntervalCalls: number;
  };
  expect(compatibilityReport.coercedDelay).toBeGreaterThanOrEqual(10);
  expect(compatibilityReport.firedWithPatchedDate).toBe(true);
  expect(compatibilityReport.repeatedIntervalCalls).toBe(3);

  const order = await page.evaluate(`(async () => {
    const order = [];
    await new Promise((resolve) => {
      setTimeout(() => { order.push(1); }, 0);
      setTimeout(() => { order.push(2); }, 0);
      setTimeout(() => { order.push(3); }, 0);
      setTimeout(resolve, 0);
    });
    return order;
  })()`);
  expect(order).toEqual([1, 2, 3]);

  const taskOrder = await page.evaluate(`(async () => {
    const order = [];
    await new Promise((resolve) => {
      setTimeout(() => {
        order.push("timer-a");
        Promise.resolve()
          .then(() => { order.push("microtask-a"); })
          .then(() => {
            order.push("microtask-b");
            clearTimeout(timerB);
          });
      }, 0);
      const timerB = setTimeout(() => { order.push("timer-b"); }, 0);
      setTimeout(resolve, 10);
    });
    return order;
  })()`);
  expect(taskOrder).toEqual(["timer-a", "microtask-a", "microtask-b"]);

  const wrappedRafResult = await page.evaluate(`(async () => {
    const originalRaf = requestAnimationFrame;
    requestAnimationFrame = (callback) => originalRaf(callback);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve("timeout"), 1000);
      requestAnimationFrame(() => {
        clearTimeout(timeout);
        resolve("raf");
      });
    });
  })()`);
  expect(wrappedRafResult).toBe("raf");

  const ranAfterThrow = await page.evaluate(`(async () => {
    let ranAfterThrow = false;
    await new Promise((resolve) => {
      setTimeout(() => { throw new Error("expected timer-wheel test error"); }, 0);
      setTimeout(() => {
        ranAfterThrow = true;
        resolve();
      }, 0);
    });
    return ranAfterThrow;
  })()`);
  expect(ranAfterThrow).toBe(true);
}, 120_000);

test("an awaited evaluation sleeps until the next page timer", async ({ page }) => {
  await setContent(page, "");
  const session = await page.createCDPSession();
  const targetId = await targetIdForSession(session);
  const wakes = async (): Promise<number> => {
    const stats = await session.send("Kitesurf.getMemoryStats", { targetId });
    const fired = stats.timerWheel?.wakesFired;
    if (typeof fired !== "number") throw new Error("no timer wheel stats");
    return fired;
  };
  const before = await wakes();
  await page.evaluate(`new Promise((resolve) => {
    let left = 10;
    (function tick() { if (--left === 0) resolve(); else setTimeout(tick, 20); })();
  })`);
  const fired = (await wakes()) - before;
  expect(fired).toBeLessThanOrEqual(60);
});
