// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

(function installTtyCssSnap(root) {
  function nearestCell(value, cellPx) {
    if (!Number.isFinite(value) || value === 0) return value;
    const cell = Math.max(1, Number.isFinite(cellPx) ? cellPx : 1);
    return Math.round(value / cell) * cell;
  }

  function nearestCssPixel(value, cellPx) {
    const match = /^(-?(?:\d+\.?\d*|\.\d+))px$/.exec(value.trim());
    if (!match) return null;
    const snapped = nearestCell(Number(match[1]), cellPx);
    return Object.is(snapped, -0) ? 0 : snapped;
  }

  function nearestContentInset(paddingValue, borderValue, cellPx) {
    const padding = nearestCssPixel(paddingValue, 1);
    const border = nearestCssPixel(borderValue, 1);
    if (padding === null || border === null) return null;
    return Math.max(0, nearestCell(padding + border, cellPx) - border);
  }

  root.ttyCssSnap = Object.freeze({ nearestCell, nearestCssPixel, nearestContentInset });
})(globalThis);
