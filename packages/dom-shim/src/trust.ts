// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Stores shim event-trust flags in a WeakMap outside page-visible event properties.

export const __ks_trustedFlags = new WeakMap<object, boolean>();

function isWeakKey(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/** Sets trust only for shim-created events; dispatch code must validate the target first. */
export function __ks_setEventTrusted(event: object, trusted: boolean): void {
  if (!__ks_trustedFlags.has(event)) {
    throw new TypeError("Illegal invocation");
  }
  __ks_trustedFlags.set(event, trusted);
}

export function __ks_isTrustedGetter(this: unknown): boolean {
  if (!isWeakKey(this) || !__ks_trustedFlags.has(this)) {
    throw new TypeError("Illegal invocation");
  }
  return __ks_trustedFlags.get(this) === true;
}

Object.defineProperty(__ks_isTrustedGetter, "name", {
  value: "get isTrusted",
  writable: false,
  enumerable: false,
  configurable: true,
});
