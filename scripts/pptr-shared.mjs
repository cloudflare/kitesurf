// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Result IDs, skip config and coverage rules for upstream Puppeteer runs. IDs follow upstream's
// TestExpectations.json: `[<spec basename>] <mocha fullTitle>`, e.g. `[page.test] Page ...`.

import { readFileSync } from "node:fs";
import { rebaseline } from "./pw-shared.mjs";

/** @typedef {{file: string, only: string[] | null}} AllowEntry */
/** @typedef {{title: string, fullTitle: string, duration?: number, err?: {code?: string, message?: string}}} MochaTest */
/** @typedef {{tests?: MochaTest[], passes?: MochaTest[], failures?: MochaTest[], pending?: MochaTest[]}} MochaReport */
/** @typedef {{results: Record<string, string>, durations: Record<string, number>, errors: Record<string, string>, duplicates: string[]}} FileRun */
/** @typedef {Record<string, {expected?: string, reason?: string}>} Expectations */

const SPEC_NAME = /^[\w.-]+\.test$/;
const HOOK_TITLE = /^"(before|after) (all|each)" hook/;
// Failures slower than this cost as much as a timeout, so rebaselining skips them.
export const SLOW_FAILURE_MS = 10_000;

/** @param {string} path @returns {AllowEntry[]} */
export function loadAllowList(path) {
  return JSON.parse(readFileSync(path, "utf8")).map((entry) => {
    const parsed =
      typeof entry === "string"
        ? { file: entry, only: null }
        : { file: entry.file, only: entry.only ?? null };
    if (!SPEC_NAME.test(parsed.file))
      throw new Error(`allow-list entry "${parsed.file}" is not a spec name like "page.test"`);
    return parsed;
  });
}

/** @param {string} file @param {string} fullTitle @returns {string} */
export function testId(file, fullTitle) {
  return `[${file}] ${fullTitle}`;
}

/** @param {string} id @returns {{file: string, fullTitle: string}} */
export function splitId(id) {
  const match = /^\[([^\]]+)\] ([\s\S]*)$/.exec(id);
  if (!match) throw new Error(`not a Puppeteer test ID: ${id}`);
  return { file: match[1], fullTitle: match[2] };
}

const RANK = { PASS: 0, SKIP: 1, FAIL: 2, TIMEOUT: 3 };

