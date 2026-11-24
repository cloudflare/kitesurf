// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Lets a loaded document's requests read its target's extra headers when they leave, not when
// the document loaded, so Network.setExtraHTTPHeaders and a user agent override apply at once.

const registry = new Map<string, Map<string, () => Record<string, string>>>();

export function registerExtraHeaders(
  connectionId: string,
  targetId: string,
  read: () => Record<string, string>,
): void {
  let targets = registry.get(connectionId);
  if (!targets) {
    targets = new Map();
    registry.set(connectionId, targets);
  }
  targets.set(targetId, read);
}

export function unregisterExtraHeaders(connectionId: string, targetId: string): void {
  const targets = registry.get(connectionId);
  if (!targets) return;
  targets.delete(targetId);
  if (targets.size === 0) registry.delete(connectionId);
}

export function unregisterConnectionExtraHeaders(connectionId: string): void {
  registry.delete(connectionId);
}

/** The target's extra headers now, or undefined when this isolate does not hold the target. */
export function liveExtraHeaders(
  connectionId: string,
  targetId: string | undefined,
): Record<string, string> | undefined {
  if (!targetId) return undefined;
  return registry.get(connectionId)?.get(targetId)?.();
}
