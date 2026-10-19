// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Shared outcome ranking and retry-draw parsing for WPT comparison and gates.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SEVERITY = { PASS: 0, FAIL: 1, TIMEOUT: 2, ERROR: 3, CRASH: 4 };

/** @param {string} outcome @returns {number} */
export function rank(outcome) {
  return Object.hasOwn(SEVERITY, outcome) ? SEVERITY[outcome] : SEVERITY.FAIL;
}

/** @param {{outcome: string, subPass?: number}} left @param {{outcome: string, subPass?: number}} right @returns {number} */
export function betterFirst(left, right) {
  return rank(left.outcome) - rank(right.outcome) || (right.subPass ?? 0) - (left.subPass ?? 0);
}

export const RETRY_CAP = parseInt(process.env.WPT_COMPARE_RETRY_CAP ?? "15", 10) || 15;

/** @param {string} path @param {string} [root] @returns {Record<string, object[]>} */
export function readRetryManifest(path, root = ".") {
  const { tests } = JSON.parse(readFileSync(path, "utf8"));
  const output = {};
  for (const [test, files] of Object.entries(tests ?? {})) {
    output[test] = files.map((file) => {
      try {
        return JSON.parse(readFileSync(resolve(root, file), "utf8")).byFile?.[test] ?? null;
      } catch {
        return null;
      }
    });
  }
  return output;
}