// The first lines of an error message, enough to tell failures apart in a pin's reason.
/** @param {unknown} message @returns {string} */
export function errorSummary(message) {
  const lines = String(message ?? "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const text = lines.slice(0, 3).join(" / ");
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

// Maps one spec file's mocha report to statuses keyed by test ID. A failed hook gets its own ID,
// because mocha drops the rest of its suite. Same-titled tests share an ID; they are listed in
// `duplicates` and the ID keeps the worst status.
/** @param {MochaReport} report @param {string} file @returns {FileRun} */
export function collectResults(report, file) {
  /** @type {Record<string, string>} */
  const results = {};
  /** @type {Record<string, number>} */
  const durations = {};
  /** @type {Record<string, string>} */
  const errors = {};
  const record = (test, status) => {
    const id = testId(file, test.fullTitle);
    if (!(id in results) || RANK[status] > RANK[results[id]]) results[id] = status;
    durations[id] = Math.max(durations[id] ?? 0, test.duration ?? 0);
  };
  for (const test of report.passes ?? []) record(test, "PASS");
  for (const test of report.pending ?? []) record(test, "SKIP");
  for (const test of report.failures ?? []) {
    record(test, test.err?.code === "ERR_MOCHA_TIMEOUT" ? "TIMEOUT" : "FAIL");
    errors[testId(file, test.fullTitle)] ??= errorSummary(test.err?.message);
  }
  const seen = new Map();
  for (const test of report.tests ?? []) {
    if (HOOK_TITLE.test(test.title)) continue;
    const id = testId(file, test.fullTitle);
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  const duplicates = [...seen].filter(([, count]) => count > 1).map(([id]) => id);
  return { results, durations, errors, duplicates };
}

/** @param {string} id @returns {boolean} */
export function isHookId(id) {
  return /"(before|after) (all|each)" hook/.test(splitId(id).fullTitle);
}

// The PUPPETEER_SKIPPED_TEST_CONFIG value for the SKIP pins plus `extraIds`. Upstream reads `*`
// in a pattern as a wildcard and matches the rest literally.
/** @param {Expectations} expectations @param {string[]} [files] @param {string[]} [extraIds] @returns {string} */
export function skipConfig(expectations, files, extraIds = []) {
  const wanted = files && new Set(files);
  const pinned = Object.entries(expectations)
    .filter(([id, value]) => value.expected === "SKIP" && (!wanted || wanted.has(splitId(id).file)))
    .map(([id]) => id);
  return JSON.stringify(
    [...new Set([...pinned, ...extraIds])].map((id) => ({ testIdPattern: id, skip: true })),
  );
}

// How to retry one file's deviations on a fresh engine: rerun the whole file when it produced
// nothing or a hook failed (mocha drops the rest of a suite after a hook failure); otherwise
// skip every test that matched, so only the deviations run again.
/** @param {Record<string, string>} results @param {{id: string}[]} devs @returns {{whole: boolean, skipIds: string[]}} */
export function retryPlan(results, devs) {
  const ids = Object.keys(results);
  if (ids.length === 0 || devs.some((d) => isHookId(d.id))) return { whole: true, skipIds: [] };
  const retried = new Set(devs.map((d) => d.id));
  return { whole: false, skipIds: ids.filter((id) => !retried.has(id) && !isHookId(id)) };
}

/** @param {FileRun} first @param {FileRun} retry @param {{whole: boolean, skipIds: string[]}} plan @returns {FileRun} */
export function mergeRetry(first, retry, plan) {
  if (plan.whole) return retry;
  const skipped = new Set(plan.skipIds);
  const merged = {
    results: { ...first.results },
    durations: { ...first.durations },
    errors: { ...first.errors },
    duplicates: first.duplicates,
  };
  for (const [id, status] of Object.entries(retry.results)) {
    if (skipped.has(id) || status === "SKIP") continue;
    merged.results[id] = status;
    merged.durations[id] = retry.durations[id] ?? 0;
    if (id in retry.errors) merged.errors[id] = retry.errors[id];
    else delete merged.errors[id];
  }
  return merged;
}

/** @param {string[]} fullTitles @returns {string} a mocha --grep matching exactly these titles */
export function exactGrep(fullTitles) {
  const escaped = fullTitles.map((title) => title.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));
  return `^(?:${escaped.join("|")})$`;
}

/** @param {Record<string, string>} results @param {AllowEntry[]} specs @param {Expectations} expectations @returns {{emptyFiles: string[], missingPins: string[]}} */
export function coverageGaps(results, specs, expectations) {
  const selected = new Map(specs.map((entry) => [entry.file, entry.only && new Set(entry.only)]));
  const filesWithResults = new Set(Object.keys(results).map((id) => splitId(id).file));
  const emptyFiles = [...selected.keys()].filter((file) => !filesWithResults.has(file));
  const missingPins = Object.entries(expectations)
    .filter(([id, value]) => {
      if (value.expected === "SKIP" || id in results) return false;
      const { file, fullTitle } = splitId(id);
      if (!selected.has(file)) return false;
      const only = selected.get(file);
      return !only || only.has(fullTitle);
    })
    .map(([id]) => id);
  return { emptyFiles, missingPins };
}

// Rebaselines like pw-shared, but pins timeouts and slow failures as SKIP: they dominate run
// time and can break the tests after them on the same engine. A failure's reason quotes its error.
/** @param {Expectations} expectations @param {{id: string, actual: string}[]} changes @param {Record<string, number>} durations @param {Record<string, string>} [errors] @returns {Expectations} */
export function rebaselineSlow(expectations, changes, durations, errors = {}) {
  const next = rebaseline(expectations, changes);
  for (const { id, actual } of changes) {
    const error = actual === "FAIL" && errors[id] ? errors[id] : "";
    const ms = durations[id] ?? 0;
    if (actual === "TIMEOUT" || (actual === "FAIL" && ms > SLOW_FAILURE_MS)) {
      const after = `auto: ${actual} after ${(ms / 1000).toFixed(1)}s`;
      next[id] = { expected: "SKIP", reason: error ? `${after}: ${error}` : after };
    } else if (error) next[id] = { expected: actual, reason: `auto: ${error}` };
  }
  return next;
}
