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
    if (a === "--results-glob") o.resultsGlob = arr[++i];
    else if (a === "--results") (o.results ??= []).push(arr[++i]);
    else if (a === "--full") (o.full ??= []).push(arr[++i]);
    else if (a === "--expectations") o.expectations = arr[++i];
    else if (a === "--results-out") o.resultsOut = arr[++i];
    else if (a === "--full-glob") o.fullGlob = arr[++i];
    else if (a === "--full-out") o.fullOut = arr[++i];
    else if (a === "--killers-glob") o.killersGlob = arr[++i];
    else if (a === "--killers-out") o.killersOut = arr[++i];
    else if (a === "--stalled-glob") o.stalledGlob = arr[++i];
    else if (a === "--stalled-out") o.stalledOut = arr[++i];
    else if (a === "--expect-total") o.expectTotal = parseInt(arr[++i], 10);
    else if (a === "--allow-partial") o.allowPartial = true;
    else {
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

function mergeResults() {
  const files = expand(opts.resultsGlob, opts.results);
  if (files.length === 0) {
    console.error(red(`[merge] no shard results matched ${opts.resultsGlob}`));
    process.exit(2);
  }
  const byFile = {};
  let doc = null;
  for (const f of files) {
    const d = JSON.parse(readFileSync(f, "utf8"));
    doc ??= d;
    const n = Object.keys(d.byFile ?? {}).length;
    if (n === 0) {
      console.error(red(`[merge] ${f} has no byFile rows — shard produced nothing`));
      process.exit(2);
    }
    console.log(dim(`[merge] ${f}: ${n} file(s)`));
    Object.assign(byFile, d.byFile ?? {});
  }
  if (EXPECT) {
    for (const [test, entry] of Object.entries(byFile))
      Object.assign(entry, judge(test, entry.outcome, entry.reason));
  }
  const byOutcome = {};
  let unexpectedFail = 0;
  let unexpectedPass = 0;
  for (const e of Object.values(byFile)) {
    byOutcome[e.outcome] = (byOutcome[e.outcome] || 0) + 1;
    if (e.unexpected) {
      if (e.expected !== "PASS" && e.outcome === "PASS") unexpectedPass++;
      else unexpectedFail++;
    }
  }
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
  const deviations = Object.entries(byFile)
    .filter(([, e]) => e.unexpected)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const LIST_CAP = 40;
  for (const [test, e] of deviations.slice(0, LIST_CAP)) {
    const sub = e.subTotal ? `  ${e.subPass}/${e.subTotal}` : "";
    const line = `        ${e.expected} → ${e.outcome}${sub}  ${test}`;
    console.log(e.outcome === "PASS" ? line : red(line));
  }
  if (deviations.length > LIST_CAP) {
    console.log(dim(`        … ${deviations.length - LIST_CAP} more in ${opts.resultsOut}`));
  }
  return { total, unexpectedFail, unexpectedPass };
}

function mergeFull() {
  const files = expand(opts.fullGlob, opts.full);
  if (files.length === 0) {
    console.log(
      dim(`[merge] no shard full reports matched ${opts.fullGlob} — skipping ${opts.fullOut}`),
    );
    return;
  }
  const byTest = {};
  let doc = null;
  for (const f of files) {
    const d = JSON.parse(readFileSync(f, "utf8"));
    doc ??= d;
    for (const r of d.results ?? [])
      byTest[r.test] = EXPECT ? { ...r, ...judge(r.test, r.actual, r.reason) } : r;
  }
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

function mergeTestLists(glob, out, label, colour) {
  const files = expand(glob);
  const all = new Set();
  for (const f of files) {
    try {
      for (const t of JSON.parse(readFileSync(f, "utf8"))) all.add(t);
    } catch {}
  }
  const list = [...all].sort();
  writeFileSync(resolve(out), JSON.stringify(list, null, 2) + "\n");
  if (list.length) {
    console.log(
      colour(`[merge] ${list.length} ${label}(s) across ${files.length} shard(s) → ${out}`),
    );
    for (const t of list) console.log(colour(`          ${t}`));
  } else {
    console.log(green(`[merge] no ${label}s seen across ${files.length} shard(s)`));
  }
}

const EXPECT = opts.expectations ? loadJSON(resolve(opts.expectations), {}) : null;
function judge(test, actual, reason) {
  const entry = EXPECT[test];
  const expected = entry?.expected ?? "PASS";
  const skippedAsSlow =
    actual === "SKIP" && entry?.slow === true && /--skip-slow/.test(reason ?? "");
  return { expected, unexpected: actual !== expected && !skippedAsSlow };
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
