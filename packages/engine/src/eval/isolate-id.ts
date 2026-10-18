// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Tags requests with the engine isolate ID so loopback hops can detect a different isolate.

let id: string | null = null;

export function engineIsolateId(): string {
  id ??= crypto.randomUUID();
  return id;
}

export function isForeignIsolate(stamped: string | undefined): boolean {
  return stamped !== undefined && stamped !== "" && stamped !== engineIsolateId();
}
