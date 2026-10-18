// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import net from "node:net";
import {
  coverageGaps,
  deviations as diffExpectations,
  loadAllowList,
  loadExpectations as readExpectations,
  rebaseline,
  reportGaps,
  summarize,
} from "./pw-shared.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ENGINE_DIR = resolve(ROOT, "packages/engine");
const TESTS_JSON = resolve(ROOT, "tests/pw-tests.json");
const EXPECTATIONS_JSON = resolve(ROOT, "tests/pw-expectations.json");

const args = process.argv.slice(2);
const optionValue = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const PW_DIR = resolve(optionValue("--pw-dir") ?? resolve(ROOT, ".playwright"));
const OUT_DIR = resolve(optionValue("--out-dir") ?? join(PW_DIR, "test-results"));
const launcher = optionValue("--engine-launcher") ?? "wrangler";
const engineDist = resolve(optionValue("--dist") ?? resolve(ENGINE_DIR, ".wpt-dist"));
const resultsOut = optionValue("--results-out");
const noGate = args.includes("--no-gate");
if (launcher !== "wrangler" && launcher !== "miniflare") {
  console.error(`[pw-run] --engine-launcher wants wrangler or miniflare, got ${launcher}`);
  process.exit(2);
}
const updateExpectations = args.includes("--update-expectations");
const noRetry = args.includes("--no-retry");
const filterIdx = args.indexOf("--filter");
const filter = filterIdx >= 0 ? args[filterIdx + 1] : null;
const batchSizeIdx = args.indexOf("--batch-size");
const batchSize = batchSizeIdx >= 0 ? Math.max(1, parseInt(args[batchSizeIdx + 1], 10) || 1) : 1;
const grepIdx = args.indexOf("--grep");
const userGrep = grepIdx >= 0 ? args[grepIdx + 1] : null;
const shardIdx = args.indexOf("--shard");
const shard = (() => {
  if (shardIdx < 0) return null;
  const m = /^(\d+)\/(\d+)$/.exec(args[shardIdx + 1] ?? "");
  const k = m && parseInt(m[1], 10),
    n = m && parseInt(m[2], 10);
  if (!m || k < 1 || k > n) {
    console.error(`[pw-run] bad --shard "${args[shardIdx + 1]}" (want k/n, 1<=k<=n)`);
    process.exit(2);
  }
  return { k, n };
})();

if (!existsSync(join(PW_DIR, "packages/playwright/cli.js"))) {
  console.error("[pw-run] .playwright/ missing or unbuilt — run `pnpm run pw:setup` first");
  process.exit(1);
}

const allowList = loadAllowList(TESTS_JSON);
let specs = filter ? allowList.filter((e) => e.file.includes(filter)) : allowList;
if (shard) specs = specs.filter((_, i) => i % shard.n === shard.k - 1);
if (specs.length === 0) {
  if (shard && !filter) {
    console.log(`[pw-run] shard ${shard.k}/${shard.n}: no specs — nothing to do`);
    process.exit(0);
  }
  console.error(`[pw-run] no allow-listed specs match filter "${filter}"`);
  process.exit(1);
}

const ALL_STOPS = new Set();
function cleanupAll() {
  for (const s of Array.from(ALL_STOPS)) {
    try {
      s();
    } catch {}
  }
  ALL_STOPS.clear();
}
process.on("exit", cleanupAll);
process.on("SIGINT", () => {
  cleanupAll();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanupAll();
  process.exit(143);
});

let nextPort = 9720;
const MAX_PORT_ALLOCATION_ATTEMPTS = 500;
const ENGINE_HEALTH_POLL_INTERVAL_MS = 300;
const ENGINE_HEALTH_STARTUP_BUDGET_MS = 90_000;

function isFree(port) {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once("error", () => res(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => res(true)));
  });
}
async function allocPort() {
  for (let i = 0; i < MAX_PORT_ALLOCATION_ATTEMPTS; i++) {
    const p = nextPort++;
    if (await isFree(p)) return p;
  }
  throw new Error("no free port found");
}
async function waitHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, ENGINE_HEALTH_POLL_INTERVAL_MS));
  }
  return false;
}

const MINIFLARE_VARS = [
  "KITESURF_ENV:local",
  "KITESURF_RESOURCE_DRAIN_QUIET_TURNS:5",
  "KITESURF_LAG_WATCHDOG:1",
  "KITESURF_OTLP_ENDPOINT:http://localhost:4318/v1/traces",
];

