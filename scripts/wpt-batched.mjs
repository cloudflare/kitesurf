// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, openSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import net from "node:net";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ROOT,
  TESTS_FILE,
  EXPECT_FILE,
  DEFAULT_WPT_BASE,
  loadJSON,
  rebaseline,
  stringifyAsciiJSON,
  gitShortSha,
  summarize,
  tallySubtests,
  writeReport,
  discoverWptTests,
  isReftestSource,
  green,
  red,
  yellow,
  dim,
  bold,
} from "./wpt-shared.mjs";
import { planRowDisposition } from "./wpt-collateral.mjs";
import { DEFAULT_DIST, prepare as prepareEngineDist } from "./wpt-engine.mjs";

const ENGINE_CWD = resolve(ROOT, "packages/engine");
const EXEC = resolve(ROOT, "scripts/wpt-exec.mjs");

const HELP = `Usage: pnpm run test:wpt [options]   (node scripts/wpt-batched.mjs)

Runs the curated WPT list against -j workerd engines this script starts,
kills and restarts every --batch-size tests. Needs \`pnpm run wpt:serve\`
(or --start-server).

Test selection
  --tests-file <path>       explicit list instead of tests/wpt-tests.json
  --filter <substring>      only tests whose path contains <substring>
  --shard <i/n>             run only shard i of n (1-indexed, round-robin)
  --reftests-only           only tests whose source declares rel=match/mismatch
  --skip-slow               skip tests marked "slow" in expectations
  --force-run-file <path>   exec passthrough: tests exempt from the
                            skip-expected short-circuits (ledger)
  --skip-expected-timeouts  short-circuit expected: "TIMEOUT" tests
  --skip-expected-crashes   short-circuit expected: "CRASH" tests
  --expectations <path>     expectations file to use for this run

Discovery (needs no engine; writes tests/wpt-tests.json and exits)
  --discover <prefix>            enumerate testharness tests under .wpt/<prefix>
  --discover-dry-run             print what would be added, write nothing
  --discover-pattern <regex>     keep only matching paths
  --discover-exclude <regex>     drop matching paths

Execution
  -j, --concurrency <n>     engines per batch, one test lane each (default:
                            CPUs/4, 1..8). Lanes on ONE engine do not scale
                            — the parent isolate serialises them — so each
                            lane gets its own wrangler dev; the next batch's
                            engines boot while this one runs.
  --batch-size <n>          tests per batch, spread over the -j engines
                            (default: derived from RAM at ~45 MB of engine
                            memory growth per test)
  --start <n>               resume from batch n (0-indexed)
  --timeout <ms>            per-test timeout (per-test expectations override)
  --max-total <ms>          hard ceiling on total wall clock (partial run = exit 1)
  --bail                    stop at the first unexpected result
  --port <n>                first engine port (default $KITESURF_PORT or 8787).
                            A run uses port..port+2j-1: engine i of a pass
                            listens on port+i, the pre-booting next pass on
                            port+j+i
  --inspector-port <n>      first inspector port (default 9229 for port 8787,
                            else port+1000); same +i / +j+i layout
  --base <url>              WPT serve base (default ${DEFAULT_WPT_BASE})
  --start-server            also spawn wpt serve, and tear it down at the end
  --no-build                skip the engine prebuild (wasm + in-isolate bundles)
  --engine-launcher <name>  wrangler or miniflare (default: wrangler)
  --engine-dist <dir>       Miniflare dist (default: packages/engine/.wpt-dist)

Output
  --update-expectations     rewrite tests/wpt-expectations.json from actuals
  --slice <name>            tag the history.jsonl row (e.g. "wpt-3")
  --no-record               don't write latest.{md,json} / history.jsonl
  --no-report               don't write report files under .wpt-reports
  --save-diff <dir>         dump test/ref/diff PNGs for failing reftests
  --results-out <path>      compact per-file rollup (the CI gate's input)
  --full-out <path>         full per-subtest report
  --killers-out <path>      tests that took the engine down (JSON array)
  --stalled-out <path>      tests that only starved it, then recovered (JSON array)
  --engine-log-dir <dir>    where each engine's wrangler dev output goes, one
                            ks-dev-batched-<port>.log per port (default /tmp)

Profiling
  WPT_PROFILE=1             stamp a per-phase timing breakdown (media / goto /
                            detect / scrape / reftest steps + the engine's own
                            navigate phases) on every row in --full-out

Exit: 0 all expected · 1 unexpected results · 2 infrastructure failure.
`;

const RSS_GROWTH_MB_PER_TEST = 45;

const MAX_BATCH_PASSES = 3;
const CPUS_PER_ENGINE_LANE = 4;
const MIN_ENGINE_CONCURRENCY = 1;
const MAX_ENGINE_CONCURRENCY = 8;

function defaultConcurrency() {
  return Math.min(
    MAX_ENGINE_CONCURRENCY,
    Math.max(MIN_ENGINE_CONCURRENCY, Math.floor(cpuLimit() / CPUS_PER_ENGINE_LANE)),
  );
}

