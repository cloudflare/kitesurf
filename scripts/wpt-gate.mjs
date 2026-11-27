// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Judge the merged public WPT buckets against expectations and optional retry draws.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RETRY_CAP, betterFirst, readRetryManifest } from "./wpt-draws.mjs";
import { isMain } from "./wpt-shared.mjs";

const USAGE = `usage: node scripts/wpt-gate.mjs --results <merged.json> [--retries <manifest.json>] [--junit <file>]
       node scripts/wpt-gate.mjs --results <merged.json> --retry-candidates <out.json>`;
const RETRIED = new Set(["TIMEOUT", "CRASH", "ERROR"]);
// A timing-sensitive test can fail under a bucket's load and pass alone, so a PASS that turns
// into a FAIL gets fresh draws too. Order-dependent failures pass alone and read as flakes.
const retried = (entry) =>
  RETRIED.has(entry.outcome) || (entry.expected === "PASS" && entry.outcome === "FAIL");
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

/** @param {Record<string, {outcome: string, expected?: string, unexpected: boolean}>} byFile @param {number} [cap] @returns {{tests: string[], mass?: number}} */
export function retryCandidates(byFile, cap = RETRY_CAP) {
  const tests = deviations(byFile)
    .filter(([, entry]) => retried(entry))
    .map(([test]) => test);
  return tests.length > cap ? { tests: [], mass: tests.length } : { tests };
}

/** @param {Record<string, object>} byFile @param {Record<string, object[]>} draws @param {number} [cap] @returns {{byFile: Record<string, object>, notes: string[]}} */
export function applyRetries(byFile, draws, cap = RETRY_CAP) {
  const { tests, mass } = retryCandidates(byFile, cap);
  const output = { ...byFile };
  const notes = mass
    ? [`${mass} retry candidates exceed WPT_COMPARE_RETRY_CAP=${cap}: retry disabled`]
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

const SUMMARY_ROWS = 50;
const ANNOTATIONS = 10;
const subtests = (entry) => (entry.subTotal ? `${entry.subPass}/${entry.subTotal}` : "");
const cell = (value) => String(value).replace(/[\\|]/g, "\\$&");
const totalsLine = (s) =>
  `${s.total} tests: ${s.expected} as expected, ${s.unexpectedFail} unexpected fail, ${s.unexpectedPass} unexpected pass`;
const percent = (part, whole) => (whole ? ((100 * part) / whole).toFixed(1) : "0.0");
const passingLine = (s) =>
  `${s.passed} of ${s.total} tests pass (${percent(s.passed, s.total)}%); ` +
  `${s.subPass} of ${s.subTotal} subtests pass (${percent(s.subPass, s.subTotal)}%)`;

/** @param {Record<string, object>} byFile @param {string[]} notes @returns {string} */
export function markdownSummary(byFile, notes) {
  const devs = deviations(byFile);
  const retried = Object.entries(byFile)
    .filter(([, entry]) => entry.retried)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const table = (header, rows) => {
    const shown = rows.slice(0, SUMMARY_ROWS);
    const more = rows.length - shown.length;
    return [header, ...shown, ...(more > 0 ? [`\n…and ${more} more; see the job log.`] : [])];
  };
  const lines = [
    `## WPT expectations gate: ${devs.length ? "failed" : "passed"}`,
    "",
    totalsLine(summarize(byFile)) + ".",
    "",
    passingLine(summarize(byFile)) + ".",
  ];
  if (devs.length) {
    lines.push("", `### Unexpected results (${devs.length})`, "");
    lines.push(
      ...table(
        "| Test | Expected | Got | Subtests |\n| --- | --- | --- | --- |",
        devs.map(
          ([test, e]) =>
            `| \`${cell(test)}\` | ${e.expected} | ${e.outcome} | ${subtests(e) || "–"} |`,
        ),
      ),
      "",
      "Rebaseline deliberate changes with `bazel run //tests/wpt:update_expectations`.",
    );
  }
  if (retried.length) {
    lines.push("", `### Retried (${retried.length})`, "");
    lines.push(
      ...table(
        "| Test | First run | Draws | Gated as |\n| --- | --- | --- | --- |",
        retried.map(
          ([test, e]) =>
            `| \`${cell(test)}\` | ${e.retried} | ${cell(e.retryDraws.join(", "))} | ${e.unexpected ? e.outcome : "flake"} |`,
        ),
      ),
    );
  }
  const other = notes.filter((note) => !/: retry passed;|: no draw matched /.test(note));
  if (other.length) lines.push("", ...other.map((note) => `- ${cell(note)}`));
  return lines.join("\n") + "\n";
}

// GitHub workflow commands: an error per unexpected result and a warning per flake, each capped
// at the 10 annotations GitHub shows for one step.
/** @param {Record<string, object>} byFile @returns {string} */
export function annotations(byFile) {
  const data = (value) =>
    String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const property = (value) => data(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
  const command = (kind, title, message) => `::${kind} title=${property(title)}::${data(message)}`;
  const devs = deviations(byFile);
  const flakes = Object.entries(byFile)
    .filter(([, entry]) => entry.retried && !entry.unexpected)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const shownDevs = devs.length > ANNOTATIONS ? ANNOTATIONS - 1 : devs.length;
  const lines = [
    ...devs
      .slice(0, shownDevs)
      .map(([test, e]) =>
        command(
          "error",
          `WPT ${e.expected} → ${e.outcome}`,
          `${test}${subtests(e) ? ` (${subtests(e)} subtests)` : ""}`,
        ),
      ),
    ...flakes
      .slice(0, ANNOTATIONS)
      .map(([test, e]) =>
        command(
          "warning",
          `WPT flake: ${e.retried}`,
          `${test} (retry draws: ${e.retryDraws.join(", ")})`,
        ),
      ),
  ];
  if (shownDevs < devs.length)
    lines.push(command("error", "WPT", `${devs.length - shownDevs} more unexpected results`));
  return lines.length ? lines.join("\n") + "\n" : "";
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
    passed: rows.filter((entry) => entry.outcome === "PASS").length,
    subPass: rows.reduce((sum, entry) => sum + (entry.subPass ?? 0), 0),
    subTotal: rows.reduce((sum, entry) => sum + (entry.subTotal ?? 0), 0),
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
  /** @type {string[]} */
  let notes = [];
  if (options.retries) {
    const retried = applyRetries(byFile, readRetryManifest(resolve(options.retries)));
    byFile = retried.byFile;
    notes = retried.notes;
    for (const note of notes) console.log(`  ${note}`);
  }
  if (options.junit) writeFileSync(options.junit, junit(byFile));
  // scripts/wpt-ci.sh shows these in the GitHub job summary and annotations.
  const outputs = process.env.TEST_UNDECLARED_OUTPUTS_DIR;
  if (outputs) {
    writeFileSync(join(outputs, "summary.md"), markdownSummary(byFile, notes));
    writeFileSync(join(outputs, "annotations.txt"), annotations(byFile));
  }
  const devs = deviations(byFile);
  for (const [test, entry] of devs)
    console.log(
      `  ${entry.expected} → ${entry.outcome}${entry.subTotal ? `  ${entry.subPass}/${entry.subTotal}` : ""}  ${test}`,
    );
  console.log(`[wpt-gate] ${totalsLine(summarize(byFile))}`);
  console.log(`[wpt-gate] ${passingLine(summarize(byFile))}`);
  if (devs.length)
    console.log(
      "[wpt-gate] rebaseline deliberate changes with: bazel run //tests/wpt:update_expectations",
    );
  process.exit(devs.length ? 1 : 0);
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
