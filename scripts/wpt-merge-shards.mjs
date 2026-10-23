// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { readFileSync, writeFileSync, globSync } from "node:fs";
import { resolve } from "node:path";
import {
  ROOT,
  TESTS_FILE,
  loadJSON,
  summarize,
  wptRevision,
  red,
  dim,
  green,
  yellow,
} from "./wpt-shared.mjs";

function parseArgs(arr) {
  const o = {};
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    switch (a) {
      case "--results-glob":
        o.resultsGlob = arr[++i];
        break;
      case "--results":
        (o.results ??= []).push(arr[++i]);
        break;
      case "--full":
        (o.full ??= []).push(arr[++i]);
        break;
      case "--expectations":
        o.expectations = arr[++i];
        break;
      case "--results-out":
        o.resultsOut = arr[++i];
        break;
      case "--full-glob":
        o.fullGlob = arr[++i];
        break;
      case "--full-out":
        o.fullOut = arr[++i];
        break;
      case "--killers-glob":
        o.killersGlob = arr[++i];
        break;
      case "--killers-out":
        o.killersOut = arr[++i];
        break;
      case "--stalled-glob":
        o.stalledGlob = arr[++i];
        break;
      case "--stalled-out":
        o.stalledOut = arr[++i];
        break;
      case "--expect-total":
        o.expectTotal = parseInt(arr[++i], 10);
        break;
      case "--allow-partial":
        o.allowPartial = true;
        break;
      default:
        console.error(red(`[merge] unknown option: ${a}`));
        process.exit(2);
    }
  }
  return o;
}
const opts = parseArgs(process.argv.slice(2));

// Numeric suffixes exclude artifact metadata sidecars, which use a nonnumeric suffix.
const SHARD_FILE = /-(\d+)\.json$/;

function expand(pattern, explicitFiles) {
  if (explicitFiles) return explicitFiles.map((file) => resolve(file));
  return globSync(pattern, { cwd: ROOT })
    .filter((p) => SHARD_FILE.test(p))
    .map((p) => resolve(ROOT, p))
    .sort((a, b) => Number(SHARD_FILE.exec(a)[1]) - Number(SHARD_FILE.exec(b)[1]));
}

function resultRows(document, file) {
  const rows = document.byFile ?? {};
  const count = Object.keys(rows).length;
  if (count === 0) {
    console.error(red(`[merge] ${file} has no byFile rows — shard produced nothing`));
    process.exit(2);
  }
  console.log(dim(`[merge] ${file}: ${count} file(s)`));
  return rows;
}

function readResultFiles(files) {
  const byFile = {};
  let doc = null;
  for (const file of files) {
    const document = JSON.parse(readFileSync(file, "utf8"));
    doc ??= document;
    Object.assign(byFile, resultRows(document, file));
  }
  return { doc, byFile };
}

function applyExpectations(byFile) {
  if (!EXPECT) return;
  for (const [test, entry] of Object.entries(byFile)) {
    Object.assign(entry, judge(test, entry.outcome, entry.reason));
  }
}

function isUnexpectedPass(entry) {
  return entry.expected !== "PASS" && entry.outcome === "PASS";
}

function countOutcome(entry, counts) {
  counts.byOutcome[entry.outcome] = (counts.byOutcome[entry.outcome] || 0) + 1;
  if (!entry.unexpected) return;
  if (isUnexpectedPass(entry)) counts.unexpectedPass++;
  else counts.unexpectedFail++;
}

function summarizeByFile(byFile) {
  const byOutcome = {};
  const counts = { byOutcome, unexpectedFail: 0, unexpectedPass: 0 };
  for (const e of Object.values(byFile)) {
    countOutcome(e, counts);
  }
  return counts;
}

function formatDeviation(test, entry) {
  const sub = entry.subTotal ? `  ${entry.subPass}/${entry.subTotal}` : "";
  const line = `        ${entry.expected} → ${entry.outcome}${sub}  ${test}`;
  return entry.outcome === "PASS" ? line : red(line);
}

function printDeviations(byFile) {
  const deviations = Object.entries(byFile)
    .filter(([, entry]) => entry.unexpected)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const LIST_CAP = 40;
  for (const [test, entry] of deviations.slice(0, LIST_CAP)) {
    console.log(formatDeviation(test, entry));
  }
  if (deviations.length > LIST_CAP) {
    console.log(dim(`        … ${deviations.length - LIST_CAP} more in ${opts.resultsOut}`));
  }
}

