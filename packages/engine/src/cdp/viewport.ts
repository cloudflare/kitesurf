// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Clamps viewport dimensions to the engine's side and pixel limits.

export const DEFAULT_VIEWPORT_WIDTH = 1280;
export const DEFAULT_VIEWPORT_HEIGHT = 720;
export const MAX_SIDE = 2560;
export const MAX_PIXELS = 2560 * 1440;
export const MIN_DIM = 16;

export function clampSide(n: number): number {
  if (!Number.isFinite(n)) return MIN_DIM;
  return Math.max(MIN_DIM, Math.min(MAX_SIDE, Math.floor(n)));
}

export function clampViewport(w: number, h: number): { width: number; height: number } {
  let width = clampSide(w);
  let height = clampSide(h);
  const px = width * height;
  if (px > MAX_PIXELS) {
    const scale = Math.sqrt(MAX_PIXELS / px);
    width = Math.max(MIN_DIM, Math.floor(width * scale));
    height = Math.max(MIN_DIM, Math.floor(height * scale));
  }
  return { width, height };
}