function readCgroupValue(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function positiveCpuQuota(rawQuota, rawPeriod) {
  const quota = Number(rawQuota);
  const period = Number(rawPeriod);
  if (quota > 0 && period > 0) return quota / period;
  return null;
}

function cgroupV2CpuQuota(raw) {
  if (!raw) return null;
  const [quota, period] = raw.split(/\s+/);
  if (quota === "max") return null;
  return positiveCpuQuota(quota, period);
}

function cgroupV1CpuQuota() {
  return positiveCpuQuota(
    readCgroupValue("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"),
    readCgroupValue("/sys/fs/cgroup/cpu/cpu.cfs_period_us"),
  );
}

function cgroupCpuQuota() {
  const v2 = readCgroupValue("/sys/fs/cgroup/cpu.max");
  if (v2) return cgroupV2CpuQuota(v2);
  return cgroupV1CpuQuota();
}

function cpuLimit() {
  const host =
    typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  const quota = cgroupCpuQuota();
  if (quota === null) return host;
  return Math.max(1, Math.min(host, Math.floor(quota)));
}

const BYTES_PER_MIB = 1048576;

function memoryLimitForRaw(raw, hostMemoryMb) {
  if (raw === "max") return null;
  const bytes = Number(raw);
  if (Number.isFinite(bytes) && bytes > 0 && bytes < 2 ** 53) {
    return Math.min(Math.round(bytes / BYTES_PER_MIB), hostMemoryMb);
  }
  return null;
}

function memoryLimitMb() {
  const hostMemoryMb = Math.round(os.totalmem() / BYTES_PER_MIB);
  for (const path of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    const raw = readCgroupValue(path);
    if (raw === null) continue;
    const limit = memoryLimitForRaw(raw, hostMemoryMb);
    if (limit !== null) return limit;
  }
  return hostMemoryMb;
}

const MEMORY_BUDGET_FRACTION = 0.18;
const MIN_BATCH_MEMORY_BUDGET_MB = 700;
const MAX_BATCH_MEMORY_BUDGET_MB = 4000;
const MIN_TESTS_PER_BATCH = 15;
const MAX_TESTS_PER_BATCH = 100;

function defaultBatchSize() {
  const totalMb = memoryLimitMb();
  const budgetMb = Math.min(
    Math.max(totalMb * MEMORY_BUDGET_FRACTION, MIN_BATCH_MEMORY_BUDGET_MB),
    MAX_BATCH_MEMORY_BUDGET_MB,
  );
  const n = Math.round(budgetMb / RSS_GROWTH_MB_PER_TEST);
  return Math.min(Math.max(n, MIN_TESTS_PER_BATCH), MAX_TESTS_PER_BATCH);
}

function defaultOptions() {
  return {
    batchSize: defaultBatchSize(),
    concurrency: defaultConcurrency(),
    start: 0,
    port: parseInt(process.env.KITESURF_PORT ?? "8787", 10) || 8787,
    build: true,
    engineLauncher: "wrangler",
    engineDist: DEFAULT_DIST,
    passthrough: [],
  };
}

function optionHandlers(o) {
  const values = new Map(
    Object.entries({
      "--batch-size": (value) => (o.batchSize = parseInt(value, 10)),
      "--port": (value) => (o.port = parseInt(value, 10)),
      "--inspector-port": (value) => (o.inspectorPort = parseInt(value, 10)),
      "-j": (value) => (o.concurrency = parseInt(value, 10)),
      "--concurrency": (value) => (o.concurrency = parseInt(value, 10)),
      "--filter": (value) => (o.filter = value),
      "--shard": (value) => (o.shard = value),
      "--start": (value) => (o.start = parseInt(value, 10)),
      "--tests-file": (value) => (o.testsFile = value),
      "--results-out": (value) => (o.resultsOut = value),
      "--full-out": (value) => (o.fullOut = value),
      "--killers-out": (value) => (o.killersOut = value),
      "--stalled-out": (value) => (o.stalledOut = value),
      "--engine-log-dir": (value) => (o.engineLogDir = value),
      "--discover": (value) => (o.discover = value),
      "--discover-pattern": (value) => (o.discoverPattern = value),
      "--discover-exclude": (value) => (o.discoverExclude = value),
      "--slice": (value) => (o.slice = value),
      "--engine-launcher": (value) => (o.engineLauncher = value),
      "--engine-dist": (value) => (o.engineDist = resolve(value)),
      "--max-total": (value) => (o.maxTotal = parseInt(value, 10)),
      "--base": (value) => {
        o.base = value;
        o.passthrough.push("--base", o.base);
      },
      "--timeout": (value) => o.passthrough.push("--timeout", value),
      "--save-diff": (value) => o.passthrough.push("--save-diff", value),
      "--force-run-file": (value) => o.passthrough.push("--force-run-file", value),
      "--expectations": (value) => o.passthrough.push("--expectations", resolve(value)),
    }),
  );
  const flags = new Map(
    Object.entries({
      "--reftests-only": () => (o.reftestsOnly = true),
      "--discover-dry-run": () => (o.discoverDryRun = true),
      "--update-expectations": () => (o.updateExpectations = true),
      "--no-record": () => (o.noRecord = true),
      "--no-report": () => (o.noReport = true),
      "--start-server": () => (o.startServer = true),
      "--no-build": () => (o.build = false),
      "--bail": () => {
        o.bail = true;
        o.passthrough.push("--bail");
      },
      "--skip-slow": () => o.passthrough.push("--skip-slow"),
      "--skip-expected-timeouts": () => o.passthrough.push("--skip-expected-timeouts"),
      "--skip-expected-crashes": () => o.passthrough.push("--skip-expected-crashes"),
    }),
  );
  return { values, flags };
}

function isHelpOption(arg) {
  return arg === "--help" || arg === "-h";
}

function showHelp() {
  console.log(HELP);
  process.exit(0);
}

function reportUnknownOption(arg) {
  console.error(red(`[batched] unknown option: ${arg}`));
  console.error(dim(`[batched] --help for the flag list`));
  process.exit(2);
}

function validateEngineLauncher(o) {
  if (o.engineLauncher === "wrangler" || o.engineLauncher === "miniflare") return;
  console.error(
    red(`[batched] --engine-launcher must be wrangler or miniflare, got ${o.engineLauncher}`),
  );
  process.exit(2);
}

function parseArgs(arr) {
  const o = defaultOptions();
  const { values, flags } = optionHandlers(o);
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    if (isHelpOption(a)) showHelp();
    const valueHandler = values.get(a);
    if (valueHandler) {
      valueHandler(arr[++i]);
      continue;
    }
    const flagHandler = flags.get(a);
    if (flagHandler) {
      flagHandler();
      continue;
    }
    reportUnknownOption(a);
  }
  validateEngineLauncher(o);
  return o;
}
const opts = parseArgs(process.argv.slice(2));
const INSPECTOR_PORT = opts.inspectorPort ?? (opts.port === 8787 ? 9229 : opts.port + 1000);
const wsFor = (port) => `ws://127.0.0.1:${port}/devtools/browser`;
const healthFor = (port) => `http://127.0.0.1:${port}/health`;
const ENGINE_LOG_DIR = opts.engineLogDir ? resolve(opts.engineLogDir) : "/tmp";
mkdirSync(ENGINE_LOG_DIR, { recursive: true });
const devLogFor = (port) => resolve(ENGINE_LOG_DIR, `ks-dev-batched-${port}.log`);
const persistDirFor = (port) => resolve(ENGINE_CWD, ".wrangler", `state-wpt-${port}`);
const WS = wsFor(opts.port);
const WPT_BASE = opts.base ?? DEFAULT_WPT_BASE;
const BATCH_FILE = `/tmp/wpt-batch-${opts.port}.json`;
const BATCH_RESULTS = `/tmp/wpt-batch-results-${opts.port}.json`;
const WPT_LOG = "/tmp/wpt-serve.log";

