// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const PAGE_URL = "https://ks.invalid/__fixtures/lifecycle.html";
const STREAM_URL = "https://ks.invalid/__fixtures/endless-text-stream";

test("a page fetch of an endless text stream resolves on headers", async ({ page, cdpSession }) => {
  await cdpSession.send("Network.enable");
  await page.goto(PAGE_URL, { waitUntil: "load", timeout: 60_000 });

  const first = await page.evaluate(async (url: string) => {
    const abortAfterMs = 5_000;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), abortAfterMs);
    try {
      const response = await fetch(url, { signal: abort.signal });
      const reader = response.body!.getReader();
      const { value } = await reader.read();
      await reader.cancel();
      return { status: response.status, first: new TextDecoder().decode(value) };
    } finally {
      clearTimeout(timeout);
    }
  }, STREAM_URL);

  expect(first).toEqual({ status: 200, first: "tick\n" });
}, 60_000);

test("navigating away from an endless text stream reports an aborted load", async ({
  page,
  cdpSession,
}) => {
  await cdpSession.send("Network.enable");
  let streamRequestId = "";
  const failures: string[] = [];
  cdpSession.on("Network.requestWillBeSent", (e) => {
    if (e.request.url === STREAM_URL) streamRequestId = e.requestId;
  });
  cdpSession.on("Network.loadingFailed", (e) => {
    if (e.requestId === streamRequestId) failures.push(e.errorText);
  });

  await page.goto(PAGE_URL, { waitUntil: "load", timeout: 60_000 });
  await page.evaluate((url: string) => {
    void (async () => {
      const response = await fetch(url);
      const { value } = await response.body!.getReader().read();
      (globalThis as { __streamFirst?: string }).__streamFirst = new TextDecoder().decode(value);
    })();
  }, STREAM_URL);
  await page.waitForFunction(
    () => (globalThis as { __streamFirst?: string }).__streamFirst === "tick\n",
    { timeout: 10_000 },
  );

  await page.goto("about:blank", { waitUntil: "load", timeout: 60_000 });

  await expect.poll(() => failures, { timeout: 10_000 }).toContain("net::ERR_ABORTED");
}, 60_000);
