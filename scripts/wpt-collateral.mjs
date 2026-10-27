// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

const COLLATERAL_OUTCOMES = new Set(["CRASH", "TIMEOUT", "ERROR"]);

/** @typedef {{
 * test: string, actual: string, unexpected: boolean,
 * killedEngine?: boolean
 * }} ResultRow */

/** @template {ResultRow} T
 * @param {{results: T[], sawDeath: boolean, lastPass: boolean, retriedKillers: Set<string>}} args
 * @returns {{accept: T[], requeue: T[]}} */
export function planRowDisposition({ results, sawDeath, lastPass, retriedKillers }) {
  const accept = [];
  const requeue = [];
  for (const r of results) {
    // Engine loss can taint sibling CRASH/TIMEOUT/ERROR rows, not just the blamed test.
    const retryable = sawDeath && !lastPass && r.unexpected && COLLATERAL_OUTCOMES.has(r.actual);
    // A blamed killer gets one retry; a repeated engine death must not loop the batch.
    const alreadyRetried = r.killedEngine && retriedKillers.has(r.test);
    if (retryable && !alreadyRetried) {
      if (r.killedEngine) retriedKillers.add(r.test);
      requeue.push(r);
      continue;
    }
    accept.push(r);
  }
  return { accept, requeue };
}
