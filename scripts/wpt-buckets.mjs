// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Generate contiguous WPT bucket boundaries from measured durations or a default estimate.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMain } from "./wpt-shared.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const TESTS_FILE = resolve(ROOT, "tests/wpt-tests.json");
export const BUCKETS_FILE = resolve(ROOT, "tests/wpt-buckets.json");
const USAGE = `usage: node scripts/wpt-buckets.mjs --durations <wpt full report>... [--budget-ms 35000]
       node scripts/wpt-buckets.mjs --default-only [--budget-ms 35000] [--check]`;

function parseArgs(argv) {
  const options = { durations: [], budgetMs: 35_000, maxTests: 96, engines: 2, defaultMs: 1000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--durations") options.durations.push(resolve(argv[++i]));
    else if (arg === "--budget-ms") options.budgetMs = Number(argv[++i]);
    else if (arg === "--max-tests") options.maxTests = Number(argv[++i]);
    else if (arg === "--engines") options.engines = Number(argv[++i]);
    else if (arg === "--default-ms") options.defaultMs = Number(argv[++i]);
    else if (arg === "--default-only") options.defaultOnly = true;
    else if (arg === "--check") options.check = true;
    else {
      console.error(USAGE);
      process.exit(2);
    }
  }
  return options;
}

function loadDurations(path) {
  const document = JSON.parse(readFileSync(path, "utf8"));
  const output = new Map();
  if (Array.isArray(document.results)) {
    for (const result of document.results) output.set(result.test, result.durationMs ?? 0);
  } else {
    for (const [test, value] of Object.entries(document)) {
      output.set(test, typeof value === "number" ? value : (value.ms ?? value.durationMs ?? 0));
    }
  }
  return output;
}

function makespan(durations, lanes) {
  const load = new Array(lanes).fill(0);
  for (const duration of [...durations].sort((left, right) => right - left)) {
    load[load.indexOf(Math.min(...load))] += duration;
  }
  return Math.max(...load);
}

function bucketName(first) {
  const directory = first
    .split("?")[0]
    .split("/")
    .slice(1, -1)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-");
  const hash = createHash("sha256").update(first).digest("hex").slice(0, 6);
  return `${directory.slice(0, 48).replace(/-+$/, "") || "root"}-${hash}`;
}

/** @param {string[]} tests @param {Map<string, number>} durations @param {{defaultMs: number, engines: number, maxTests: number, budgetMs: number}} options @returns {object[]} */
export function cut(tests, durations, options) {
  const buckets = [];
  let current = [];
  const close = () => {
    if (!current.length) return;
    const values = current.map((test) => durations.get(test) ?? options.defaultMs);
    buckets.push({
      name: bucketName(current[0]),
      first: current[0],
      tests: current.length,
      estMs: Math.round(makespan(values, options.engines)),
    });
    current = [];
  };
  for (const test of tests) {
    const next = [...current, test].map((item) => durations.get(item) ?? options.defaultMs);
    if (
      current.length &&
      (current.length >= options.maxTests || makespan(next, options.engines) > options.budgetMs)
    )
      close();
    current.push(test);
  }
  close();
  return buckets;
}

function check() {
  const document = JSON.parse(readFileSync(BUCKETS_FILE, "utf8"));
  const firsts = document.buckets.map((bucket) => bucket.first);
  const names = new Set(document.buckets.map((bucket) => bucket.name));
  const sorted = [...firsts].sort();
  if (names.size !== firsts.length) throw new Error("duplicate bucket names");
  if (firsts.some((first, index) => first !== sorted[index]))
    throw new Error("bucket boundaries are not sorted");
  const tests = JSON.parse(readFileSync(TESTS_FILE, "utf8"));
  console.log(`[wpt-buckets] ${firsts.length} buckets cover ${tests.length} tests`);
}

if (isMain(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.check) {
    check();
  } else {
    if (!options.durations.length && !options.defaultOnly) {
      console.error(USAGE);
      process.exit(2);
    }
    const durations = new Map();
    for (const file of options.durations) {
      for (const [test, ms] of loadDurations(file))
        durations.set(test, Math.max(ms, durations.get(test) ?? 0));
    }
    const tests = [...JSON.parse(readFileSync(TESTS_FILE, "utf8"))].sort();
    const buckets = cut(tests, durations, options);
    const document = {
      engines: options.engines,
      budgetMs: options.budgetMs,
      maxTests: options.maxTests,
      buckets,
    };
    writeFileSync(BUCKETS_FILE, JSON.stringify(document, null, 1) + "\n");
    const worst = Math.max(...buckets.map((bucket) => bucket.estMs));
    console.log(
      `[wpt-buckets] ${buckets.length} buckets for ${tests.length} tests; slowest estimate ${(worst / 1000).toFixed(1)} s`,
    );
  }
}
