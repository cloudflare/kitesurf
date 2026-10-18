// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

import { readEngineMemory, readFixtureProgress } from "./cdp-read";

const MAX_RETAINED_BODY_BYTES = 12 * 1024 * 1024;

test("engine memory accounting is exposed and the body cache stays bounded", async ({
  page,
  cdpSession,
}) => {
  const before = await readEngineMemory(cdpSession);
  expect(before.retainedBodyBytes).toBe(0);

  await page.goto("http://localhost:8787/__fixtures/chatty-xhr.html?n=400&bytes=200000&conc=8", {
    waitUntil: "load",
    timeout: 120000,
  });

  await page.waitForFunction("!!window.__done", { timeout: 120000 }).catch(() => {});
  const state = await readFixtureProgress(page, "__fetched");
  if (!state.done) {
    throw new Error(`chatty-xhr did not finish: fetched=${state.count}`);
  }
  const fetched = state.count;
  expect(fetched, "fixture must actually have issued fetches").toBeGreaterThan(100);

  const after = await readEngineMemory(cdpSession);

  expect(after.retainedBodyBytesIsolate).toBeLessThanOrEqual(MAX_RETAINED_BODY_BYTES);
  expect(after.retainedBodyBytes).toBeGreaterThan(0);
  expect(after.retainedRequestCount).toBeGreaterThan(after.retainedBodyBytes / (2 * 200000));
  expect(after.wasmBytes).toBeGreaterThan(0);

  expect(after.retainedBodyBytesIsolate).toBeGreaterThanOrEqual(after.retainedBodyBytes);
  expect(after.accountedBytes).toBe(
    after.wasmBytes + after.retainedBodyBytesIsolate + after.fontAssetCacheBytes,
  );
  expect(after.fontAssetCacheBytes).toBeGreaterThan(0);
  expect(after.fontAssetCacheBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
});
