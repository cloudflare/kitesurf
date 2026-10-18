// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

/** @returns {Promise<{png: import("node:buffer").Buffer, cached: boolean}>} */
export async function getCachedRefScreenshot(cache, key, render) {
  const cached = cache.get(key);
  if (cached) {
    try {
      const result = await cached;
      if (result.cacheable) return { png: result.png, cached: true };
    } catch {}
  }

  // Share a pending render, but evict unsettled frames instead of reusing them.
  const pending = render();
  cache.set(key, pending);
  try {
    const result = await pending;
    if (!result.cacheable && cache.get(key) === pending) cache.delete(key);
    return { png: result.png, cached: false };
  } catch (err) {
    if (cache.get(key) === pending) cache.delete(key);
    throw err;
  }
}