async function probeHealth(port, ms = 2000) {
  try {
    const ctl = AbortSignal.timeout(ms);
    const r = await fetch(healthFor(port), { signal: ctl });
    return r.ok;
  } catch {
    return false;
  }
}

async function probeWpt(ms = 2000) {
  try {
    const r = await fetch(`${WPT_BASE}/resources/testharness.js`, {
      signal: AbortSignal.timeout(ms),
    });
    return r.ok;
  } catch {
    return false;
  }
}

let setGeneration = 0;
let spareSet = null;
let currentSet = null;

function killChild(child) {
  if (!Number.isFinite(child?.pid) || child.pid <= 1) return;
  // Children are detached process groups so shutdown can stop Wrangler's descendants together.
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
}
function pidsOnPort(port) {
  const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  if (r.status !== 0) return [];
  return r.stdout
    .split("\n")
    .filter((p) => p.trim())
    .map((p) => parseInt(p, 10));
}
function foreignListeners(ports) {
  const held = [];
  for (const port of ports) {
    for (const pid of pidsOnPort(port)) {
      const cmd = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
        encoding: "utf8",
      }).stdout.trim();
      held.push({ port, pid, cmd: cmd.slice(0, 80) });
    }
  }
  return held;
}
function refuseHeldPorts(ports) {
  const held = foreignListeners(ports);
  if (held.length === 0) return false;
  console.error(red(`[batched] port(s) in this run's range are already in use:`));
  for (const h of held) console.error(red(`           :${h.port}  pid ${h.pid}  ${h.cmd}`));
  console.error(
    red(
      `           a run uses ${ports.length} port(s) from ${ports[0]}; stop those processes or pass --port / KITESURF_PORT`,
    ),
  );
  return true;
}
function killSet(set) {
  if (!set) return;
  set.cancelled = true;
  for (const child of set.children.values()) killChild(child);
  set.children.clear();
  if (set === currentSet) currentSet = null;
  if (set === spareSet) spareSet = null;
}
function killWorkerd() {
  killSet(currentSet);
  killSet(spareSet);
}

const PORT_RELEASE_POLL_INTERVAL_MS = 500;
async function waitPortFree(port, deadlineMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    if (pidsOnPort(port).length === 0) return true;
    await sleep(PORT_RELEASE_POLL_INTERVAL_MS);
  }
  return false;
}

