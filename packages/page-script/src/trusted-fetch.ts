// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Carries trusted fetch attribution in a WeakMap without exposing it to page code.

let trusted: typeof globalThis.fetch | null = null;

export function captureTrustedFetch(): void {
  const f = globalThis.fetch;
  if (typeof f === "function") trusted = f.bind(globalThis);
}

export interface TrustedRequestMeta {
  resourceType?: string;
  initiator?: string;
  /** Called before each redirect hop is requested: the URL to request, or null to refuse. */
  checkRedirect?: (url: string) => string | null;
}

const trustedMeta = new WeakMap<object, TrustedRequestMeta>();
const trustedMetaGet = WeakMap.prototype.get.bind(trustedMeta);
const trustedMetaSet = WeakMap.prototype.set.bind(trustedMeta);

export function takeTrustedRequestMeta(init: unknown): TrustedRequestMeta | undefined {
  if ((typeof init !== "object" || init === null) && typeof init !== "function") {
    return undefined;
  }
  return trustedMetaGet(init);
}

export function trustedFetch(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
  meta?: TrustedRequestMeta,
): Promise<Response> {
  const f = trusted ?? globalThis.fetch;
  if (!meta || trusted === null) return f(input, init);
  // SAFETY: A page-owned Object.prototype getter could capture the trusted metadata key.
  const withMeta = { __proto__: null, ...(init ?? {}) };
  trustedMetaSet(withMeta, meta);
  return f(input, withMeta as typeof init);
}
