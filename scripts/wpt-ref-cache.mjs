// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

/**
 * @param {Promise<{png: import("node:buffer").Buffer, cacheable: boolean}>} cached
 * @returns {Promise<{png: import("node:buffer").Buffer, cached: boolean} | null>}
 */
async function resolveCachedScreenshot(cached) {
  try {
    const result = await cached;
    return result.cacheable ? { png: result.png, cached: true } : null;
  } catch {}
  return null;
}

function evictPending(cache, key, pending) {
  if (cache.get(key) === pending) cache.delete(key);
}

/** @returns {Promise<{png: import("node:buffer").Buffer, cached: boolean}>} */
export async function getCachedRefScreenshot(cache, key, render) {
  const existing = cache.get(key);
  if (existing) {
    const cached = await resolveCachedScreenshot(existing);
    if (cached) return cached;
  }

  // Share a pending render, but evict unsettled frames instead of reusing them.
  const pending = render();
  cache.set(key, pending);
  try {
    const result = await pending;
    if (!result.cacheable) evictPending(cache, key, pending);
    return { png: result.png, cached: false };
  } catch (err) {
    evictPending(cache, key, pending);
    throw err;
  }
}
