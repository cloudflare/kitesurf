// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Shared allow-list, coverage, and rebaseline rules for Playwright runs.

import { existsSync, readFileSync } from "node:fs";

/** @typedef {{file: string, only: string[] | null}} AllowEntry */

/** @param {string} path @returns {AllowEntry[]} */
export function loadAllowList(path) {
  return JSON.parse(readFileSync(path, "utf8")).map((entry) =>
    typeof entry === "string"
      ? { file: entry, only: null }
      : { file: entry.file, only: entry.only ?? null },
  );
}

/** @param {string} path @returns {Record<string, {expected?: string}>} */
export function loadExpectations(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

/** @param {string} id @returns {string} */
export function leafTitle(id) {
  return id.split("::").slice(1).join("::").split(" › ").pop();
}

/** @param {Record<string, string>} results @param {Record<string, {expected?: string}>} expectations @returns {{id: string, expected: string, actual: string}[]} */
export function deviations(results, expectations) {
  const output = [];
  for (const [id, actual] of Object.entries(results)) {
    const expected = expectations[id]?.expected ?? "PASS";
    if (actual !== expected) output.push({ id, expected, actual });
  }
  return output;
}

/** @param {Record<string, string>} results @param {AllowEntry[]} specs @param {Record<string, {expected?: string}>} expectations @returns {{emptyFiles: string[], missingPins: string[]}} */
export function coverageGaps(results, specs, expectations) {
  const selected = new Map(specs.map((entry) => [entry.file, entry.only && new Set(entry.only)]));
  const filesWithResults = new Set(Object.keys(results).map((id) => id.split("::")[0]));
  const emptyFiles = [...selected.keys()].filter((file) => !filesWithResults.has(file));
  const missingPins = Object.entries(expectations)
    .filter(([id, value]) => {
      if (value.expected === "SKIP" || id in results) return false;
      const file = id.split("::")[0];
      if (!selected.has(file)) return false;
      const only = selected.get(file);
      return !only || only.has(leafTitle(id));
    })
    .map(([id]) => id);
  return { emptyFiles, missingPins };
}

/** @param {Record<string, {expected?: string}>} expectations @param {{id: string, actual: string}[]} changes @returns {Record<string, {expected?: string, reason?: string}>} */
export function rebaseline(expectations, changes) {
  const next = { ...expectations };
  for (const { id, actual } of changes) {
    if (actual === "PASS") delete next[id];
    else next[id] = { expected: actual, reason: "auto: rebaselined to actual" };
  }
  return Object.fromEntries(
    Object.entries(next).sort(([left], [right]) => left.localeCompare(right)),
  );
}

/** @param {Record<string, string>} results @returns {string} */
export function summarize(results) {
  const counts = {};
  for (const status of Object.values(results)) counts[status] = (counts[status] ?? 0) + 1;
  return `${Object.entries(counts)
    .map(([status, count]) => `${status}=${count}`)
    .join(" ")} (total ${Object.keys(results).length})`;
}

/** @param {string} tag @param {{devs: object[], emptyFiles: string[], missingPins: string[]}} gaps @returns {boolean} */
export function reportGaps(tag, { devs, emptyFiles, missingPins }) {
  if (emptyFiles.length) {
    console.error(`[${tag}] ${emptyFiles.length} spec file(s) produced NO results:`);
    for (const file of emptyFiles) console.error(`  ${file}`);
  }
  if (missingPins.length) {
    console.error(`[${tag}] ${missingPins.length} pinned test(s) missing from the report:`);
    for (const id of missingPins) console.error(`  ${id}`);
  }
  if (devs.length) {
    console.error(`[${tag}] ${devs.length} deviation(s) from expectations:`);
    for (const deviation of devs)
      console.error(
        `  ${deviation.id}\n    expected ${deviation.expected}, got ${deviation.actual}`,
      );
  }
  return devs.length + emptyFiles.length + missingPins.length > 0;
}
