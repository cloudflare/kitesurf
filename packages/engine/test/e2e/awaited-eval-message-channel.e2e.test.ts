// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const CHAIN = `new Promise(resolve => {
  let n = 0;
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    if (++n < 8) channel.port2.postMessage(0);
    else resolve(n);
  };
  channel.port2.postMessage(0);
})`;

const TIMER_ORDER = `new Promise(resolve => {
  const order = [];
  setTimeout(() => {
    order.push("timer-a");
    Promise.resolve().then(() => order.push("microtask-a"));
  }, 0);
  setTimeout(() => {
    order.push("timer-b");
    resolve(order);
  }, 0);
})`;

const NATIVE_MICROTASK_ORDER = `new Promise(resolve => {
  const order = [];
  setTimeout(() => order.push("timer"), 0);
  queueMicrotask(() => order.push("microtask"));
  setTimeout(() => resolve(order), 0);
})`;

const MUTATION_OBSERVER_ORDER = `new Promise(resolve => {
  const order = [];
  const observer = new MutationObserver(() => order.push("observer"));
  observer.observe(document.body, { attributes: true });
  setTimeout(() => order.push("timer"), 0);
  document.body.setAttribute("data-order", "1");
  setTimeout(() => {
    observer.disconnect();
    resolve(order);
  }, 0);
})`;

test("awaited evaluate drains message-channel timers", async ({ page }) => {
  await setContent(page, "<main>awaited eval</main>");
  const cdp = await page.createCDPSession();

  const evaluated = await cdp.send("Runtime.evaluate", {
    expression: CHAIN,
    awaitPromise: true,
    returnByValue: true,
  });
  expect(evaluated.result.value).toBe(8);
});

test("awaited evaluation checkpoints microtasks between page timers", async ({ page }) => {
  await setContent(page, "<main>timer ordering</main>");
  const cdp = await page.createCDPSession();

  const evaluated = await cdp.send("Runtime.evaluate", {
    expression: TIMER_ORDER,
    awaitPromise: true,
    returnByValue: true,
  });
  expect(evaluated.result.value).toEqual(["timer-a", "microtask-a", "timer-b"]);
});

test("awaited evaluation runs native microtasks before overdue timers", async ({ page }) => {
  await setContent(page, "<main>native ordering</main>");
  const cdp = await page.createCDPSession();

  const cases: Array<[string, string[]]> = [
    [NATIVE_MICROTASK_ORDER, ["microtask", "timer"]],
    [MUTATION_OBSERVER_ORDER, ["observer", "timer"]],
  ];
  for (const [expression, expected] of cases) {
    const evaluated = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    expect(evaluated.result.value).toEqual(expected);
  }
});