async function buildBundles() {
  if (process.env.PW_SKIP_BUILD === "1" || launcher === "miniflare") return;
  const wasm = resolve(ROOT, "packages/core/pkg/kitesurf_core_bg.wasm");
  if (!existsSync(wasm))
    throw new Error("core wasm not built — run `pnpm run build` first (or PW_SKIP_BUILD=1)");
  for (const pkg of [
    "packages/dom-shim",
    "packages/page-script",
    "packages/page-renderer",
    "packages/worker-script",
  ]) {
    const script = resolve(ROOT, pkg, "scripts/build.mjs");
    const r = spawnSync(process.execPath, [script], { stdio: "ignore" });
    if (r.status !== 0) throw new Error(`${pkg} build failed (exit ${r.status})`);
  }
  console.log("[pw-run] built dom-shim + page-script + page-renderer + worker-script bundles");
}

async function startEngine() {
  const port = await allocPort();
  const iport = await allocPort();
  const wranglerBin = (() => {
    const p = resolve(ENGINE_DIR, "node_modules/.bin/wrangler");
    return existsSync(p) ? p : "wrangler";
  })();
  const bin = launcher === "miniflare" ? process.execPath : wranglerBin;
  const cliArgs =
    launcher === "miniflare"
      ? [
          resolve(ROOT, "scripts/wpt-engine.mjs"),
          "serve",
          "--dist",
          engineDist,
          "--port",
          String(port),
          "--inspector-port",
          String(iport),
          ...MINIFLARE_VARS.flatMap((value) => ["--var", value]),
        ]
      : [
          "dev",
          "--env",
          "local",
          "-c",
          "wrangler.jsonc",
          "-c",
          "test/fixtures-worker/wrangler.jsonc",
          "--port",
          String(port),
          "--inspector-port",
          String(iport),
        ];
  if (process.env.KITESURF_SIMULATE_PROD_EVAL)
    cliArgs.push("--var", "KITESURF_SIMULATE_PROD_EVAL:1");
  mkdirSync(OUT_DIR, { recursive: true });
  const logPath = join(OUT_DIR, `kitesurf-engine-${port}.log`);
  const fd = openSync(logPath, "w");
  const proc = spawn(bin, cliArgs, {
    cwd: ENGINE_DIR,
    env: process.env,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  const stop = () => {
    try {
      if (proc.pid) process.kill(-proc.pid, "SIGKILL");
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
    try {
      closeSync(fd);
    } catch {}
  };
  ALL_STOPS.add(stop);
  if (!(await waitHealth(port, ENGINE_HEALTH_STARTUP_BUDGET_MS))) {
    stop();
    ALL_STOPS.delete(stop);
    throw new Error(`engine never became healthy on :${port} (see ${logPath})`);
  }
  return {
    wsEndpoint: `ws://127.0.0.1:${port}/devtools/browser`,
    port,
    stop: () => {
      ALL_STOPS.delete(stop);
      stop();
    },
  };
}

function loadExpectations() {
  return readExpectations(EXPECTATIONS_JSON);
}

function skipGrepInvert() {
  const skips = Object.entries(loadExpectations())
    .filter(([, v]) => v.expected === "SKIP")
    .map(([id]) => idGrep(id));
  return skips.length ? `(?:${skips.join("|")})` : null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactGrep(file, title) {
  return `${escapeRe(file)} ${escapeRe(title.replaceAll(" › ", " "))}$`;
}

function onlyGrep(entries) {
  const pats = entries.flatMap((e) => (e.only ?? []).map((t) => exactGrep(e.file, t)));
  return pats.length ? `(?:${pats.join("|")})` : null;
}

function idGrep(id) {
  const [file, ...rest] = id.split("::");
  return exactGrep(file, rest.join("::"));
}

function runPlaywright(wsEndpoint, specFiles, grep, tag) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonOut = join(OUT_DIR, `kitesurf-report-${tag}.json`);
  rmSync(jsonOut, { force: true });
  const cliArgs = [
    "packages/playwright/cli.js",
    "test",
    "--config=tests/kitesurf/playwright.config.ts",
    ...specFiles,
  ];
  const invert = skipGrepInvert();
  if (invert) cliArgs.push("--grep-invert", invert);
  if (grep) cliArgs.push("--grep", grep);
  const r = spawnSync(process.execPath, cliArgs, {
    cwd: PW_DIR,
    stdio: "inherit",
    env: {
      ...process.env,
      NPM_TOKEN: process.env.NPM_TOKEN ?? "",
      PWPAGE_IMPL: "kitesurf",
      KITESURF_WS: wsEndpoint,
      PWTEST_JSON_OUTPUT: jsonOut,
    },
  });
  if (!existsSync(jsonOut)) {
    console.error(`[pw-run] batch ${tag}: no JSON report — runner crashed (exit ${r.status})`);
    return null;
  }
  return collectResults(jsonOut);
}

function collectResults(jsonPath) {
  const report = JSON.parse(readFileSync(jsonPath, "utf8"));
  const out = {};
  const mapStatus = (s) =>
    s === "passed" ? "PASS" : s === "timedOut" ? "TIMEOUT" : s === "skipped" ? "SKIP" : "FAIL";
  const walk = (suite, titles) => {
    for (const child of suite.suites ?? [])
      walk(child, suite.title ? [...titles, suite.title] : titles);
    for (const spec of suite.specs ?? []) {
      const file = spec.file.replace(/\\/g, "/");
      for (const t of spec.tests ?? []) {
        const status = t.results?.length
          ? mapStatus(t.results[t.results.length - 1].status)
          : "SKIP";
        const id = `${file}::${[...titles, spec.title].join(" › ")}`;
        out[id] = status;
      }
    }
  };
  for (const suite of report.suites ?? []) walk(suite, []);
  return out;
}

function deviations(results) {
  return diffExpectations(results, loadExpectations());
}

async function runBatch(batchEntries, batchIdx, externalWs) {
  const label = `b${batchIdx}`;
  const batchFiles = batchEntries.map((e) => e.file);
  const only = onlyGrep(batchEntries);
  const grep = only && userGrep ? `(?=.*(?:${userGrep}))${only}` : (userGrep ?? only);
  let eng = null;
  let ws = externalWs;
  if (!externalWs) {
    eng = await startEngine();
    ws = eng.wsEndpoint;
  }
  console.log(
    `\n[pw-run] batch ${batchIdx}: ${batchFiles.length} file(s)${only ? " (only-selection)" : ""}${eng ? ` on :${eng.port}` : ""}`,
  );
  let results = runPlaywright(ws, batchFiles, grep, label) ?? {};
  eng?.stop();

  if (!noRetry) {
    const devs = deviations(results);
    if (devs.length > 0) {
      const grep = `(?:${devs.map((d) => idGrep(d.id)).join("|")})`;
      const files = [...new Set(devs.map((d) => d.id.split("::")[0]).map(fileToSpecArg))];
      console.log(
        `[pw-run] batch ${batchIdx}: retrying ${devs.length} deviation(s) on a fresh engine`,
      );
      let rEng = null;
      let rWs = externalWs;
      if (!externalWs) {
        rEng = await startEngine();
        rWs = rEng.wsEndpoint;
      }
      const retry = runPlaywright(rWs, files, grep, `${label}r`);
      rEng?.stop();
      if (retry) for (const [id, status] of Object.entries(retry)) results[id] = status;
    }
  }
  return results;
}

function fileToSpecArg(file) {
  return file.split("/").pop();
}

function compare(results) {
  const expectations = loadExpectations();
  const devs = deviations(results);
  if (updateExpectations) {
    writeFileSync(
      EXPECTATIONS_JSON,
      JSON.stringify(rebaseline(expectations, devs), null, 2) + "\n",
    );
    console.log(`[pw-run] rebaselined ${devs.length} expectation(s) → ${EXPECTATIONS_JSON}`);
    return 0;
  }
  console.log(`\n[pw-run] results: ${summarize(results)}`);
  const gaps = userGrep
    ? { emptyFiles: [], missingPins: [] }
    : coverageGaps(results, specs, expectations);
  if (reportGaps("pw-run", { devs, ...gaps })) {
    console.error(
      "[pw-run] if intentional: rerun with --update-expectations and commit the rebaseline separately",
    );
    return 1;
  }
  console.log("[pw-run] all results match expectations");
  return 0;
}

const externalWs = process.env.KITESURF_WS;
if (externalWs) {
  console.log(`[pw-run] attaching to external engine: ${externalWs} (no per-batch restart)`);
} else {
  await buildBundles();
}

const batches = [];
for (const e of specs) {
  const last = batches[batches.length - 1];
  if (e.only || !last || last.length >= batchSize || last.some((x) => x.only)) batches.push([e]);
  else last.push(e);
}
console.log(
  `[pw-run] ${specs.length} spec file(s) → ${batches.length} batch(es) of ${batchSize}${shard ? ` (shard ${shard.k}/${shard.n})` : ""}${noRetry ? " (retry off)" : ""}`,
);

const merged = {};
const batchTimes = [];
for (let b = 0; b < batches.length; b++) {
  const started = Date.now();
  const res = await runBatch(batches[b], b, externalWs);
  for (const [id, status] of Object.entries(res)) merged[id] = status;
  batchTimes.push({ files: batches[b].map((entry) => entry.file), ms: Date.now() - started });
}
if (resultsOut) {
  writeFileSync(
    resultsOut,
    JSON.stringify(
      { files: specs.map((entry) => entry.file), results: merged, batches: batchTimes },
      null,
      1,
    ) + "\n",
  );
}
const verdict = compare(merged);
process.exit(noGate ? 0 : verdict);