function runPrebuild() {
  const t0 = Date.now();
  const r = spawnSync("pnpm", ["--filter", "@kitesurf/engine", "run", "prebuild"], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (r.status !== 0) {
    console.error(red(`[batched] prebuild failed (exit ${r.status}) — aborting`));
    console.error(dim(`[batched] pass --no-build to run against the bundles already on disk`));
    process.exit(2);
  }
  console.log(dim(`[batched] prebuild done in ${Date.now() - t0}ms`));
}

function spawnEngine(set, i, port) {
  const logFd = openSync(devLogFor(port), "w");
  const persistDir = persistDirFor(port);
  // Clear port-scoped state to avoid SQLite contention and stale WAL/cache data.
  rmSync(persistDir, { recursive: true, force: true });
  const inspector = String(INSPECTOR_PORT + set.range + i);
  const child =
    opts.engineLauncher === "miniflare"
      ? spawn(
          process.execPath,
          [
            resolve(ROOT, "scripts/wpt-engine.mjs"),
            "serve",
            "--port",
            String(port),
            "--inspector-port",
            inspector,
            "--dist",
            opts.engineDist,
          ],
          { cwd: ROOT, stdio: ["ignore", logFd, logFd], detached: true, env: process.env },
        )
      : spawn(
          "npx",
          [
            "wrangler",
            "dev",
            "-c",
            "wrangler.jsonc",
            "--port",
            String(port),
            "--inspector-port",
            inspector,
            "--persist-to",
            persistDir,
          ],
          { cwd: ENGINE_CWD, stdio: ["ignore", logFd, logFd], detached: true, env: process.env },
        );
  child.unref();
  set.children.set(port, child);
  return child;
}

const BOOT_BUDGET_MS = 60000;
const ENGINE_BOOT_HEALTH_POLL_INTERVAL_MS = 250;
async function awaitHealthy(port, child, t0) {
  while (Date.now() - t0 < BOOT_BUDGET_MS) {
    if (await probeHealth(port, 2000)) return true;
    if (child.exitCode !== null || child.signalCode) return false;
    await sleep(ENGINE_BOOT_HEALTH_POLL_INTERVAL_MS);
  }
  return false;
}

const BOOT_ATTEMPTS = 3;
let bootRetries = 0;
async function bootEngine(set, i, port, t0) {
  let child = set.children.get(port);
  for (let attempt = 1; ; attempt++) {
    if (await awaitHealthy(port, child, t0)) return true;
    reportBootFailure(port, child, Date.now() - t0, attempt);
    if (attempt >= BOOT_ATTEMPTS) return false;
    killChild(child);
    set.children.delete(port);
    await waitPortFree(port);
    if (set.cancelled) return false;
    bootRetries++;
    set.retries++;
    console.error(
      yellow(
        `[batched] rebooting engine on port ${port} (attempt ${attempt + 1}/${BOOT_ATTEMPTS})`,
      ),
    );
    t0 = Date.now();
    child = spawnEngine(set, i, port);
  }
}

function bootSet(count) {
  const gen = setGeneration++;
  const range = (gen % 2) * opts.concurrency;
  const ports = [];
  for (let i = 0; i < count; i++) {
    const port = opts.port + range + i;
    ports.push(port);
  }
  const set = {
    gen,
    range,
    ports,
    children: new Map(),
    ready: null,
    bootMs: null,
    freeMs: null,
    retries: 0,
    cancelled: false,
  };
  set.ready = initializeBootSet(set, ports);
  return set;
}

async function initializeBootSet(set, ports) {
  const t0 = Date.now();
  const freed = await Promise.all(ports.map((port) => waitPortFree(port)));
  set.freeMs = Date.now() - t0;
  if (!canStartBootSet(set, freed, ports)) return null;
  for (const [index, port] of ports.entries()) spawnEngine(set, index, port);
  const up = await Promise.all(ports.map((port, index) => bootEngine(set, index, port, t0)));
  set.bootMs = Date.now() - t0;
  return up.every(Boolean) ? ports : null;
}

function canStartBootSet(set, freed, ports) {
  return !set.cancelled && freed.every(Boolean) && !refuseHeldPorts(ports);
}

const BOOT_LOG_TAIL_LINES = 60;
function bootChildState(child) {
  if (!child) return "never spawned";
  if (child.exitCode !== null) return `exited ${child.exitCode}`;
  if (child.signalCode) return `killed by ${child.signalCode}`;
  return `still running as pid ${child.pid}`;
}

function reportBootFailure(port, child, bootMs, attempt) {
  const state = bootChildState(child);
  console.error(
    red(
      `[batched] engine on port ${port} failed health after ${bootMs}ms (wrangler ${state}), attempt ${attempt}/${BOOT_ATTEMPTS}; ${devLogFor(port)}:`,
    ),
  );
  reportBootLog(readBootLog(port));
}

function readBootLog(port) {
  try {
    return readFileSync(devLogFor(port), "utf8");
  } catch {
    return null;
  }
}

function reportBootLog(text) {
  if (!text || !text.trim()) {
    console.error(dim("           (log is empty)"));
    return;
  }
  const lines = text.trimEnd().split("\n");
  const tail = lines.slice(-BOOT_LOG_TAIL_LINES);
  if (lines.length > tail.length)
    console.error(dim(`           … ${lines.length - tail.length} earlier line(s) omitted`));
  for (const l of tail) console.error(dim(`           | ${l}`));
}

function acquireEngines() {
  const set = spareSet ?? bootSet(opts.concurrency);
  spareSet = null;
  currentSet = set;
  set.ready.then((ports) => {
    if (ports && currentSet === set && !spareSet) spareSet = bootSet(opts.concurrency);
  });
  return set;
}

let wptChild = null;
const WPT_SERVE_STARTUP_BUDGET_MS = 60_000;
const WPT_SERVE_READY_POLL_INTERVAL_MS = 500;
async function startWptServe() {
  await rejectExistingWptServe();
  spawnWptServe();
  await waitForWptServeReady();
}

async function rejectExistingWptServe() {
  if (!(await probeWpt(1500))) return;
  console.error(
    red(`[batched] --start-server given but wpt serve already responding at ${WPT_BASE}`),
  );
  console.error(red(`          stop it first: pkill -f 'wpt serve'`));
  process.exit(2);
}

function openWptServeLog() {
  try {
    return openSync(WPT_LOG, "w");
  } catch {
    return "ignore";
  }
}

function spawnWptServe() {
  // --start-server force-kills processes using these ports; use only when they are reserved.
  for (const port of WPT_KNOWN_PORTS) killByPort(port);
  const logFd = openWptServeLog();
  wptChild = spawn("pnpm", ["run", "wpt:serve"], {
    cwd: ROOT,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
    detached: true,
  });
  console.log(dim(`[batched] --start-server: spawned wpt serve (log: ${WPT_LOG})`));
}

async function waitForWptServeReady() {
  const deadline = Date.now() + WPT_SERVE_STARTUP_BUDGET_MS;
  while (Date.now() < deadline) {
    const [http, https] = await Promise.all([probeWpt(1500), probeTcp(8443)]);
    if (http && https) {
      console.log(green(`[batched] --start-server: wpt serve ready (pid=${wptChild.pid})`));
      return;
    }
    if (wptChild.exitCode !== null) {
      console.error(
        red(`[batched] wpt serve exited during boot (code=${wptChild.exitCode}); see ${WPT_LOG}`),
      );
      process.exit(2);
    }
    await sleep(WPT_SERVE_READY_POLL_INTERVAL_MS);
  }
  console.error(red(`[batched] --start-server: wpt serve did not come up; see ${WPT_LOG}`));
  stopWptServe();
  process.exit(2);
}

function probeTcp(port) {
  return new Promise((res) => {
    const s = net.createConnection({ host: "127.0.0.1", port, timeout: 1500 });
    s.once("connect", () => {
      s.destroy();
      res(true);
    });
    s.once("error", () => res(false));
    s.once("timeout", () => {
      s.destroy();
      res(false);
    });
  });
}

const WPT_KNOWN_PORTS = [8000, 8001, 8443, 8444, 9000];

function killByPort(port) {
  try {
    spawnSync("sh", ["-c", `lsof -ti:${port} 2>/dev/null | xargs -r kill -9 2>/dev/null`], {
      stdio: "ignore",
    });
  } catch {}
}

function terminateWptServe(child) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
}

function killWptServeProcesses() {
  for (const pattern of ["wpt-serve.mjs", "\\.wpt/"]) {
    try {
      spawnSync("pkill", ["-9", "-f", pattern], { stdio: "ignore" });
    } catch {}
  }
}

function stopWptServe() {
  if (!wptChild) return;
  const child = wptChild;
  console.log(dim(`[batched] --start-server: stopping wpt serve`));
  terminateWptServe(child);
  killWptServeProcesses();
  for (const port of WPT_KNOWN_PORTS) killByPort(port);
  wptChild = null;
}

function readBatchResults() {
  try {
    const doc = JSON.parse(readFileSync(BATCH_RESULTS, "utf8"));
    return {
      results: doc.results || [],
      truncated: !!doc.truncated,
      killedEngine: doc.killedEngine || [],
      stalledEngine: doc.stalledEngine || [],
    };
  } catch {
    return { results: [], truncated: false, killedEngine: [], stalledEngine: [] };
  }
}

