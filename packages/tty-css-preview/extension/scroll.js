// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

(function installTtyCssScroll(root) {
  function consumeDelta(delta, cellPx) {
    if (!Number.isFinite(delta) || delta === 0) return { movement: 0, remainder: 0 };
    const cell = Math.max(1, Number.isFinite(cellPx) ? cellPx : 1);
    const movement = Math.trunc(delta / cell) * cell;
    return { movement, remainder: delta - movement };
  }

  function deltaPixels(delta, deltaMode, cellPx, pagePx) {
    if (deltaMode === 1) return delta * cellPx;
    if (deltaMode === 2) return delta * pagePx;
    return delta;
  }

  function canMove(position, minimum, maximum, delta) {
    return delta < 0 ? position > minimum : position < maximum;
  }

  function limitToWholeCells(delta, available, cellPx) {
    const cell = Math.max(1, Number.isFinite(cellPx) ? cellPx : 1);
    const distance = Math.min(Math.abs(delta), Math.max(0, available));
    return Math.sign(delta) * Math.floor(distance / cell) * cell;
  }

  root.ttyCssScroll = Object.freeze({
    canMove,
    consumeDelta,
    deltaPixels,
    limitToWholeCells,
  });
})(globalThis);
