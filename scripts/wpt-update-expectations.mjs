// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Rebaseline the public WPT expectations from merged bucket results.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMain, rebaseline, stringifyAsciiJSON } from "./wpt-shared.mjs";

const USAGE = "usage: bazel run //tests/wpt:update_expectations [-- --filter <substring>]";

/** @param {Record<string, {expected?: string}>} expectations @param {Record<string, {outcome: string}>} byFile @param {string} [filter] @returns {{test: string, actual: string, reason: null}[]} */
export function deviating(expectations, byFile, filter) {
  return Object.entries(byFile)
    .filter(
      ([test, entry]) =>
        (!filter || test.includes(filter)) &&
        entry.outcome !== (expectations[test]?.expected ?? "PASS"),
    )
    .map(([test, entry]) => ({ test, actual: entry.outcome, reason: null }))
    .sort((left, right) => (left.test < right.test ? -1 : left.test > right.test ? 1 : 0));
}

function main(argv) {
  let results;
  let filter;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--results") results = argv[++i];
    else if (argv[i] === "--filter") filter = argv[++i];
    else {
      console.error(USAGE);
      process.exit(2);
    }
  }
  const workspace = process.env.BUILD_WORKSPACE_DIRECTORY;
  if (!workspace || !results) {
    console.error(`${USAGE}\n(run it with bazel run, which sets BUILD_WORKSPACE_DIRECTORY)`);
    process.exit(2);
  }
  const file = resolve(workspace, "tests/wpt-expectations.json");
  const expectations = JSON.parse(readFileSync(file, "utf8"));
  const rows = deviating(
    expectations,
    JSON.parse(readFileSync(resolve(results), "utf8")).byFile,
    filter,
  );
  for (const row of rows)
    console.log(`  ${expectations[row.test]?.expected ?? "PASS"} → ${row.actual}  ${row.test}`);
  if (!rows.length) {
    console.log("[update-expectations] no changes; tests/wpt-expectations.json is unchanged");
    return;
  }
  writeFileSync(file, stringifyAsciiJSON(rebaseline(expectations, rows).next));
  console.log(
    `[update-expectations] rebaselined ${rows.length} test(s) in ${file}; review the diff`,
  );
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