function settleBatch(batchIdx, code, resolveBatch) {
  const { results, truncated, killedEngine, stalledEngine } = readBatchResults();
  const unexpected = results
    .filter((result) => result.unexpected)
    .map((result) => ({
      batch: batchIdx,
      test: result.test,
      expected: result.expected,
      actual: result.actual,
      reason: result.reason,
    }));
  resolveBatch({
    code: code ?? 0,
    unexpected,
    ran: results.length,
    results,
    truncated,
    killedEngine,
    stalledEngine,
  });
}

function runBatch(batchIdx, remainingMs, ports) {
  return new Promise((res) => {
    rmSync(BATCH_RESULTS, { force: true });
    const args = [
      EXEC,
      "--tests-file",
      BATCH_FILE,
      "--json-out",
      BATCH_RESULTS,
      ...ports.flatMap((p) => ["--ws", wsFor(p)]),
      "-j",
      String(ports.length),
      ...(remainingMs != null ? ["--max-total", String(Math.max(1, Math.round(remainingMs)))] : []),
      ...opts.passthrough,
    ];
    const child = spawn("node", args, { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
    child.on("exit", (code) => settleBatch(batchIdx, code, res));
  });
}

function applyShard(tests) {
  const m = /^(\d+)\/(\d+)$/.exec(opts.shard);
  if (!m) {
    console.error(
      red(`[batched] --shard expects i/n (1-indexed), got ${JSON.stringify(opts.shard)}`),
    );
    process.exit(2);
  }
  const idx = parseInt(m[1], 10);
  const total = parseInt(m[2], 10);
  if (total < 1 || idx < 1 || idx > total) {
    console.error(red(`[batched] --shard ${opts.shard}: need 1 <= i <= n`));
    process.exit(2);
  }
  const picked = tests.filter((_, i) => i % total === idx - 1);
  console.log(dim(`[batched] --shard ${idx}/${total}: ${tests.length} -> ${picked.length}`));
  return picked;
}

function discoverTests(prefix) {
  try {
    return discoverWptTests(prefix);
  } catch (e) {
    console.error(red(`[batched] discover failed: ${e.message}`));
    process.exit(2);
  }
}

function discoveryFilters() {
  let patternRe = null;
  let excludeRe = null;
  try {
    if (opts.discoverPattern) patternRe = new RegExp(opts.discoverPattern);
    if (opts.discoverExclude) excludeRe = new RegExp(opts.discoverExclude);
  } catch (e) {
    console.error(red(`[batched] bad --discover-pattern / --discover-exclude regex: ${e.message}`));
    process.exit(2);
  }
  return { patternRe, excludeRe };
}

function applyDiscoveryFilters(found, patternRe, excludeRe) {
  const beforeFilter = found.length;
  if (patternRe) found = found.filter((p) => patternRe.test(p));
  if (excludeRe) found = found.filter((p) => !excludeRe.test(p));
  if (patternRe || excludeRe) {
    console.log(dim(`[batched] pattern filter: ${beforeFilter} -> ${found.length}`));
  }
  return found;
}

function writeDiscoveryResults(existing, newOnes) {
  if (newOnes.length === 0) {
    console.log(`[batched] nothing to add.`);
    return;
  }
  console.log(`[batched] first 10 new: ${newOnes.slice(0, 10).join("\n               ")}`);
  if (opts.discoverDryRun) {
    console.log(`[batched] --discover-dry-run: not writing.`);
    return;
  }
  const merged = [...existing, ...newOnes].sort();
  writeFileSync(TESTS_FILE, JSON.stringify(merged, null, 2) + "\n");
  console.log(
    green(`[batched] wrote ${merged.length} tests to ${TESTS_FILE} (+${newOnes.length}).`),
  );
  console.log(dim(`[batched] next: pnpm run test:wpt --update-expectations  # to baseline.`));
}

function runDiscover() {
  const existing = loadJSON(TESTS_FILE, []);
  const existingSet = new Set(existing);
  const found = discoverTests(opts.discover);
  const { patternRe, excludeRe } = discoveryFilters();
  const candidates = applyDiscoveryFilters(found, patternRe, excludeRe);
  const newOnes = candidates.filter((p) => !existingSet.has(p));
  console.log(
    `[batched] --discover ${opts.discover}: ${candidates.length} candidate(s), ${newOnes.length} new`,
  );
  writeDiscoveryResults(existing, newOnes);
}

function applyTestSelection(tests) {
  if (opts.filter) tests = tests.filter((test) => test.includes(opts.filter));
  if (opts.shard) tests = applyShard(tests);
  if (opts.reftestsOnly) {
    const before = tests.length;
    tests = tests.filter(isReftestSource);
    console.log(dim(`[batched] --reftests-only: ${before} -> ${tests.length}`));
  }
  return tests;
}

function requireSelectedTests(tests) {
  if (tests.length > 0) return tests;
  console.error(
    red(
      `[batched] no tests selected${opts.filter ? ` for filter ${JSON.stringify(opts.filter)}` : ""}`,
    ),
  );
  process.exit(2);
}

function selectTests() {
  const listPath = opts.testsFile ? resolve(opts.testsFile) : TESTS_FILE;
  return requireSelectedTests(applyTestSelection(loadJSON(listPath, [])));
}

function refuseRunPorts() {
  const footprint = [];
  for (let i = 0; i < 2 * opts.concurrency; i++) footprint.push(opts.port + i);
  if (refuseHeldPorts(footprint)) process.exit(2);
}

function requireMiniflareDist() {
  if (existsSync(resolve(opts.engineDist, "engine-mf.json"))) return;
  console.error(red(`[batched] Miniflare dist is missing engine-mf.json: ${opts.engineDist}`));
  console.error(
    dim(`[batched] create it with node scripts/wpt-engine.mjs prepare --dist ${opts.engineDist}`),
  );
  process.exit(2);
}

async function prepareMiniflareDist() {
  if (opts.engineLauncher !== "miniflare") return;
  if (opts.build) {
    await prepareEngineDist(opts.engineDist);
    return;
  }
  requireMiniflareDist();
}

function prepareBuild() {
  if (opts.build) runPrebuild();
}

async function requireWptAvailable() {
  if (await probeWpt(3000)) return;
  console.error(red(`[batched] cannot reach ${WPT_BASE}`));
  console.error(red(`          start it with: pnpm run wpt:serve  (or pass --start-server)`));
  console.error(
    red(`          and set up hosts: cd .wpt && ./wpt make-hosts-file | sudo tee -a /etc/hosts`),
  );
  stopWptServe();
  process.exit(2);
}

async function prepareRunner() {
  refuseRunPorts();
  prepareBuild();
  await prepareMiniflareDist();
  if (opts.startServer) await startWptServe();
  await requireWptAvailable();
}

function makeBatches(tests) {
  const batches = [];
  for (let i = 0; i < tests.length; i += opts.batchSize) {
    batches.push(tests.slice(i, i + opts.batchSize));
  }
  return batches;
}

function logBatchPlan(total, batches) {
  console.log(
    `[batched] ${total} tests → ${batches.length} batch(es) of ${opts.batchSize}, engines=${opts.concurrency}, start=${opts.start}`,
  );
  console.log(
    dim(
      `memory limit ${Math.round(memoryLimitMb() / 1024)} GB · ` +
        `budgeting ~${RSS_GROWTH_MB_PER_TEST} MB/test of engine RSS growth → ` +
        `~${Math.round(((opts.batchSize * RSS_GROWTH_MB_PER_TEST) / 1024) * 10) / 10} GB peak growth per batch`,
    ),
  );
}

function createRunState() {
  return {
    allUnexpected: [],
    killedEngine: new Set(),
    stalledEngine: new Set(),
    byFile: {},
    fullByTest: {},
    ranBatches: 0,
    totalRan: 0,
    aborted: false,
    truncated: false,
    runStart: Date.now(),
  };
}

function batchBudget(batches, batchIndex, state) {
  if (opts.maxTotal == null) return { expired: false, remainingMs: null };
  const remainingMs = opts.maxTotal - (Date.now() - state.runStart);
  if (remainingMs <= 0) {
    console.log(
      yellow(
        `[batched] --max-total ${opts.maxTotal}ms reached; ${batches.length - batchIndex} batch(es) not run`,
      ),
    );
    return { expired: true };
  }
  return { expired: false, remainingMs };
}

function stopAfterBatch(batchIndex, batches, state) {
  if (!opts.bail || state.allUnexpected.length === 0) return false;
  console.log(yellow(`[batched] --bail: stopping after batch ${batchIndex + 1}`));
  if (batchIndex + 1 < batches.length) state.truncated = true;
  return true;
}

async function runBatches(batches, state) {
  for (let batchIndex = opts.start; batchIndex < batches.length; batchIndex++) {
    const budget = batchBudget(batches, batchIndex, state);
    if (budget.expired) {
      state.truncated = true;
      break;
    }
    await executeBatch(batchIndex, batches[batchIndex], batches.length, budget.remainingMs, state);
    if (state.aborted) break;
    if (stopAfterBatch(batchIndex, batches, state)) break;
  }
}

function createBatchState(tests) {
  return {
    pending: new Set(tests),
    code: 0,
    ran: 0,
    passesRun: 0,
    unexpected: [],
    shelved: new Map(),
    retriedKillers: new Set(),
  };
}

function logBatchHeader(batchIndex, tests, totalBatches) {
  console.log(
    `\n========== batch ${batchIndex + 1}/${totalBatches} (${tests.length} tests) ==========`,
  );
}

async function executeBatch(batchIndex, tests, totalBatches, remainingMs, state) {
  logBatchHeader(batchIndex, tests, totalBatches);
  const batch = createBatchState(tests);
  await runBatchPasses(batchIndex, batch, remainingMs, state);
  restoreShelvedRows(batchIndex, batch, state);
  if (state.aborted) return;
  reportUnrunTests(batchIndex, batch, state);
  recordCompletedBatch(batchIndex, batch, state);
}

async function runBatchPasses(batchIndex, batch, remainingMs, state) {
  for (let pass = 0; pass < MAX_BATCH_PASSES && batch.pending.size > 0; pass++) {
    batch.passesRun++;
    const keepGoing = await runBatchPass(batchIndex, pass, batch, remainingMs, state);
    if (!keepGoing) break;
  }
}

async function runBatchPass(batchIndex, pass, batch, remainingMs, state) {
  if (pass > 0) {
    console.log(
      yellow(
        `[batched] batch ${batchIndex + 1} pass ${pass + 1}: ${batch.pending.size} test(s) never ran ` +
          `— resuming on a fresh workerd`,
      ),
    );
  }
  const bootT0 = Date.now();
  const set = acquireEngines();
  const ports = await set.ready;
  if (!ports) {
    console.error(`[batched] engine(s) failed health on batch ${batchIndex}. Aborting.`);
    state.aborted = true;
    return false;
  }
  const bootWaitMs = Date.now() - bootT0;
  const attempt = await executeEnginePass(
    batchIndex,
    pass,
    batch,
    remainingMs,
    set,
    ports,
    bootWaitMs,
  );
  batch.code = attempt.code;
  batch.ran += attempt.ran;
  recordEngineIssues(attempt, state);
  recordAttemptRows(batchIndex, pass, batch, attempt, state);
  if (attempt.truncated) state.truncated = true;
  return shouldRunAnotherPass(remainingMs, attempt);
}

async function executeEnginePass(batchIndex, pass, batch, remainingMs, set, ports, bootWaitMs) {
  writeFileSync(BATCH_FILE, JSON.stringify([...batch.pending]));
  const execT0 = Date.now();
  const attempt = await runBatch(batchIndex, pass === 0 ? remainingMs : null, ports);
  const execMs = Date.now() - execT0;
  killSet(set);
  logEnginePass(batchIndex, pass, ports, set, bootWaitMs, execMs, attempt);
  return attempt;
}

function logEnginePass(batchIndex, pass, ports, set, bootWaitMs, execMs, attempt) {
  const perTestMs = attempt.ran ? Math.round(execMs / attempt.ran) : 0;
  console.log(
    dim(
      `[batched] batch ${batchIndex + 1} pass ${pass + 1}: ${ports.length} engine(s), boot ${set.bootMs}ms ` +
        `(${set.freeMs}ms freeing ports; waited ${bootWaitMs}ms` +
        `${set.retries ? `; ${set.retries} reboot(s)` : ""}), exec ${execMs}ms ` +
        `(${attempt.ran} tests, ${perTestMs}ms/test wall)`,
    ),
  );
}

function recordEngineIssues(attempt, state) {
  for (const test of attempt.killedEngine) state.killedEngine.add(test);
  for (const test of attempt.stalledEngine) state.stalledEngine.add(test);
}

function recordAttemptRows(batchIndex, pass, batch, attempt, state) {
  const requeued = new Set();
  const disposition = planRowDisposition({
    results: attempt.results,
    sawDeath: attempt.killedEngine.length > 0,
    lastPass: pass === MAX_BATCH_PASSES - 1,
    retriedKillers: batch.retriedKillers,
  });
  for (const row of disposition.requeue) {
    batch.shelved.set(row.test, row);
    requeued.add(row.test);
  }
  for (const row of disposition.accept) {
    storeAcceptedRow(row, batch, state);
  }
  batch.unexpected.push(...attempt.unexpected.filter((row) => !requeued.has(row.test)));
  if (requeued.size > 0) {
    console.log(
      yellow(
        `[batched] batch ${batchIndex + 1} pass ${pass + 1}: requeueing ${requeued.size} ` +
          `unexpected CRASH/TIMEOUT/ERROR result(s) as engine-death collateral`,
      ),
    );
  }
}

function storeAcceptedRow(row, batch, state) {
  state.byFile[row.test] = compactRow(row);
  state.fullByTest[row.test] = row;
  batch.pending.delete(row.test);
}

function shouldRunAnotherPass(remainingMs, attempt) {
  return !mustStopForBudgetOrBail(remainingMs) && !mustStopAfterEngineDeath(attempt);
}

function mustStopForBudgetOrBail(remainingMs) {
  return remainingMs != null || opts.bail;
}

function mustStopAfterEngineDeath(attempt) {
  return attempt.results.length === 0 && attempt.code !== 2 && attempt.killedEngine.length > 0;
}

function restoreShelvedRow(test, batchIndex, batch, state) {
  const row = batch.shelved.get(test);
  if (!row) return false;
  state.byFile[test] = compactRow(row);
  state.fullByTest[test] = row;
  if (row.unexpected) {
    batch.unexpected.push({
      batch: batchIndex,
      test,
      expected: row.expected,
      actual: row.actual,
      reason: row.reason,
    });
  }
  batch.pending.delete(test);
  return true;
}

function restoreShelvedRows(batchIndex, batch, state) {
  let restored = 0;
  for (const test of [...batch.pending]) {
    if (restoreShelvedRow(test, batchIndex, batch, state)) restored++;
  }
  if (restored > 0) {
    console.log(
      yellow(
        `[batched] batch ${batchIndex + 1}: restored ${restored} shelved row(s) for test(s) that never got a retry`,
      ),
    );
  }
}

function reportUnrunTests(batchIndex, batch, state) {
  if (batch.pending.size === 0) return;
  state.truncated = true;
  console.log(
    red(
      `[batched] batch ${batchIndex + 1}: ${batch.pending.size} test(s) never ran after ${batch.passesRun} pass(es)`,
    ),
  );
}

function recordCompletedBatch(batchIndex, batch, state) {
  state.allUnexpected.push(...batch.unexpected);
  state.totalRan += batch.ran;
  state.ranBatches++;
  console.log(
    `[batched] batch ${batchIndex + 1} exit=${batch.code} ran=${batch.ran} unexpected(batch)=${batch.unexpected.length} unexpected(total)=${state.allUnexpected.length}`,
  );
}

function hasPartialSelection() {
  return Boolean(opts.filter || opts.testsFile || opts.reftestsOnly || opts.shard);
}

function isFullRun(state) {
  if (hasPartialSelection()) return false;
  return opts.start === 0 && !state.truncated && !state.aborted;
}

function runReportOptions(fullRun) {
  return {
    record: fullRun && !opts.noRecord,
    base: WPT_BASE,
    ws: WS,
    commit: process.env.CI_COMMIT_SHORT_SHA || gitShortSha(),
    slice: opts.slice ?? null,
  };
}

function reportHistory(paths, results) {
  if (!paths.historyPath) return;
  const subtests = tallySubtests(results);
  console.log(
    dim(`[batched] latest.{md,json} + history row (${subtests.pass}/${subtests.total} subtests)`),
  );
}

function writeRunReport(results, summary, state) {
  const fullRun = isFullRun(state);
  if (results.length === 0 || opts.noReport) return;
  const paths = writeReport(results, summary, runReportOptions(fullRun));
  console.log(dim(`[batched] report → ${paths.mdPath}`));
  reportHistory(paths, results);
}

function writeRunOutputs(results, summary, state) {
  if (opts.resultsOut) writeConsolidated(opts.resultsOut, state.byFile);
  if (opts.fullOut) writeFull(opts.fullOut, results, summary);
  writeRunReport(results, summary, state);
  if (opts.updateExpectations) updateExpectations(results);
}

function printUnexpectedRows(rows) {
  for (const row of rows) {
    const reason = row.reason ? `  (${row.reason.slice(0, 70)})` : "";
    console.log(`  [b${row.batch}] ${row.test}  ${row.expected}→${row.actual}${reason}`);
  }
}

function printKilledEngine(state) {
  if (state.killedEngine.size === 0) return;
  console.log(
    red(
      `[batched] ${state.killedEngine.size} test(s) took the engine down (each costs a workerd restart):`,
    ),
  );
  for (const test of [...state.killedEngine].sort()) console.log(red(`            ${test}`));
}

function printStalledEngine(state) {
  if (state.stalledEngine.size === 0) return;
  console.log(
    yellow(
      `[batched] ${state.stalledEngine.size} test(s) stalled the engine past the 2s probe but it recovered:`,
    ),
  );
  for (const test of [...state.stalledEngine].sort()) console.log(yellow(`            ${test}`));
}

function printBootRetries() {
  if (bootRetries === 0) return;
  console.log(
    yellow(
      `[batched] ${bootRetries} engine boot(s) failed and were retried (see the attempt reports above)`,
    ),
  );
}

function writeOptionalEngineList(outPath, label, engines) {
  if (!outPath) return;
  const tests = [...engines].sort();
  writeFileSync(resolve(outPath), JSON.stringify(tests, null, 2) + "\n");
  console.log(`[batched] ${label} → ${outPath} (${engines.size})`);
}

function printFinalSummary(batches, state, summary) {
  console.log(`\n========== BATCHED SUMMARY ==========`);
  console.log(
    `[batched] ran ${state.ranBatches}/${batches.length} batches, ${state.totalRan} tests; ${state.allUnexpected.length} unexpected result(s)`,
  );
  console.log(
    dim(
      `[batched] wall clock ${Math.round((Date.now() - state.runStart) / 1000)}s from first batch to summary`,
    ),
  );
  printUnexpectedRows(state.allUnexpected);
  writeFileSync("/tmp/wpt-batched-unexpected.json", JSON.stringify(state.allUnexpected, null, 2));
  console.log(`[batched] full list → /tmp/wpt-batched-unexpected.json`);
  printKilledEngine(state);
  printStalledEngine(state);
  printBootRetries();
  writeOptionalEngineList(opts.killersOut, "engine-killers", state.killedEngine);
  writeOptionalEngineList(opts.stalledOut, "engine-stallers", state.stalledEngine);
  console.log(bold(`[batched] ${summary.expected}/${summary.total} matched expectations`));
}

function hasInfrastructureFailure(state) {
  return state.aborted || state.totalRan === 0;
}

function completionExitCode(state) {
  return state.allUnexpected.length > 0 || state.truncated ? 1 : 0;
}

function exitAfterCleanup(state) {
  killWorkerd();
  stopWptServe();
  if (hasInfrastructureFailure(state)) {
    console.error(
      `[batched] ❌ infrastructure failure (aborted=${state.aborted}, ran ${state.totalRan} tests) — exiting 2.`,
    );
    process.exit(2);
  }
  if (state.truncated) console.log(yellow(`[batched] partial run — exiting non-zero`));
  process.exit(completionExitCode(state));
}

function finishRun(batches, state) {
  const results = Object.values(state.fullByTest);
  const summary = summarize(results);
  writeRunOutputs(results, summary, state);
  printFinalSummary(batches, state, summary);
  exitAfterCleanup(state);
}

async function main() {
  if (opts.discover) {
    runDiscover();
    process.exit(0);
  }
  const tests = selectTests();
  await prepareRunner();
  const batches = makeBatches(tests);
  logBatchPlan(tests.length, batches);
  const state = createRunState();
  await runBatches(batches, state);
  finishRun(batches, state);
}

main();

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    killWorkerd();
    stopWptServe();
    process.exit(130);
  });
}

