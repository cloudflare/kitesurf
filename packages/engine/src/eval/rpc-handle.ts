// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

export function disposeRpcHandle(handle: object | null | undefined): void {
  if (!handle) return;
  if (!(Symbol.dispose in handle)) return;
  const dispose = handle[Symbol.dispose];
  if (typeof dispose !== "function") return;
  try {
    dispose.call(handle);
  } catch {}
}
