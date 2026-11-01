// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Runs allow-listed upstream Puppeteer spec files against fresh local engines, one per file,
// and gates on tests/pptr-expectations.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { localEngines } from "./local-engine.mjs";
import { deviations, loadExpectations, reportGaps, summarize } from "./pw-shared.mjs";
import {
  collectResults,
  coverageGaps,
  exactGrep,
  loadAllowList,
  mergeRetry,
  rebaselineSlow,
  retryPlan,
  skipConfig,
} from "./pptr-shared.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const TESTS_JSON = resolve(ROOT, "tests/pptr-tests.json");
const EXPECTATIONS_JSON = resolve(ROOT, "tests/pptr-expectations.json");
const TAG = "pptr-run";

const args = process.argv.slice(2);
const optionValue = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const PPTR_DIR = resolve(optionValue("--pptr-dir") ?? resolve(ROOT, ".puppeteer"));
const OUT_DIR = resolve(optionValue("--out-dir") ?? join(PPTR_DIR, "test-results"));
const launcher = optionValue("--engine-launcher") ?? "wrangler";
const engineDist = resolve(optionValue("--dist") ?? resolve(ROOT, "packages/engine/.wpt-dist"));
const firstPort = parseInt(optionValue("--port") ?? "9780", 10);
const maxFileMs = parseInt(optionValue("--max-file-ms") ?? "600000", 10);
const resultsOut = optionValue("--results-out");
const filter = optionValue("--filter");
const userGrep = optionValue("--grep");
const noGate = args.includes("--no-gate");
const noRetry = args.includes("--no-retry");
const updateExpectations = args.includes("--update-expectations");
if (launcher !== "wrangler" && launcher !== "miniflare") {
  console.error(`[${TAG}] --engine-launcher wants wrangler or miniflare, got ${launcher}`);
  process.exit(2);
}
const shard = (() => {
  const value = optionValue("--shard");
  if (value === null) return null;
  const m = /^(\d+)\/(\d+)$/.exec(value);
  const k = m && parseInt(m[1], 10),
    n = m && parseInt(m[2], 10);
  if (!m || k < 1 || k > n) {
    console.error(`[${TAG}] bad --shard "${value}" (want k/n, 1<=k<=n)`);
    process.exit(2);
  }
  return { k, n };
})();

const MOCHA = join(PPTR_DIR, "node_modules/mocha/bin/mocha.js");
const RUNNER_BIN = join(PPTR_DIR, "tools/mocha-runner/bin");
const REPORTER = resolve(ROOT, "scripts/pptr-reporter.mjs");
if (!existsSync(join(PPTR_DIR, "test/build/mocha-utils.js")) || !existsSync(MOCHA)) {
  console.error(`[${TAG}] .puppeteer/ missing or unbuilt — run \`pnpm run pptr:setup\` first`);
  process.exit(1);
}

const allowList = loadAllowList(TESTS_JSON);
let specs = filter ? allowList.filter((e) => e.file.includes(filter)) : allowList;
if (shard) specs = specs.filter((_, i) => i % shard.n === shard.k - 1);
if (specs.length === 0) {
  if (shard && !filter) {
    console.log(`[${TAG}] shard ${shard.k}/${shard.n}: no specs — nothing to do`);
    process.exit(0);
  }
  console.error(`[${TAG}] no allow-listed specs match filter "${filter}"`);
  process.exit(1);
}
for (const entry of specs) {
  if (!existsSync(join(PPTR_DIR, "test/build", `${entry.file}.js`))) {
    console.error(`[${TAG}] ${entry.file}: no test/build/${entry.file}.js in ${PPTR_DIR}`);
    process.exit(1);
  }
}

const expectations = loadExpectations(EXPECTATIONS_JSON);
const { buildBundles, startEngine } = localEngines({
  tag: TAG,
  launcher,
  dist: engineDist,
  outDir: OUT_DIR,
  firstPort,
  skipBuildEnv: "PPTR_SKIP_BUILD",
});

// One mocha process per spec file. Upstream's custom interface reads the skip config; the
// specs need it. pptr-reporter writes the JSON collectResults reads.
function runMocha(wsEndpoint, file, grep, label, skipIds = []) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonOut = join(OUT_DIR, `kitesurf-report-${label}.json`);
  rmSync(jsonOut, { force: true });
  const mochaArgs = [
    MOCHA,
    "-u",
    join(RUNNER_BIN, "interface.js"),
    "-R",
    REPORTER,
    "-O",
    `output=${jsonOut}`,
    "--retries",
    "0",
    "--exit",
    `test/build/${file}.js`,
  ];
  if (grep) mochaArgs.push("--grep", grep);
  const env = {
    ...process.env,
    KITESURF_WS: wsEndpoint,
    PUPPETEER_BROWSER: "chrome",
    HEADLESS: "true",
    PUPPETEER_PROTOCOL: "cdp",
    PUPPETEER_SKIP_DOWNLOAD: "1",
    PUPPETEER_SKIPPED_TEST_CONFIG: skipConfig(expectations, [file], skipIds),
  };
  delete env.CI;
  delete env.PARALLEL;
  const started = Date.now();
  const r = spawnSync(process.execPath, mochaArgs, {
    cwd: PPTR_DIR,
    stdio: "inherit",
    env,
    timeout: maxFileMs,
    killSignal: "SIGKILL",
  });
  if (r.error?.code === "ETIMEDOUT")
    console.error(`[${TAG}] ${label}: mocha killed after ${(Date.now() - started) / 1000}s`);
  if (!existsSync(jsonOut)) {
    console.error(
      `[${TAG}] ${label}: no JSON report — mocha crashed (exit ${r.status ?? r.signal ?? r.error})`,
    );
    return { results: {}, durations: {}, errors: {}, duplicates: [] };
  }
  return collectResults(JSON.parse(readFileSync(jsonOut, "utf8")), file);
}

