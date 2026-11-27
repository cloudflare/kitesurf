// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Records the page isolates the engine asked to kill. abortIsolate() fails every call still in
// flight, and only the kill call itself carries the authenticated kill line, so the tail checks
// here before it reports another call's abort error as a page failure.

const killed = new Map<string, number>();
const MAX_ENTRIES = 256;
// Tails arrive once the aborted calls end, seconds after the kill at most.
const KILL_MEMORY_MS = 60_000;

export function noteIsolateKillRequested(scriptName: string, now = Date.now()): void {
  for (const [name, at] of killed) {
    if (now - at > KILL_MEMORY_MS) killed.delete(name);
  }
  if (!killed.has(scriptName) && killed.size >= MAX_ENTRIES) {
    const oldest = killed.keys().next().value;
    if (oldest !== undefined) killed.delete(oldest);
  }
  killed.set(scriptName, now);
}

export function wasIsolateKillRequested(scriptName: string, now = Date.now()): boolean {
  const at = killed.get(scriptName);
  return at !== undefined && now - at <= KILL_MEMORY_MS;
}
