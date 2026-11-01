// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Judge merged Puppeteer shards against the public allow-list and expectations.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deviations, loadExpectations, reportGaps, summarize } from "./pw-shared.mjs";
import { coverageGaps, loadAllowList, rebaselineSlow, splitId } from "./pptr-shared.mjs";
import { isMain } from "./wpt-shared.mjs";

const USAGE =
  "usage: node scripts/pptr-gate.mjs --results <shard.json>... [--tests <file>] [--expectations <file>] [--junit <file>] [--update-expectations]";
const xml = (value) =>
  String(value).replace(
    /[<>&\"']/g,
    (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char],
  );

/** @param {Record<string, string>} results @param {{id: string, expected: string, actual: string}[]} devs @param {string[]} emptyFiles @param {string[]} missingPins @param {string[]} unrun @returns {string} */
export function junit(results, devs, emptyFiles, missingPins, unrun) {
  const byId = new Map(devs.map((deviation) => [deviation.id, deviation]));
  const failure = (message) => `<failure message="${xml(message)}"/>`;
  const row = (file, name, body) =>
    `  <testcase classname="pptr.${xml(file)}" name="${xml(name)}">${body}</testcase>`;
  const testRow = (id, body) => {
    const { file, fullTitle } = splitId(id);
    return row(file, fullTitle, body);
  };
  const cases = Object.keys(results)
    .sort()
    .map((id) => {
      const deviation = byId.get(id);
      const body = deviation
        ? failure(`expected ${deviation.expected}, got ${deviation.actual}`)
        : results[id] === "SKIP"
          ? "<skipped/>"
          : "";
      return testRow(id, body);
    });
  for (const file of emptyFiles)
    cases.push(
      row(
        file,
        "(spec file)",
        failure(unrun.includes(file) ? "no shard ran it" : "produced no results"),
      ),
    );
  for (const id of missingPins)
    cases.push(testRow(id, failure("pinned test missing from the report")));
  const failures = cases.filter((entry) => entry.includes("<failure")).length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="puppeteer" tests="${cases.length}" failures="${failures}">\n${cases.join("\n")}\n</testsuite>\n`;
}

function main(argv) {
  const options = {
    results: [],
    tests: "tests/pptr-tests.json",
    expectations: "tests/pptr-expectations.json",
    junit: process.env.XML_OUTPUT_FILE,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--results") options.results.push(argv[++i]);
    else if (argv[i] === "--tests") options.tests = argv[++i];
    else if (argv[i] === "--expectations") options.expectations = argv[++i];
    else if (argv[i] === "--junit") options.junit = argv[++i];
    else if (argv[i] === "--update-expectations") options.update = true;
    else {
      console.error(USAGE);
      process.exit(2);
    }
  }
  if (!options.results.length) {
    console.error(USAGE);
    process.exit(2);
  }
  const allowList = loadAllowList(resolve(options.tests));
  const results = {};
  const durations = {};
  const errors = {};
  const ran = new Set();
  for (const file of options.results) {
    const shard = JSON.parse(readFileSync(resolve(file), "utf8"));
    for (const spec of shard.files) ran.add(spec);
    Object.assign(results, shard.results);
    Object.assign(durations, shard.durations ?? {});
    Object.assign(errors, shard.errors ?? {});
  }
  const unrun = allowList.map((entry) => entry.file).filter((file) => !ran.has(file));
  if (options.update) return update(results, durations, errors);
  const expectations = loadExpectations(resolve(options.expectations));
  const devs = deviations(results, expectations);
  const { emptyFiles, missingPins } = coverageGaps(results, allowList, expectations);
  if (options.junit)
    writeFileSync(options.junit, junit(results, devs, emptyFiles, missingPins, unrun));
  console.log(`[pptr-gate] ${options.results.length} shard(s): ${summarize(results)}`);
  if (unrun.length)
    console.error(
      `[pptr-gate] ${unrun.length} allow-listed spec(s) ran in no shard: ${unrun.join(", ")}`,
    );
  if (reportGaps("pptr-gate", { devs, emptyFiles, missingPins })) {
    console.error(
      "[pptr-gate] rebaseline deliberate changes with: bazel run //tests/pptr:update_expectations",
    );
    process.exit(1);
  }
  console.log("[pptr-gate] all results match expectations");
}

function update(results, durations, errors) {
  const workspace = process.env.BUILD_WORKSPACE_DIRECTORY;
  if (!workspace) {
    console.error(
      `${USAGE}\n(--update-expectations requires bazel run, which sets BUILD_WORKSPACE_DIRECTORY)`,
    );
    process.exit(2);
  }
  const file = resolve(workspace, "tests/pptr-expectations.json");
  const expectations = loadExpectations(file);
  const devs = deviations(results, expectations);
  for (const deviation of devs)
    console.log(`  ${deviation.expected} → ${deviation.actual}  ${deviation.id}`);
  if (!devs.length)
    return console.log("[pptr-gate] nothing deviates; tests/pptr-expectations.json is unchanged");
  writeFileSync(
    file,
    JSON.stringify(rebaselineSlow(expectations, devs, durations, errors), null, 2) + "\n",
  );
  console.log(`[pptr-gate] rebaselined ${devs.length} test(s) in ${file}; review the diff`);
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
