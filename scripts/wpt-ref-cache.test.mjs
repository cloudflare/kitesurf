// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { getCachedRefScreenshot } from "./wpt-ref-cache.mjs";

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
