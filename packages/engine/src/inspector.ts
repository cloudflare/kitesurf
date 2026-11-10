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

/**
 * Resolve a path-only base (`/inspector/inspector.html`, a same-origin frontend copy) against
 * `origin`. Any other value is returned unchanged.
 */
export function absoluteInspectorBaseUrl(base: string, origin: string): string {
  return base.startsWith("/") ? new URL(base, origin).href : base;
}

/** The frontend URL attached to this engine's page target, for the request that asked for it. */
export function inspectorTargetUrl(
  base: string,
  request: { url: URL; host: string; initialUrl?: string },
): string {
  const { url, host, initialUrl } = request;
  const initialQuery =
    initialUrl === undefined ? "" : "?initialUrl=" + encodeURIComponent(initialUrl);
  const params = new URLSearchParams();
  const wsScheme = url.protocol === "https:" ? "wss" : "ws";
  params.set(wsScheme, `${host}/devtools/page/kitesurf${initialQuery}`);
  // Response.redirect needs an absolute URL; a same-origin frontend shares the WebSocket's host.
  const frontend = absoluteInspectorBaseUrl(base, `${url.protocol}//${host}`);
  return frontend.replace(/\/$/, "") + "?" + params.toString();
}
