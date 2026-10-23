// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Judge merged Playwright shards against the public allow-list and expectations.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  coverageGaps,
  deviations,
  loadAllowList,
  loadExpectations,
  rebaseline,
  reportGaps,
  summarize,
} from "./pw-shared.mjs";
import { isMain } from "./wpt-shared.mjs";

const USAGE =
  "usage: node scripts/pw-gate.mjs --results <shard.json>... [--tests <file>] [--expectations <file>] [--junit <file>] [--update-expectations]";
const xml = (value) =>
  String(value).replace(
    /[<>&\"']/g,
    (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char],
  );

/** @param {Record<string, string>} results @param {object[]} devs @param {string[]} emptyFiles @param {string[]} missingPins @param {string[]} unrun @returns {string} */
export function junit(results, devs, emptyFiles, missingPins, unrun) {
  const byId = new Map(devs.map((deviation) => [deviation.id, deviation]));
  const failure = (message) => `<failure message="${xml(message)}"/>`;
  const row = (file, name, body) =>
    `  <testcase classname="pw.${xml(file)}" name="${xml(name)}">${body}</testcase>`;
  const cases = Object.keys(results)
    .sort()
    .map((id) => {
      const deviation = byId.get(id);
      const [file, ...title] = id.split("::");
      const body = deviation
        ? failure(`expected ${deviation.expected}, got ${deviation.actual}`)
        : results[id] === "SKIP"
          ? "<skipped/>"
          : "";
      return row(file, title.join("::"), body);
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
    cases.push(
      row(
        id.split("::")[0],
        id.split("::").slice(1).join("::"),
        failure("pinned test missing from the report"),
      ),
    );
  const failures = cases.filter((entry) => entry.includes("<failure")).length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="playwright" tests="${cases.length}" failures="${failures}">\n${cases.join("\n")}\n</testsuite>\n`;
}

function parseArgs(argv) {
  const options = {
    results: [],
    tests: "tests/pw-tests.json",
    expectations: "tests/pw-expectations.json",
    junit: process.env.XML_OUTPUT_FILE,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--results":
        options.results.push(argv[++i]);
        break;
      case "--tests":
        options.tests = argv[++i];
        break;
      case "--expectations":
        options.expectations = argv[++i];
        break;
      case "--junit":
        options.junit = argv[++i];
        break;
      case "--update-expectations":
        options.update = true;
        break;
      default:
        console.error(USAGE);
        process.exit(2);
    }
  }
  return options;
}

function requireResults(options) {
  if (!options.results.length) {
    console.error(USAGE);
    process.exit(2);
  }
}

function loadResults(files) {
  const results = {};
  const ran = new Set();
  for (const file of files) {
    const shard = JSON.parse(readFileSync(resolve(file), "utf8"));
    for (const spec of shard.files) ran.add(spec);
    Object.assign(results, shard.results);
  }
  return { results, ran };
}

function printGateResults(options, results, allowList, unrun) {
  const expectations = loadExpectations(resolve(options.expectations));
  const devs = deviations(results, expectations);
  const { emptyFiles, missingPins } = coverageGaps(results, allowList, expectations);
  if (options.junit)
    writeFileSync(options.junit, junit(results, devs, emptyFiles, missingPins, unrun));
  console.log(`[pw-gate] ${options.results.length} shard(s): ${summarize(results)}`);
  if (unrun.length)
    console.error(
      `[pw-gate] ${unrun.length} allow-listed spec(s) ran in no shard: ${unrun.join(", ")}`,
    );
  if (reportGaps("pw-gate", { devs, emptyFiles, missingPins })) {
    console.error(
      "[pw-gate] rebaseline deliberate changes with: bazel run //tests/pw:update_expectations",
    );
    process.exit(1);
  }
  console.log("[pw-gate] all results match expectations");
}

function main(argv) {
  const options = parseArgs(argv);
  requireResults(options);
  const allowList = loadAllowList(resolve(options.tests));
  const { results, ran } = loadResults(options.results);
  const unrun = allowList.map((entry) => entry.file).filter((file) => !ran.has(file));
  if (options.update) return update(options, results);
  printGateResults(options, results, allowList, unrun);
}

function update(options, results) {
  const workspace = process.env.BUILD_WORKSPACE_DIRECTORY;
  if (!workspace) {
    console.error(
      `${USAGE}\n(--update-expectations requires bazel run, which sets BUILD_WORKSPACE_DIRECTORY)`,
    );
    process.exit(2);
  }
  const file = resolve(workspace, "tests/pw-expectations.json");
  const expectations = loadExpectations(file);
  const devs = deviations(results, expectations);
  for (const deviation of devs)
    console.log(`  ${deviation.expected} → ${deviation.actual}  ${deviation.id}`);
  if (!devs.length)
    return console.log("[pw-gate] nothing deviates; tests/pw-expectations.json is unchanged");
  writeFileSync(file, JSON.stringify(rebaseline(expectations, devs), null, 2) + "\n");
  console.log(`[pw-gate] rebaselined ${devs.length} test(s) in ${file}; review the diff`);
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
