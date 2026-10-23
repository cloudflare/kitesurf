// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

type DynamicEvent = {
  name: string;
  params: {
    name?: string;
    frameId?: string;
    frame?: { url?: string };
    node?: { nodeName?: string };
  };
};

function hasMethod(events: DynamicEvent[], name: string): boolean {
  return events.some((event) => event.name === name);
}

function hasLifecycleEvent(events: DynamicEvent[], name: string): boolean {
  return events.some((event) => event.name === "Page.lifecycleEvent" && event.params.name === name);
}

function hasDynamicFrameEvents(events: DynamicEvent[]): boolean {
  const frameMethods = ["Page.frameAttached", "Page.frameNavigated", "Page.frameStoppedLoading"];
  const lifecycleNames = ["init", "DOMContentLoaded", "load"];
  return (
    frameMethods.every((name) => hasMethod(events, name)) &&
    lifecycleNames.every((name) => hasLifecycleEvent(events, name))
  );
}

async function waitForDynamicFrameEvents(events: DynamicEvent[], start: number): Promise<void> {
  await expect
    .poll(() => hasDynamicFrameEvents(events.slice(start)), { timeout: 10_000 })
    .toBe(true)
    .catch(() => {});
}

function countEventMethods(events: DynamicEvent[]): Record<string, number> {
  const methodCounts: Record<string, number> = {};
  for (const event of events) {
    methodCounts[event.name] = (methodCounts[event.name] ?? 0) + 1;
  }
  return methodCounts;
}

function assertDynamicFrameEvents(events: DynamicEvent[]): void {
  const attached = events.find((event) => event.name === "Page.frameAttached");
  const navigated = events.find((event) => event.name === "Page.frameNavigated");
  const stopped = events.find((event) => event.name === "Page.frameStoppedLoading");
  const lifecycleNames = events
    .filter((event) => event.name === "Page.lifecycleEvent")
    .map((event) => event.params.name);

  console.log("[iframe-dyn] attached frameId:", attached?.params.frameId?.slice(0, 8) + "…");
  console.log("[iframe-dyn] navigated URL:", navigated?.params.frame?.url);
  console.log("[iframe-dyn] lifecycle names:", lifecycleNames);
  console.log("[iframe-dyn] frameStoppedLoading fired:", !!stopped);

  expect(attached, "Page.frameAttached not emitted for dynamic frame").toBeTruthy();
  expect(navigated, "Page.frameNavigated not emitted for dynamic frame").toBeTruthy();
  expect(stopped, "Page.frameStoppedLoading not emitted for dynamic frame").toBeTruthy();
  expect(lifecycleNames.includes("init"), "lifecycle 'init' missing").toBeTruthy();
  expect(
    lifecycleNames.includes("DOMContentLoaded"),
    "lifecycle 'DOMContentLoaded' missing",
  ).toBeTruthy();
  expect(lifecycleNames.includes("load"), "lifecycle 'load' missing").toBeTruthy();
}

test("iframe-dynamic-cdp-demo", async ({ page, cdpSession: client }) => {
  await client.send("Page.enable");

  const events: DynamicEvent[] = [];
  for (const name of [
    "Page.frameAttached",
    "Page.frameStartedLoading",
    "Page.frameNavigated",
    "Page.lifecycleEvent",
    "Page.frameStoppedLoading",
  ]) {
    client.on(name, (params) => events.push({ name, params }));
  }

  await page.goto("http://127.0.0.1:8787/__fixtures/iframe-host.html");

  const beforeCount = events.length;

  await page.evaluate(() => {
    const ifr = document.createElement("iframe");
    ifr.src = "/__fixtures/iframe-child.html";
    document.body.appendChild(ifr);
  });

  await waitForDynamicFrameEvents(events, beforeCount);

  const dynamicEvents = events.slice(beforeCount);
  const methodCounts = countEventMethods(dynamicEvents);

  console.log("[iframe-dyn] dynamic frame events:", JSON.stringify(methodCounts));
  assertDynamicFrameEvents(dynamicEvents);

  const frames = page.frames();
  console.log("[iframe-dyn] page.frames() count:", frames.length);
  expect(frames.length >= 2, "Expected at least 2 frames (main + dynamic)").toBeTruthy();
});
