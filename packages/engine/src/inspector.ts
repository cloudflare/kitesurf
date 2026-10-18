// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Reads the optional hosted inspector URL used by DevTools discovery routes.

/** Return the hosted inspector URL; unset, empty or non-string disables the web shortcut. */
export function inspectorBaseUrlOrNull(env: {
  KITESURF_INSPECTOR_BASE_URL?: unknown;
}): string | null {
  const raw = env.KITESURF_INSPECTOR_BASE_URL;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}
