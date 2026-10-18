// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("event-listener-fixes-demo", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/lifecycle.html", {
    waitUntil: "load",
    timeout: 15000,
  });

  const captureProbe = await page.evaluate(() => {
    let supportsAdd = false;
    let supportsRemove = false;
    const addOpts = {
      get capture() {
        supportsAdd = true;
        return false;
      },
    };
    const removeOpts = {
      get capture() {
        supportsRemove = true;
        return false;
      },
    };
    document.addEventListener("test_event", null, addOpts);
    document.removeEventListener("test_event", null, removeOpts);
    return { supportsAdd, supportsRemove };
  });
  expect(
    captureProbe.supportsAdd,
    "addEventListener must read options.capture even with null listener",
  ).toBe(true);
  expect(
    captureProbe.supportsRemove,
    "removeEventListener must read options.capture even with null listener",
  ).toBe(true);

  const handleEventProbe = await page.evaluate(() => {
    const target = document.createElement("div");
    let calls = 0;
    target.addEventListener("foo", {
      get handleEvent() {
        calls++;
        return function () {};
      },
    });
    target.dispatchEvent(new Event("foo"));
    target.dispatchEvent(new Event("foo"));
    return calls;
  });
  expect(
    handleEventProbe,
    `handleEvent getter must run exactly once per dispatch (got ${handleEventProbe})`,
  ).toBe(2);

  const callableHandleEventProbe = await page.evaluate(() => {
    const target = document.createElement("div");
    let calls = 0;
    let badCalls = 0;
    const listener = function () {
      calls++;
    };
    listener.handleEvent = function () {
      badCalls++;
    };
    target.addEventListener("foo", listener);
    target.dispatchEvent(new Event("foo"));
    return { calls, badCalls };
  });
  expect(callableHandleEventProbe.calls, "callable listener must run as a function").toBe(1);
  expect(
    callableHandleEventProbe.badCalls,
    "handleEvent on a callable listener must NOT be invoked",
  ).toBe(0);

  const windowEvent = await page.evaluate(() => {
    const hasOwn = Object.prototype.hasOwnProperty.call(window, "event");
    const value = window.event;
    return { hasOwn, valueIsUndefined: value === undefined };
  });
  expect(windowEvent.hasOwn, "window.event should be an own property (initially undefined)").toBe(
    true,
  );
  expect(
    windowEvent.valueIsUndefined,
    "window.event should be undefined when no event is in flight",
  ).toBe(true);
});
