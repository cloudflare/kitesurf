// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Report handled engine failures to the parent's [ks-err] tail consumer so
// an embedder's error reporter still receives wasm panics and shim invariant
// failures. Page-author exceptions use exception-buffer and CDP
// Runtime.exceptionThrown instead.
export type EngineErrorOrigin = "wasm" | "shim" | "runtime";

import { state } from "./state.ts";

let tailToken = "";

// The tail accepts only lines with the engine-minted token. Keep it in module
// scope, away from page JS; it leaves only inside [ks-err] reports.

export function setTailToken(token: unknown): void {
  if (typeof token === "string" && token) tailToken = token;
}

/** Returns the authenticated kill line, or null before a session sets the token. */
export function isolateKillLine(marker: string, reason: string): string | null {
  return tailToken ? `${marker} ${tailToken} ${reason}` : null;
}

export function reportEngineError(origin: EngineErrorOrigin, err: unknown, note?: string): void {
  try {
    const MAX_ENGINE_ERROR_STACK_CHARS = 4096;
    const MAX_ENGINE_ERROR_MESSAGE_CHARS = 512;
    const error = err as { name?: unknown; message?: unknown; stack?: unknown } | null;
    const name = error && typeof error.name === "string" && error.name ? error.name : "Error";
    let message = error && typeof error.message === "string" ? error.message : String(err);
    if (note) message = note + ": " + message;
    const stack =
      error && typeof error.stack === "string"
        ? error.stack.slice(0, MAX_ENGINE_ERROR_STACK_CHARS)
        : undefined;
    console.error(
      "[ks-err] " +
        JSON.stringify({
          token: tailToken,
          origin,
          name,
          message: message.slice(0, MAX_ENGINE_ERROR_MESSAGE_CHARS),
          stack,
          pageUrl: state.pageUrl,
        }),
    );
  } catch {}
}
