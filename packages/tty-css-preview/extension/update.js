// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

/** @returns {Promise<string>} */
export async function loadCssWithFallback(level, loadLiveCss, loadFallbackCss) {
  try {
    return await loadLiveCss(level);
  } catch (liveError) {
    try {
      return await loadFallbackCss(level);
    } catch (fallbackError) {
      throw new AggregateError(
        [liveError, fallbackError],
        "Live and bundled CSS both failed to load",
      );
    }
  }
}

/**
 * @returns {Promise<{
 *   status: "error" | "offline" | "current" | "off" | "updated",
 *   appliedCss: string | null,
 *   appliedLevel: number,
 *   message?: string
 * }>}
 */
export async function updateCss(options) {
  let appliedCss = options.appliedCss;
  let appliedLevel = options.appliedLevel;

  const result = (status, message) => ({
    status,
    appliedCss,
    appliedLevel,
    ...(message ? { message } : {}),
  });

  if (options.level === 0) {
    if (appliedCss !== null) {
      try {
        await options.removeCss(appliedCss);
      } catch (error) {
        return result("error", String(error));
      }
    }

    appliedCss = null;
    appliedLevel = 0;
    return result("off");
  }

  let css;
  try {
    css = await options.loadCss(options.level);
  } catch (error) {
    return result("offline", String(error));
  }

  if (appliedCss === css && appliedLevel === options.level) {
    return result("current");
  }

  if (appliedCss !== null) {
    try {
      await options.removeCss(appliedCss);
    } catch (error) {
      return result("error", String(error));
    }
    appliedCss = null;
    appliedLevel = 0;
  }

  try {
    await options.insertCss(css);
  } catch (error) {
    return result("error", String(error));
  }

  appliedCss = css;
  appliedLevel = options.level;
  return result("updated");
}
