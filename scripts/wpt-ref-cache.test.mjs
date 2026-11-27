// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { getCachedRefScreenshot, waitForImagesSettled } from "./wpt-ref-cache.mjs";

test("a never-ready reference is rendered separately by each waiter", async () => {
  const cache = new Map();
  let renders = 0;
  let releaseFirst;
  const firstCanFinish = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const render = async () => {
    const renderNumber = ++renders;
    if (renderNumber === 1) await firstCanFinish;
    return { png: `shot-${renderNumber}`, cacheable: false };
  };

  const first = getCachedRefScreenshot(cache, "ref", render);
  const second = getCachedRefScreenshot(cache, "ref", render);
  releaseFirst();

  assert.deepEqual(await Promise.all([first, second]), [
    { png: "shot-1", cached: false },
    { png: "shot-2", cached: false },
  ]);
  assert.equal(renders, 2);
  assert.equal(cache.size, 0);
});

test("a ready reference is shared with concurrent waiters", async () => {
  const cache = new Map();
  let renders = 0;
  let release;
  const canFinish = new Promise((resolve) => {
    release = resolve;
  });
  const render = async () => {
    renders++;
    await canFinish;
    return { png: "ready-shot", cacheable: true };
  };

  const first = getCachedRefScreenshot(cache, "ref", render);
  const second = getCachedRefScreenshot(cache, "ref", render);
  release();

  assert.deepEqual(await Promise.all([first, second]), [
    { png: "ready-shot", cached: false },
    { png: "ready-shot", cached: true },
  ]);
  assert.equal(renders, 1);
});

function pageReturning(values) {
  const seen = [];
  return {
    seen,
    async evaluate(expression) {
      seen.push(expression);
      const next = values.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test("images already loaded settle on the first read", async () => {
  const page = pageReturning([0]);
  assert.equal(await waitForImagesSettled(page, Date.now() + 1_000), true);
  assert.equal(page.seen.length, 1);
  assert.match(page.seen[0], /document\.images/);
});

test("a late image settles once the page reports none pending", async () => {
  const page = pageReturning([2, 1, 0]);
  assert.equal(await waitForImagesSettled(page, Date.now() + 1_000), true);
  assert.equal(page.seen.length, 3);
});

test("an image that never arrives gives up at the deadline", async () => {
  const page = pageReturning([1, 1, 1, 1]);
  let clock = 0;
  const now = () => (clock += 100);
  assert.equal(await waitForImagesSettled(page, 150, now, 0), false);
});

// The caller treats this as "do not cache": an unreadable page is no evidence that it painted.
test("a page that cannot be evaluated does not count as settled", async () => {
  const page = pageReturning([new Error("Execution context was destroyed")]);
  assert.equal(await waitForImagesSettled(page, Date.now() + 1_000), false);
});
