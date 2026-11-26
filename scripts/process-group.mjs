// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Stops the process groups of the runners' detached children, SIGTERM first: wrangler and
// Miniflare delete their temporary directories (a ~40 MB `.wrangler/tmp/dev-*` bundle per
// `wrangler dev`) only in exit hooks, which SIGKILL skips.

import { setTimeout as sleep } from "node:timers/promises";

export const STOP_GRACE_MS = 5_000;
const STOP_POLL_INTERVAL_MS = 50;

/** Whether group `pgid` has a live member. A group left with only an unreaped zombie reads as
 * gone on macOS (EPERM) and as live on Linux until Node reaps it, which polling allows.
 * @param {number} pgid @returns {boolean} */
export function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Sends SIGTERM to group `pgid` before the first await, so a caller that cannot wait (an exit
 * handler) still lets the group clean up. SIGKILLs the group if it outlives `graceMs`.
 * @param {number | undefined} pgid @param {number} [graceMs]
 * @returns {Promise<boolean>} false when the group needed SIGKILL */
export async function stopProcessGroup(pgid, graceMs = STOP_GRACE_MS) {
  if (!Number.isInteger(pgid) || pgid <= 1) return true;
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    return true;
  }
  const deadline = Date.now() + graceMs;
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {}
      return false;
    }
    await sleep(STOP_POLL_INTERVAL_MS);
  }
  return true;
}
