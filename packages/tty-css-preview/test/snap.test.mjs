// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

await import("../extension/snap.js");

const { nearestCell, nearestCssPixel, nearestContentInset } = globalThis.ttyCssSnap;

test("rounds media dimensions to the nearest terminal cell", () => {
  assert.equal(nearestCell(172, 8), 176);
  assert.equal(nearestCell(114, 17), 119);
  assert.equal(nearestCell(168, 8), 168);
});

test("does not enlarge media smaller than half a cell", () => {
  assert.equal(nearestCell(3, 8), 0);
  assert.equal(nearestCell(0, 17), 0);
});

test("quantizes pixel insets on their row or column axis", () => {
  assert.equal(nearestCssPixel("4px", 17), 0);
  assert.equal(nearestCssPixel("2px", 8), 0);
  assert.equal(nearestCssPixel("6.667px", 8), 8);
  assert.equal(nearestCssPixel("-6px", 8), -8);
});

test("leaves non-pixel and automatic insets to the browser", () => {
  assert.equal(nearestCssPixel("auto", 8), null);
  assert.equal(nearestCssPixel("normal", 17), null);
  assert.equal(nearestCssPixel("2ch", 8), null);
});

test("snaps border and padding as one content inset", () => {
  assert.equal(nearestContentInset("6.667px", "1px", 8), 7);
  assert.equal(nearestContentInset("15px", "2px", 17), 15);
  assert.equal(nearestContentInset("0px", "1px", 17), 0);
});