function mergeResults() {
  const files = expand(opts.resultsGlob, opts.results);
  if (files.length === 0) {
    console.error(red(`[merge] no shard results matched ${opts.resultsGlob}`));
    process.exit(2);
  }
  const { doc, byFile } = readResultFiles(files);
  applyExpectations(byFile);
  const { byOutcome, unexpectedFail, unexpectedPass } = summarizeByFile(byFile);
  const total = Object.keys(byFile).length;
  const out = {
    commit: doc.commit ?? null,
    date: new Date().toISOString(),
    ref: doc.ref ?? "local",
    wptRevision: wptRevision(),
    shards: files.length,
    summary: {
      total,
      expected: total - unexpectedFail - unexpectedPass,
      unexpectedFail,
      unexpectedPass,
      byOutcome,
    },
    byFile,
  };
  writeFileSync(resolve(opts.resultsOut), JSON.stringify(out, null, 2) + "\n");
  console.log(
    green(
      `[merge] ${files.length} shard(s) -> ${opts.resultsOut} (${total} files, ${unexpectedFail} unexpected fail, ${unexpectedPass} unexpected pass)`,
    ),
  );
  printDeviations(byFile);
  return { total, unexpectedFail, unexpectedPass };
}

function mergeFullRow(row) {
  return EXPECT ? { ...row, ...judge(row.test, row.actual, row.reason) } : row;
}

function readFullFiles(files) {
  const byTest = {};
  let doc = null;
  for (const f of files) {
    const d = JSON.parse(readFileSync(f, "utf8"));
    doc ??= d;
    for (const row of d.results ?? []) byTest[row.test] = mergeFullRow(row);
  }
  return { byTest, doc };
}

function mergeFull() {
  const files = expand(opts.fullGlob, opts.full);
  if (files.length === 0) {
    console.log(
      dim(`[merge] no shard full reports matched ${opts.fullGlob} — skipping ${opts.fullOut}`),
    );
    return;
  }
  const { byTest, doc } = readFullFiles(files);
  const results = Object.values(byTest);
  const out = {
    date: new Date().toISOString(),
    base: doc.base,
    ws: doc.ws,
    commit: doc.commit ?? null,
    slice: "ci-full",
    summary: summarize(results),
    results,
  };
  writeFileSync(resolve(opts.fullOut), JSON.stringify(out, null, 2) + "\n");
  console.log(
    green(`[merge] ${files.length} shard(s) -> ${opts.fullOut} (${results.length} tests)`),
  );
}

function addTestFile(all, file) {
  try {
    for (const test of JSON.parse(readFileSync(file, "utf8"))) all.add(test);
  } catch {}
}

function printTestList(list, files, out, label, colour) {
  if (list.length) {
    console.log(
      colour(`[merge] ${list.length} ${label}(s) across ${files.length} shard(s) → ${out}`),
    );
    for (const test of list) console.log(colour(`          ${test}`));
  } else {
    console.log(green(`[merge] no ${label}s seen across ${files.length} shard(s)`));
  }
}

function mergeTestLists(glob, out, label, colour) {
  const files = expand(glob);
  const all = new Set();
  for (const f of files) addTestFile(all, f);
  const list = [...all].sort();
  writeFileSync(resolve(out), JSON.stringify(list, null, 2) + "\n");
  printTestList(list, files, out, label, colour);
}

const EXPECT = opts.expectations ? loadJSON(resolve(opts.expectations), {}) : null;
function expectedOutcome(entry) {
  return entry?.expected ?? "PASS";
}

function skippedAsSlow(actual, entry, reason) {
  return actual === "SKIP" && entry?.slow === true && /--skip-slow/.test(reason ?? "");
}

function judge(test, actual, reason) {
  const entry = EXPECT[test];
  const expected = expectedOutcome(entry);
  return { expected, unexpected: actual !== expected && !skippedAsSlow(actual, entry, reason) };
}

const { total } = mergeResults();
if ((opts.fullGlob || opts.full) && opts.fullOut) mergeFull();
if (opts.killersGlob && opts.killersOut) {
  mergeTestLists(opts.killersGlob, opts.killersOut, "engine-killer", red);
}
if (opts.stalledGlob && opts.stalledOut) {
  mergeTestLists(opts.stalledGlob, opts.stalledOut, "engine-staller", yellow);
}

const expectTotal = opts.expectTotal ?? loadJSON(TESTS_FILE, []).length;
// Reject an incomplete union so a missing shard cannot masquerade as a smaller pass.
if (expectTotal && total < expectTotal) {
  const msg = `[merge] incomplete: merged ${total} of ${expectTotal} tests — ${expectTotal - total} missing`;
  if (opts.allowPartial) {
    console.log(dim(msg + " (--allow-partial)"));
  } else {
    console.error(red(msg));
    process.exit(2);
  }
}
