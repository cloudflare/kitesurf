// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("network-event-shape-probe", async ({ page }) => {
  const URL_TO_NAV =
    process.env.KITESURF_FIXTURE ?? "http://127.0.0.1:8787/__fixtures/lifecycle.html";

  const session = await page.target().createCDPSession();

  await session.send("Network.enable");
  await session.send("Page.enable");

  const events = [];
  const interesting = new Set([
    "Network.requestWillBeSent",
    "Network.responseReceived",
    "Network.dataReceived",
    "Network.loadingFinished",
    "Network.loadingFailed",
    "Page.frameStartedLoading",
    "Page.frameNavigated",
    "Page.frameStoppedLoading",
    "Page.domContentEventFired",
    "Page.loadEventFired",
  ]);
  for (const m of interesting) {
    session.on(m, (params) => events.push({ method: m, params }));
  }

  await session.send("Page.navigate", { url: URL_TO_NAV }).catch((e) => {
    console.log("[probe] Page.navigate warning:", e && e.message);
  });

  try {
    await expect
      .poll(() => events.some((event) => event.method === "Page.frameStoppedLoading"), {
        timeout: 10_000,
      })
      .toBe(true);
  } catch {}

  const ordered = events.map((e) => e.method);
  console.log("[probe] event order (" + ordered.length + " events):");
  for (let i = 0; i < ordered.length; i++) {
    console.log("  " + i + ". " + ordered[i]);
  }

  const responseReceiveds = events.filter((e) => e.method === "Network.responseReceived");
  expect(responseReceiveds.length, "captured Network.responseReceived events").toBeGreaterThan(0);

  const documentResponses = responseReceiveds.filter(
    (e) => (e.params && e.params.type) === "Document",
  );
  expect(documentResponses.length, "captured a Document-type responseReceived").toBeGreaterThan(0);
  for (const ev of documentResponses) {
    const p = ev.params || {};
    expect(
      !!(p.requestId && p.frameId && p.loaderId),
      "document responseReceived has requestId + frameId + loaderId",
    ).toBeTruthy();
  }
  const subresources = responseReceiveds.filter((e) => (e.params && e.params.type) !== "Document");
  if (subresources.length > 0) {
    let subOk = 0;
    for (const ev of subresources) {
      if (ev.params && ev.params.requestId) subOk++;
    }
    expect(subOk, "all subresource responseReceived events have requestId").toBe(
      subresources.length,
    );
  }

  const indexOf = (m) => ordered.indexOf(m);
  const indexOfLast = (m) => ordered.lastIndexOf(m);

  const startedLoading = indexOf("Page.frameStartedLoading");
  const firstReqWillBeSent = indexOf("Network.requestWillBeSent");
  const firstFrameNavigated = indexOf("Page.frameNavigated");
  const firstResponseReceived = indexOf("Network.responseReceived");
  const lastLoadEvent = indexOfLast("Page.loadEventFired");
  const lastFrameStopped = indexOfLast("Page.frameStoppedLoading");

  expect(
    startedLoading >= 0 && firstReqWillBeSent >= 0 && startedLoading < firstReqWillBeSent,
    "frameStartedLoading fires BEFORE requestWillBeSent",
  ).toBeTruthy();

  expect(
    firstResponseReceived >= 0 &&
      firstFrameNavigated >= 0 &&
      firstResponseReceived < firstFrameNavigated,
    "responseReceived fires BEFORE frameNavigated",
  ).toBeTruthy();

  expect(
    firstFrameNavigated >= 0 && lastLoadEvent >= 0 && firstFrameNavigated < lastLoadEvent,
    "frameNavigated fires BEFORE loadEventFired",
  ).toBeTruthy();

  expect(
    lastLoadEvent >= 0 && lastFrameStopped >= 0 && lastLoadEvent <= lastFrameStopped,
    "loadEventFired ≤ frameStoppedLoading",
  ).toBeTruthy();
});