async function withEngine(externalWs, fn) {
  if (externalWs) return fn(externalWs, null);
  const eng = await startEngine();
  try {
    return fn(eng.wsEndpoint, eng);
  } finally {
    eng.stop();
  }
}

async function runFile(entry, index, externalWs) {
  const only = entry.only ? exactGrep(entry.only) : null;
  const grep = only && userGrep ? `(?=.*(?:${userGrep}))${only}` : (userGrep ?? only);
  const run = await withEngine(externalWs, (ws, eng) => {
    console.log(
      `\n[${TAG}] ${entry.file}${only ? " (only-selection)" : ""}${eng ? ` on :${eng.port}` : ""}`,
    );
    return runMocha(ws, entry.file, grep, `f${index}`);
  });
  const devs = deviations(run.results, expectations);
  if (noRetry || (devs.length === 0 && Object.keys(run.results).length > 0)) return run;
  // The retry selects tests through the skip config (an environment variable), not --grep: a
  // regex of a few dozen titles in argv has had mocha SIGKILLed before it started.
  const plan = retryPlan(run.results, devs);
  console.log(
    `[${TAG}] ${entry.file}: retrying ${plan.whole ? "the whole file" : `${devs.length} deviation(s)`} on a fresh engine`,
  );
  const retry = await withEngine(externalWs, (ws) =>
    runMocha(ws, entry.file, grep, `f${index}r`, plan.skipIds),
  );
  return mergeRetry(run, retry, plan);
}

function compare(results, durations, errors, duplicates) {
  const devs = deviations(results, expectations);
  if (updateExpectations) {
    const next = rebaselineSlow(expectations, devs, durations, errors);
    writeFileSync(EXPECTATIONS_JSON, JSON.stringify(next, null, 2) + "\n");
    console.log(`[${TAG}] rebaselined ${devs.length} expectation(s) → ${EXPECTATIONS_JSON}`);
    return 0;
  }
  console.log(`\n[${TAG}] results: ${summarize(results)}`);
  if (duplicates.length) {
    console.warn(
      `[${TAG}] ${duplicates.length} ID(s) name more than one test (worst status kept):`,
    );
    for (const id of duplicates) console.warn(`  ${id}`);
  }
  const gaps = userGrep
    ? { emptyFiles: [], missingPins: [] }
    : coverageGaps(results, specs, expectations);
  if (reportGaps(TAG, { devs, ...gaps })) {
    console.error(
      `[${TAG}] if intentional: rerun with --update-expectations and commit the rebaseline separately`,
    );
    return 1;
  }
  console.log(`[${TAG}] all results match expectations`);
  return 0;
}

const externalWs = process.env.KITESURF_WS;
if (externalWs) {
  console.log(`[${TAG}] attaching to external engine: ${externalWs} (no per-file restart)`);
} else {
  await buildBundles();
}
console.log(
  `[${TAG}] ${specs.length} spec file(s)${shard ? ` (shard ${shard.k}/${shard.n})` : ""}${noRetry ? " (retry off)" : ""}`,
);

const merged = {};
const durations = {};
const errors = {};
const duplicates = [];
const batches = [];
for (let i = 0; i < specs.length; i++) {
  const started = Date.now();
  const run = await runFile(specs[i], i, externalWs);
  const ms = Date.now() - started;
  Object.assign(merged, run.results);
  Object.assign(durations, run.durations);
  Object.assign(errors, run.errors);
  duplicates.push(...run.duplicates);
  batches.push({ files: [specs[i].file], ms });
  console.log(`[${TAG}] ${specs[i].file}: ${summarize(run.results)} in ${(ms / 1000).toFixed(0)}s`);
}
if (resultsOut) {
  writeFileSync(
    resultsOut,
    JSON.stringify(
      { files: specs.map((entry) => entry.file), results: merged, durations, errors, batches },
      null,
      1,
    ) + "\n",
  );
}
const verdict = compare(merged, durations, errors, duplicates);
process.exit(noGate ? 0 : verdict);
