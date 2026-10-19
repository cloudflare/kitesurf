// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Judge the merged public WPT buckets against expectations and optional retry draws.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { RETRY_CAP, betterFirst, readRetryManifest } from "./draws.mjs";
import { isMain } from "./shared.mjs";

const USAGE = `usage: node scripts/wpt/gate.mjs --results <merged.json> [--retries <manifest.json>] [--junit <file>]
       node scripts/wpt/gate.mjs --results <merged.json> --retry-candidates <out.json>`;
const RETRIED = new Set(["TIMEOUT", "CRASH", "ERROR"]);
const xml = (value) =>
  String(value).replace(
    /[<>&\"']/g,
    (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char],
  );
const drawLabel = (row) => `${row.outcome}${row.subTotal ? ` ${row.subPass}/${row.subTotal}` : ""}`;

/** @param {Record<string, object>} byFile @returns {string} */
export function junit(byFile) {
  const tests = Object.keys(byFile).sort();
  const failures = tests.filter((test) => byFile[test].unexpected).length;
  const cases = tests.map((test) => {
    const entry = byFile[test];
    const subs = entry.subTotal ? ` (${entry.subPass}/${entry.subTotal} subtests)` : "";
    const body = entry.unexpected
      ? `<failure message="${xml(`expected ${entry.expected}, got ${entry.outcome}${subs}`)}" type="${xml(`${entry.expected}->${entry.outcome}`)}"/>`
      : entry.outcome === "SKIP"
        ? "<skipped/>"
        : "";
    const output = entry.retried
      ? `<system-out>${xml(`first run ${entry.retried}; retry draws: ${entry.retryDraws.join(", ")}`)}</system-out>`
      : "";
    return `  <testcase classname="wpt.${xml(test.split("/")[1] || "root")}" name="${xml(test)}">${body}${output}</testcase>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="wpt" tests="${tests.length}" failures="${failures}">\n${cases.join("\n")}\n</testsuite>\n`;
}

/** @param {Record<string, {unexpected: boolean}>} byFile @returns {[string, object][]} */
export function deviations(byFile) {
  return Object.entries(byFile)
    .filter(([, entry]) => entry.unexpected)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

/** @param {Record<string, {outcome: string, unexpected: boolean}>} byFile @param {number} [cap] @returns {{tests: string[], mass?: number}} */
export function retryCandidates(byFile, cap = RETRY_CAP) {
  const tests = deviations(byFile)
    .filter(([, entry]) => RETRIED.has(entry.outcome))
    .map(([test]) => test);
  return tests.length > cap ? { tests: [], mass: tests.length } : { tests };
}

/** @param {Record<string, object>} byFile @param {Record<string, object[]>} draws @param {number} [cap] @returns {{byFile: Record<string, object>, notes: string[]}} */
export function applyRetries(byFile, draws, cap = RETRY_CAP) {
  const { tests, mass } = retryCandidates(byFile, cap);
  const output = { ...byFile };
  const notes = mass
    ? [`${mass} unexpected TIMEOUT/CRASH/ERROR exceed WPT_COMPARE_RETRY_CAP=${cap}: retry disabled`]
    : [];
  for (const test of tests) {
    const entry = byFile[test];
    const rows = (draws[test] ?? []).filter(Boolean);
    if (!rows.length) {
      notes.push(`${test}: no retry draw attempted it; gate the first result`);
      continue;
    }
    const row =
      rows.find((candidate) => candidate.outcome === entry.expected) ??
      [...rows].sort(betterFirst)[0];
    const unexpected = row.outcome !== entry.expected;
    output[test] = {
      ...row,
      expected: entry.expected,
      unexpected,
      retried: entry.outcome,
      retryDraws: rows.map(drawLabel),
    };
    notes.push(
      unexpected
        ? `${test}: no draw matched ${entry.expected}`
        : `${test}: retry passed; treat first result as a flake`,
    );
  }
  return { byFile: output, notes };
}

function summarize(byFile) {
  const rows = Object.values(byFile);
  const unexpectedPass = rows.filter(
    (entry) => entry.unexpected && entry.expected !== "PASS" && entry.outcome === "PASS",
  ).length;
  const unexpected = rows.filter((entry) => entry.unexpected).length;
  return {
    total: rows.length,
    expected: rows.length - unexpected,
    unexpectedFail: unexpected - unexpectedPass,
    unexpectedPass,
  };
}

function main(argv) {
  const options = { junit: process.env.XML_OUTPUT_FILE };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--results") options.results = argv[++i];
    else if (argv[i] === "--retries") options.retries = argv[++i];
    else if (argv[i] === "--retry-candidates") options.candidates = argv[++i];
    else if (argv[i] === "--junit") options.junit = argv[++i];
    else {
      console.error(USAGE);
      process.exit(2);
    }
  }
  if (!options.results) {
    console.error(USAGE);
    process.exit(2);
  }
  let { byFile } = JSON.parse(readFileSync(resolve(options.results), "utf8"));
  if (options.candidates) {
    const { tests, mass } = retryCandidates(byFile);
    writeFileSync(options.candidates, JSON.stringify(tests, null, 2) + "\n");
    console.log(
      `[wpt-gate] ${mass ? `${mass} retry candidates exceed the cap` : `${tests.length} test(s) to retry`}`,
    );
    return;
  }
  if (options.retries) {
    const retried = applyRetries(byFile, readRetryManifest(resolve(options.retries)));
    byFile = retried.byFile;
    for (const note of retried.notes) console.log(`  ${note}`);
  }
  if (options.junit) writeFileSync(options.junit, junit(byFile));
  const devs = deviations(byFile);
  for (const [test, entry] of devs)
    console.log(
      `  ${entry.expected} → ${entry.outcome}${entry.subTotal ? `  ${entry.subPass}/${entry.subTotal}` : ""}  ${test}`,
    );
  const summary = summarize(byFile);
  console.log(
    `[wpt-gate] ${summary.total} tests: ${summary.expected} as expected, ${summary.unexpectedFail} unexpected fail, ${summary.unexpectedPass} unexpected pass`,
  );
  if (devs.length)
    console.log(
      "[wpt-gate] rebaseline deliberate changes with: bazel run //tests/wpt:update_expectations",
    );
  process.exit(devs.length ? 1 : 0);
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
