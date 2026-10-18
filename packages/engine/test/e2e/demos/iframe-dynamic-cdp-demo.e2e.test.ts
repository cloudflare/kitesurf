// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("iframe-dynamic-cdp-demo", async ({ page, cdpSession: client }) => {
  await client.send("Page.enable");

  const events = [];
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

  const eventsSinceSnapshot = () => events.slice(beforeCount);
  try {
    await expect
      .poll(
        () =>
          ["Page.frameAttached", "Page.frameNavigated", "Page.frameStoppedLoading"].every((name) =>
            eventsSinceSnapshot().some((event) => event.name === name),
          ) &&
          ["init", "DOMContentLoaded", "load"].every((name) =>
            eventsSinceSnapshot().some(
              (event) => event.name === "Page.lifecycleEvent" && event.params?.name === name,
            ),
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
  } catch {}

  const dynamicEvents = events.slice(beforeCount);
  const methodCounts = {};
  for (const ev of dynamicEvents) {
    methodCounts[ev.name] = (methodCounts[ev.name] || 0) + 1;
  }

  console.log("[iframe-dyn] dynamic frame events:", JSON.stringify(methodCounts));

  const attached = dynamicEvents.find((e) => e.name === "Page.frameAttached");
  const navigated = dynamicEvents.find((e) => e.name === "Page.frameNavigated");
  const stopped = dynamicEvents.find((e) => e.name === "Page.frameStoppedLoading");
  const lifecycleNames = dynamicEvents
    .filter((e) => e.name === "Page.lifecycleEvent")
    .map((e) => e.params.name);

  console.log("[iframe-dyn] attached frameId:", attached?.params?.frameId?.slice(0, 8) + "…");
  console.log("[iframe-dyn] navigated URL:", navigated?.params?.frame?.url);
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

  const frames = page.frames();
  console.log("[iframe-dyn] page.frames() count:", frames.length);
  expect(frames.length >= 2, "Expected at least 2 frames (main + dynamic)").toBeTruthy();
});
