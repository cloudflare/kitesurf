// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Tags synchronous operations and reports long PageScript event-loop stalls.

let ops: Map<string, number> | null = null;
let installed = false;

const nativeLog: (...a: unknown[]) => void =
  typeof console?.log === "function" ? console.log.bind(console) : () => {};
const nativeWarn: (...a: unknown[]) => void =
  typeof console?.warn === "function" ? console.warn.bind(console) : nativeLog;

export function noteSyncOp(tag: string): void {
  if (!ops) return;
  ops.set(tag, (ops.get(tag) ?? 0) + 1);
}

const TICK_MS = 500;
const WARN_LAG_MS = 2_000;
const HEARTBEAT_TICKS = 60;

export function installLagWatchdog(): void {
  if (installed) return;
  installed = true;
  ops = new Map();
  let last = Date.now();
  let ticks = 0;
  let maxLag = 0;
  nativeLog(`[ks-lag] watchdog installed at ${Date.now()}`);
  setInterval(() => {
    const opsMap = ops;
    if (!opsMap) return;
    const now = Date.now();
    const lag = now - last - TICK_MS;
    last = now;
    ticks++;
    if (lag > maxLag) maxLag = lag;
    if (lag > WARN_LAG_MS) {
      const parts: string[] = [];
      for (const [tag, n] of opsMap) {
        parts.push(n > 1 ? `${tag}x${n}` : tag);
      }
      nativeWarn(
        `[ks-lag] event loop stalled ~${lag}ms; ops since last tick: ` +
          (parts.join(", ") || "(none recorded)"),
      );
    }
    if (ticks % HEARTBEAT_TICKS === 0) {
      nativeLog(`[ks-lag] alive ticks=${ticks} clock=${now} maxLagSinceLast=${maxLag}ms`);
      maxLag = 0;
    }
    opsMap.clear();
  }, TICK_MS);
}