function updateExpectations(results) {
  const expectations = loadJSON(EXPECT_FILE, {});
  const { next, skipped } = rebaseline(expectations, results);
  writeFileSync(EXPECT_FILE, stringifyAsciiJSON(next));
  console.log(yellow(`[batched] wrote new expectations to ${EXPECT_FILE} — review the diff!`));
  if (skipped > 0)
    console.log(dim(`[batched] kept ${skipped} --skip-slow expectation(s) unchanged`));
}

function countRealSubtests(real) {
  let subPass = 0;
  for (const subtest of real) if (subtest.status === "PASS") subPass++;
  return { subPass, subTotal: real.length };
}

function countReportedSubtests(counts) {
  let subPass = 0;
  let subTotal = 0;
  for (const [status, count] of Object.entries(counts)) {
    subTotal += count;
    if (status === "PASS") subPass += count;
  }
  return { subPass, subTotal };
}

function compactSubtestCounts(row) {
  const real = (row.subtests || []).filter(
    (s) => !(s.name && s.name.includes("synthesized from summary")),
  );
  if (real.length > 0) return countRealSubtests(real);
  if (row.counts) return countReportedSubtests(row.counts);
  return { subPass: 0, subTotal: 0 };
}

function compactRow(row) {
  const { subPass, subTotal } = compactSubtestCounts(row);
  return {
    outcome: row.actual,
    expected: row.expected,
    unexpected: !!row.unexpected,
    subPass,
    subTotal,
  };
}

