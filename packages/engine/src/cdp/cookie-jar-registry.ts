// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Maps connection and browser-context keys to their session-owned cookie jars.

import type { CookieJar } from "../cookies.ts";

const registry = new Map<string, CookieJar>();

export function cookieKeyFor(connectionId: string, browserContextId?: string): string {
  return browserContextId ? `${connectionId}::${browserContextId}` : connectionId;
}

export function registerCookieJar(key: string, jar: CookieJar): void {
  registry.set(key, jar);
}

export function unregisterCookieJar(key: string): void {
  registry.delete(key);
}

export function unregisterConnectionCookieJars(
  connectionId: string,
  contextIds: Iterable<string>,
): void {
  registry.delete(connectionId);
  for (const ctxId of contextIds) {
    registry.delete(cookieKeyFor(connectionId, ctxId));
  }
}

export function getCookieJar(key: string): CookieJar | undefined {
  return registry.get(key);
}

export function __cookieJarRegistrySize(): number {
  return registry.size;
}

export function __hasCookieJar(key: string): boolean {
  return registry.has(key);
}
