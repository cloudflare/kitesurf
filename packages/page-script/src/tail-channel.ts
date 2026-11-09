// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Token-bearing lines for the parent's tail consumer. The tail accepts only lines
// with the engine-minted token; it stays in module scope, away from page JS.

let tailToken = "";

// Bound before index.ts installs the page-visible console wrapper, which page
// JS can overwrite, so token-bearing lines never pass through page code.
const nativeLog: (...a: unknown[]) => void =
  typeof console?.log === "function" ? console.log.bind(console) : () => {};
const nativeError: (...a: unknown[]) => void =
  typeof console?.error === "function" ? console.error.bind(console) : nativeLog;

export function setTailToken(token: unknown): void {
  if (typeof token === "string" && token) tailToken = token;
}

/** Writes the authenticated kill line; a no-op before a session sets the token. */
export function writeIsolateKillLine(marker: string, reason: string): void {
  if (tailToken) nativeLog(`${marker} ${tailToken} ${reason}`);
}

/** Writes a `[ks-err]` report carrying the token ahead of `fields`. */
export function writeEngineErrorLine(fields: Record<string, unknown>): void {
  nativeError("[ks-err] " + JSON.stringify({ token: tailToken, ...fields }));
}