function countUnexpectedResult(row) {
  if (!row.unexpected) return { fail: 0, pass: 0 };
  if (row.expected !== "PASS" && row.outcome === "PASS") return { fail: 0, pass: 1 };
  return { fail: 1, pass: 0 };
}

function incrementOutcome(byOutcome, outcome) {
  byOutcome[outcome] = (byOutcome[outcome] || 0) + 1;
}

function commitSha() {
  return (process.env.CI_COMMIT_SHORT_SHA || gitShortSha()).trim();
}

function currentRef() {
  return process.env.CI_COMMIT_BRANCH || process.env.CI_COMMIT_REF_NAME || "local";
}

function writeConsolidated(outPath, byFile) {
  const byOutcome = {};
  let unexpectedFail = 0;
  let unexpectedPass = 0;
  for (const row of Object.values(byFile)) {
    incrementOutcome(byOutcome, row.outcome);
    const unexpected = countUnexpectedResult(row);
    unexpectedFail += unexpected.fail;
    unexpectedPass += unexpected.pass;
  }
  const total = Object.keys(byFile).length;
  const commit = commitSha();
  const doc = {
    commit: commit || null,
    date: new Date().toISOString(),
    ref: currentRef(),
    summary: {
      total,
      expected: total - unexpectedFail - unexpectedPass,
      unexpectedFail,
      unexpectedPass,
      byOutcome,
    },
    byFile,
  };
  writeFileSync(resolve(outPath), JSON.stringify(doc, null, 2) + "\n");
  console.log(`[batched] consolidated results → ${outPath} (${total} files)`);
}

function writeFull(outPath, results, summary) {
  const commit = commitSha();
  const doc = {
    date: new Date().toISOString(),
    base: WPT_BASE,
    ws: WS,
    commit: commit || null,
    slice: "ci-full",
    summary,
    results,
  };
  writeFileSync(resolve(outPath), JSON.stringify(doc, null, 2) + "\n");
  console.log(`[batched] full report \u2192 ${outPath} (${results.length} tests)`);
}
