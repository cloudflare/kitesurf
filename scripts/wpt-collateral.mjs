// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

const COLLATERAL_OUTCOMES = new Set(["CRASH", "TIMEOUT", "ERROR"]);

/** @typedef {{
 * test: string, actual: string, unexpected: boolean,
 * killedEngine?: boolean
 * }} ResultRow */

function isRetryable(row, sawDeath, lastPass) {
  return sawDeath && !lastPass && row.unexpected && COLLATERAL_OUTCOMES.has(row.actual);
}

function wasAlreadyRetried(row, retriedKillers) {
  return row.killedEngine && retriedKillers.has(row.test);
}

function shouldRequeue(row, sawDeath, lastPass, retriedKillers) {
  const retryable = isRetryable(row, sawDeath, lastPass);
  const alreadyRetried = wasAlreadyRetried(row, retriedKillers);
  return retryable && !alreadyRetried;
}

function markRetriedKiller(row, retriedKillers) {
  if (row.killedEngine) retriedKillers.add(row.test);
}

/** @template {ResultRow} T
 * @param {{results: T[], sawDeath: boolean, lastPass: boolean, retriedKillers: Set<string>}} args
 * @returns {{accept: T[], requeue: T[]}} */
export function planRowDisposition({ results, sawDeath, lastPass, retriedKillers }) {
  const accept = [];
  const requeue = [];
  for (const row of results) {
    // Engine loss can taint sibling CRASH/TIMEOUT/ERROR rows, not just the blamed test.
    // A blamed killer gets one retry; a repeated engine death must not loop the batch.
    if (shouldRequeue(row, sawDeath, lastPass, retriedKillers)) {
      markRetriedKiller(row, retriedKillers);
      requeue.push(row);
      continue;
    }
    accept.push(row);
  }
  return { accept, requeue };
}
