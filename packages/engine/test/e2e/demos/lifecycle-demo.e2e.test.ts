// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("lifecycle-demo", async ({ page }) => {
  const FIXTURE_URL =
    process.env.KITESURF_FIXTURE ?? "http://127.0.0.1:8787/__fixtures/lifecycle.html";
  const SECOND_URL =
    process.env.KITESURF_FIXTURE2 ?? "http://127.0.0.1:8787/__fixtures/inline-script.html";

  const expectFirstNavigate = [
    { label: "inline-1", readyState: "loading" },
    { label: "inline-2", readyState: "loading" },
    { label: "defer-script", readyState: "loading" },
    { label: "readystatechange:interactive" },
    { label: "DOMContentLoaded" },
    { label: "async-script", readyState: "interactive" },
    { label: "readystatechange:complete" },
    { label: "load" },
    { label: "pageshow" },
  ];

  function compareEntry(idx, expected, actual) {
    expect(actual, `position ${idx}: missing entry, expected ${expected.label}`).toBeTruthy();
    expect(actual.label, `position ${idx} label`).toBe(expected.label);
    if (expected.readyState !== undefined) {
      expect(actual.readyState, `position ${idx} readyState`).toBe(expected.readyState);
    }
  }

  await page.goto(FIXTURE_URL, { timeout: 15000 });

  const finalReadyState = await page.evaluate(() => document.readyState);
  console.log("[lc] final readyState =", finalReadyState);
  expect(finalReadyState, "final readyState").toBe("complete");

  const log1 = await page.evaluate(() => globalThis.__ks_lifecycle_log);
  console.log("[lc] navigate-1 log:");
  for (const entry of log1) console.log("  ", JSON.stringify(entry));

  expect(log1.length, "navigate-1 entry count").toBe(expectFirstNavigate.length);
  for (let i = 0; i < expectFirstNavigate.length; i++) {
    compareEntry(i, expectFirstNavigate[i], log1[i]);
  }

  const messagesDuringNav2 = [];
  const consoleListener = (msg) =>
    messagesDuringNav2.push({
      type: msg.type(),
      text: msg.text(),
    });
  page.on("console", consoleListener);

  await page.goto(SECOND_URL, { timeout: 15000 });

  const sentinelDeadline = Date.now() + 5000;
  while (
    messagesDuringNav2.filter((m) => m.text.startsWith("[lifecycle] ")).length < 3 &&
    Date.now() < sentinelDeadline
  ) {
    await new Promise((r) => setTimeout(r, 5));
  }
  page.off("console", consoleListener);

  const leakedLog = await page.evaluate(() => typeof globalThis.__ks_lifecycle_log);
  console.log("[lc] navigate-2 typeof __ks_lifecycle_log =", leakedLog);
  expect(leakedLog, "previous page's globalThis leaked").toBe("undefined");

  const newPageHasMarker = await page.evaluate(() => typeof globalThis.__ks_marker === "number");
  console.log("[lc] navigate-2 new page has __ks_marker =", newPageHasMarker);
  expect(newPageHasMarker, "second page didn't run its inline scripts").toBeTruthy();

  const sentinels = messagesDuringNav2
    .map((m) => m.text)
    .filter((t) => t.startsWith("[lifecycle] "));
  console.log("[lc] navigate-2 unload sentinels:", JSON.stringify(sentinels));

  const expectSentinels = [
    "[lifecycle] beforeunload fired",
    "[lifecycle] pagehide fired",
    "[lifecycle] unload fired",
  ];
  expect(sentinels, "navigate-2 unload sentinels").toStrictEqual(expectSentinels);
});
