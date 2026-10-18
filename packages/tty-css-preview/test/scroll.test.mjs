// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

await import("../extension/scroll.js");

const { canMove, consumeDelta, deltaPixels, limitToWholeCells } = globalThis.ttyCssScroll;

test("consumes only complete horizontal and vertical cells", () => {
  assert.deepEqual(consumeDelta(79, 8), { movement: 72, remainder: 7 });
  assert.deepEqual(consumeDelta(79, 17), { movement: 68, remainder: 11 });
  assert.deepEqual(consumeDelta(-79, 17), { movement: -68, remainder: -11 });
});

test("retains sub-cell trackpad movement for the next batch", () => {
  assert.deepEqual(consumeDelta(0.25, 8), { movement: 0, remainder: 0.25 });
  assert.deepEqual(consumeDelta(-0.25, 17), { movement: -0, remainder: -0.25 });
  assert.deepEqual(consumeDelta(0, 17), { movement: 0, remainder: 0 });
});

test("normalizes line and page wheel modes before quantizing", () => {
  assert.equal(deltaPixels(3, 1, 17, 600), 51);
  assert.equal(deltaPixels(1, 2, 17, 600), 600);
  assert.equal(deltaPixels(42, 0, 17, 600), 42);
});

test("checks positive and negative scroll ranges", () => {
  assert.equal(canMove(0, 0, 100, 1), true);
  assert.equal(canMove(100, 0, 100, 1), false);
  assert.equal(canMove(0, -100, 0, -1), true);
  assert.equal(canMove(-100, -100, 0, -1), false);
});

test("does not clamp a wheel step to a partial cell at an edge", () => {
  assert.equal(limitToWholeCells(80, 100, 17), 68);
  assert.equal(limitToWholeCells(80, 10, 17), 0);
  assert.equal(limitToWholeCells(-80, 50, 8), -48);
});
