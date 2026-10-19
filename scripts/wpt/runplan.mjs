// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Project full WPT expectations onto each bucket's run-affecting inputs.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMain } from "./shared.mjs";

const USAGE =
  "usage: node scripts/wpt/runplan.mjs --expectations <file> <bucket-tests.json>=<projection.json>...";
export const RUN_OUTCOMES = new Set(["SKIP", "TIMEOUT", "CRASH", "ERROR"]);

/** @param {Record<string, object>} expectations @param {string[]} tests @returns {Record<string, object>} */
export function project(expectations, tests) {
  const output = {};
  for (const test of [...tests].sort()) {
    const entry = expectations[test];
    if (!entry) continue;
    const projected = {};
    if (RUN_OUTCOMES.has(entry.expected)) projected.expected = entry.expected;
    if (entry.timeout) projected.timeout = entry.timeout;
    if (entry.slow === true) projected.slow = true;
    if (Object.keys(projected).length) output[test] = projected;
  }
  return output;
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf("--expectations");
  if (index < 0 || !argv[index + 1] || argv.length < 3) {
    console.error(USAGE);
    process.exit(2);
  }
  const expectations = JSON.parse(readFileSync(resolve(argv[index + 1]), "utf8"));
  for (const pair of argv.filter((_, item) => item !== index && item !== index + 1)) {
    const at = pair.indexOf("=");
    const [testsPath, outputPath] = at < 0 ? [pair, ""] : [pair.slice(0, at), pair.slice(at + 1)];
    if (!testsPath || !outputPath) {
      console.error(`[wpt-runplan] expected <tests.json>=<out.json>, got ${pair}\n${USAGE}`);
      process.exit(2);
    }
    mkdirSync(dirname(resolve(outputPath)), { recursive: true });
    const tests = JSON.parse(readFileSync(resolve(testsPath), "utf8"));
    writeFileSync(resolve(outputPath), JSON.stringify(project(expectations, tests)) + "\n");
  }
}
