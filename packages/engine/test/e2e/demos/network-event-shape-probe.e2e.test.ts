// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

function logEventOrder(ordered: string[]): void {
  console.log("[probe] event order (" + ordered.length + " events):");
  for (let i = 0; i < ordered.length; i++) {
    console.log("  " + i + ". " + ordered[i]);
  }
}

function eventOrderIsValid(firstIndex: number, secondIndex: number, allowSame = false): boolean {
  return (
    firstIndex >= 0 &&
    secondIndex >= 0 &&
    (allowSame ? firstIndex <= secondIndex : firstIndex < secondIndex)
  );
}

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
  logEventOrder(ordered);

  const isDocumentResponse = (event) => (event.params && event.params.type) === "Document";
  const hasRequestId = (event) => event.params && event.params.requestId;
  const checkDocumentResponseIds = (documentResponses) => {
    for (const event of documentResponses) {
      const params = event.params || {};
      expect(
        !!(params.requestId && params.frameId && params.loaderId),
        "document responseReceived has requestId + frameId + loaderId",
      ).toBeTruthy();
    }
  };
  const checkSubresourceRequestIds = (subresources) => {
    if (subresources.length > 0) {
      const subOk = subresources.filter(hasRequestId).length;
      expect(subOk, "all subresource responseReceived events have requestId").toBe(
        subresources.length,
      );
    }
  };

  const responseReceiveds = events.filter((e) => e.method === "Network.responseReceived");
  expect(responseReceiveds.length, "captured Network.responseReceived events").toBeGreaterThan(0);

  const documentResponses = responseReceiveds.filter(isDocumentResponse);
  expect(documentResponses.length, "captured a Document-type responseReceived").toBeGreaterThan(0);
  checkDocumentResponseIds(documentResponses);
  const subresources = responseReceiveds.filter((event) => !isDocumentResponse(event));
  checkSubresourceRequestIds(subresources);

  const indexOf = (m) => ordered.indexOf(m);
  const indexOfLast = (m) => ordered.lastIndexOf(m);

  const startedLoading = indexOf("Page.frameStartedLoading");
  const firstReqWillBeSent = indexOf("Network.requestWillBeSent");
  const firstFrameNavigated = indexOf("Page.frameNavigated");
  const firstResponseReceived = indexOf("Network.responseReceived");
  const lastLoadEvent = indexOfLast("Page.loadEventFired");
  const lastFrameStopped = indexOfLast("Page.frameStoppedLoading");

  expect(
    eventOrderIsValid(startedLoading, firstReqWillBeSent),
    "frameStartedLoading fires BEFORE requestWillBeSent",
  ).toBeTruthy();

  expect(
    eventOrderIsValid(firstResponseReceived, firstFrameNavigated),
    "responseReceived fires BEFORE frameNavigated",
  ).toBeTruthy();

  expect(
    eventOrderIsValid(firstFrameNavigated, lastLoadEvent),
    "frameNavigated fires BEFORE loadEventFired",
  ).toBeTruthy();

  expect(
    eventOrderIsValid(lastLoadEvent, lastFrameStopped, true),
    "loadEventFired ≤ frameStoppedLoading",
  ).toBeTruthy();
});
