// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Routes one-shot isolate-limit notices to handlers registered by script name. `crashed` means the
// page's wasm trapped, which poisons the module, so the engine ended the generation.

export type IsolateLimitKind = "cpu" | "memory" | "wall" | "gone" | "crashed";

export interface IsolateLimitNotice {
  kind: IsolateLimitKind;
  capMs: number;
  fromTail: boolean;
  /** For `crashed`, the trap's message. */
  detail?: string;
}

// A loaded worker evicted under load fails its in-flight calls with the limit error and later ones
// with the destroyed-context error. Either way its isolate is gone.
const ISOLATE_GONE = /execution context which hosts this|Too many dynamic workers/i;

export function isIsolateGoneError(message: string): boolean {
  return ISOLATE_GONE.test(message);
}

type Listener = (notice: IsolateLimitNotice) => void;

export interface IsolateLimitListenerOptions {
  /** Connection that owns the listener, swept when it closes. */
  owner?: string;
  /** False once the listener's generation has retired. */
  isLive?: () => boolean;
}

interface Entry extends IsolateLimitListenerOptions {
  cb: Listener;
}

const listeners = new Map<string, Entry>();
const MAX_LISTENERS = 64;

function isRetired(entry: Entry): boolean {
  try {
    return entry.isLive?.() === false;
  } catch {
    return true;
  }
}

// Every connection served by the isolate shares this map, so overflow drops
// retired generations first and evicts a live listener only when all are live.
function makeRoom(): void {
  for (const [name, entry] of listeners) {
    if (isRetired(entry)) listeners.delete(name);
  }
  if (listeners.size < MAX_LISTENERS) return;
  const oldest = listeners.keys().next().value;
  if (oldest !== undefined) listeners.delete(oldest);
}

export function registerIsolateLimitListener(
  scriptName: string,
  cb: Listener,
  options: IsolateLimitListenerOptions = {},
): void {
  if (!listeners.has(scriptName) && listeners.size >= MAX_LISTENERS) makeRoom();
  listeners.set(scriptName, { cb, ...options });
}

export function unregisterIsolateLimitListener(scriptName: string): void {
  listeners.delete(scriptName);
}

export function unregisterIsolateLimitListenersFor(owner: string): void {
  for (const [name, entry] of listeners) {
    if (entry.owner === owner) listeners.delete(name);
  }
}

export function notifyIsolateLimit(scriptName: string, notice: IsolateLimitNotice): void {
  const entry = listeners.get(scriptName);
  if (!entry) return;
  listeners.delete(scriptName);
  try {
    entry.cb(notice);
  } catch {}
}
