// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Routes one-shot isolate-limit notices to handlers registered by script name.

export type IsolateLimitKind = "cpu" | "memory" | "wall" | "gone";

export interface IsolateLimitNotice {
  kind: IsolateLimitKind;
  capMs: number;
  fromTail: boolean;
}

type Listener = (notice: IsolateLimitNotice) => void;

const listeners = new Map<string, Listener>();
const MAX_LISTENERS = 64;

export function registerIsolateLimitListener(scriptName: string, cb: Listener): void {
  if (!listeners.has(scriptName) && listeners.size >= MAX_LISTENERS) {
    const oldest = listeners.keys().next().value;
    if (oldest !== undefined) listeners.delete(oldest);
  }
  listeners.set(scriptName, cb);
}

export function unregisterIsolateLimitListener(scriptName: string): void {
  listeners.delete(scriptName);
}

export function notifyIsolateLimit(scriptName: string, notice: IsolateLimitNotice): void {
  const cb = listeners.get(scriptName);
  if (!cb) return;
  listeners.delete(scriptName);
  try {
    cb(notice);
  } catch {}
}
