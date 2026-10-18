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

function cpuLimit() {
  const host =
    typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  const read = (p) => {
    try {
      return readFileSync(p, "utf8").trim();
    } catch {
      return null;
    }
  };
  let quota = null;
  const v2 = read("/sys/fs/cgroup/cpu.max");
  if (v2) {
    const [q, period] = v2.split(/\s+/);
    if (q !== "max" && Number(q) > 0 && Number(period) > 0) quota = Number(q) / Number(period);
  } else {
    const q = Number(read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"));
    const period = Number(read("/sys/fs/cgroup/cpu/cpu.cfs_period_us"));
    if (q > 0 && period > 0) quota = q / period;
  }
  if (quota === null) return host;
  return Math.max(1, Math.min(host, Math.floor(quota)));
}

const BYTES_PER_MIB = 1048576;

function memoryLimitMb() {
  for (const p of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const raw = readFileSync(p, "utf8").trim();
      if (raw === "max") continue;
      const bytes = Number(raw);
      if (Number.isFinite(bytes) && bytes > 0 && bytes < 2 ** 53) {
        return Math.min(
          Math.round(bytes / BYTES_PER_MIB),
          Math.round(os.totalmem() / BYTES_PER_MIB),
        );
      }
    } catch {}
  }
  return Math.round(os.totalmem() / BYTES_PER_MIB);
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

function parseArgs(arr) {
  const o = {
    batchSize: defaultBatchSize(),
    concurrency: defaultConcurrency(),
    start: 0,
    port: parseInt(process.env.KITESURF_PORT ?? "8787", 10) || 8787,
    build: true,
    engineLauncher: "wrangler",
    engineDist: DEFAULT_DIST,
    passthrough: [],
  };
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    if (a === "--batch-size") o.batchSize = parseInt(arr[++i], 10);
    else if (a === "--port") o.port = parseInt(arr[++i], 10);
    else if (a === "--inspector-port") o.inspectorPort = parseInt(arr[++i], 10);
    else if (a === "-j" || a === "--concurrency") o.concurrency = parseInt(arr[++i], 10);
    else if (a === "--filter") o.filter = arr[++i];
    else if (a === "--shard") o.shard = arr[++i];
    else if (a === "--start") o.start = parseInt(arr[++i], 10);
    else if (a === "--tests-file") o.testsFile = arr[++i];
    else if (a === "--results-out") o.resultsOut = arr[++i];
    else if (a === "--full-out") o.fullOut = arr[++i];
    else if (a === "--killers-out") o.killersOut = arr[++i];
    else if (a === "--stalled-out") o.stalledOut = arr[++i];
    else if (a === "--engine-log-dir") o.engineLogDir = arr[++i];
    else if (a === "--reftests-only") o.reftestsOnly = true;
    else if (a === "--discover") o.discover = arr[++i];
    else if (a === "--discover-dry-run") o.discoverDryRun = true;
    else if (a === "--discover-pattern") o.discoverPattern = arr[++i];
    else if (a === "--discover-exclude") o.discoverExclude = arr[++i];
    else if (a === "--update-expectations") o.updateExpectations = true;
    else if (a === "--slice") o.slice = arr[++i];
    else if (a === "--no-record") o.noRecord = true;
    else if (a === "--no-report") o.noReport = true;
    else if (a === "--start-server") o.startServer = true;
    else if (a === "--no-build") o.build = false;
    else if (a === "--engine-launcher") o.engineLauncher = arr[++i];
    else if (a === "--engine-dist") o.engineDist = resolve(arr[++i]);
    else if (a === "--max-total") o.maxTotal = parseInt(arr[++i], 10);
    else if (a === "--bail") {
      o.bail = true;
      o.passthrough.push("--bail");
    } else if (a === "--base") {
      o.base = arr[++i];
      o.passthrough.push("--base", o.base);
    } else if (a === "--timeout") o.passthrough.push("--timeout", arr[++i]);
    else if (a === "--save-diff") o.passthrough.push("--save-diff", arr[++i]);
    else if (a === "--skip-slow") o.passthrough.push("--skip-slow");
    else if (a === "--skip-expected-timeouts") o.passthrough.push("--skip-expected-timeouts");
    else if (a === "--skip-expected-crashes") o.passthrough.push("--skip-expected-crashes");
    else if (a === "--force-run-file") o.passthrough.push("--force-run-file", arr[++i]);
    else if (a === "--expectations") o.passthrough.push("--expectations", resolve(arr[++i]));
    else if (a === "--help" || a === "-h") {
      console.log(HELP);
      process.exit(0);
    } else {
      console.error(red(`[batched] unknown option: ${a}`));
      console.error(dim(`[batched] --help for the flag list`));
      process.exit(2);
    }
  }
  if (o.engineLauncher !== "wrangler" && o.engineLauncher !== "miniflare") {
    console.error(
      red(`[batched] --engine-launcher must be wrangler or miniflare, got ${o.engineLauncher}`),
    );
    process.exit(2);
  }
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
  set.ready = (async () => {
    const t0 = Date.now();
    const freed = await Promise.all(ports.map((p) => waitPortFree(p)));
    set.freeMs = Date.now() - t0;
    if (set.cancelled || !freed.every(Boolean) || refuseHeldPorts(ports)) return null;
    for (const [i, port] of ports.entries()) spawnEngine(set, i, port);
    const up = await Promise.all(ports.map((port, i) => bootEngine(set, i, port, t0)));
    set.bootMs = Date.now() - t0;
    return up.every(Boolean) ? ports : null;
  })();
  return set;
}

const BOOT_LOG_TAIL_LINES = 60;
function reportBootFailure(port, child, bootMs, attempt) {
  const state = !child
    ? "never spawned"
    : child.exitCode !== null
      ? `exited ${child.exitCode}`
      : child.signalCode
        ? `killed by ${child.signalCode}`
        : `still running as pid ${child.pid}`;
  console.error(
    red(
      `[batched] engine on port ${port} failed health after ${bootMs}ms (wrangler ${state}), attempt ${attempt}/${BOOT_ATTEMPTS}; ${devLogFor(port)}:`,
    ),
  );
  let text = null;
  try {
    text = readFileSync(devLogFor(port), "utf8");
  } catch {}
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
  if (await probeWpt(1500)) {
    console.error(
      red(`[batched] --start-server given but wpt serve already responding at ${WPT_BASE}`),
    );
    console.error(red(`          stop it first: pkill -f 'wpt serve'`));
    process.exit(2);
  }
  // --start-server force-kills processes using these ports; use only when they are reserved.
  for (const port of WPT_KNOWN_PORTS) killByPort(port);

  const logFd = (() => {
    try {
      return openSync(WPT_LOG, "w");
    } catch {
      return "ignore";
    }
  })();
  wptChild = spawn("pnpm", ["run", "wpt:serve"], {
    cwd: ROOT,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
    detached: true,
  });
  console.log(dim(`[batched] --start-server: spawned wpt serve (log: ${WPT_LOG})`));
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

function stopWptServe() {
  if (!wptChild) return;
  console.log(dim(`[batched] --start-server: stopping wpt serve`));
  if (wptChild.pid && wptChild.exitCode === null) {
    try {
      process.kill(-wptChild.pid, "SIGTERM");
    } catch {}
  }
  try {
    spawnSync("pkill", ["-9", "-f", "wpt-serve.mjs"], { stdio: "ignore" });
  } catch {}
  try {
    spawnSync("pkill", ["-9", "-f", "\\.wpt/"], { stdio: "ignore" });
  } catch {}
  for (const port of WPT_KNOWN_PORTS) killByPort(port);
  wptChild = null;
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
    child.on("exit", (code) => {
      let results = [];
      let truncated = false;
      let killedEngine = [];
      let stalledEngine = [];
      try {
        const doc = JSON.parse(readFileSync(BATCH_RESULTS, "utf8"));
        results = doc.results || [];
        truncated = !!doc.truncated;
        killedEngine = doc.killedEngine || [];
        stalledEngine = doc.stalledEngine || [];
      } catch {}
      const unexpected = results
        .filter((x) => x.unexpected)
        .map((x) => ({
          batch: batchIdx,
          test: x.test,
          expected: x.expected,
          actual: x.actual,
          reason: x.reason,
        }));
      res({
        code: code ?? 0,
        unexpected,
        ran: results.length,
        results,
        truncated,
        killedEngine,
        stalledEngine,
      });
    });
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

function runDiscover() {
  const existing = loadJSON(TESTS_FILE, []);
  const existingSet = new Set(existing);
  let found;
  try {
    found = discoverWptTests(opts.discover);
  } catch (e) {
    console.error(red(`[batched] discover failed: ${e.message}`));
    process.exit(2);
  }
  let patternRe = null;
  let excludeRe = null;
  try {
    if (opts.discoverPattern) patternRe = new RegExp(opts.discoverPattern);
    if (opts.discoverExclude) excludeRe = new RegExp(opts.discoverExclude);
  } catch (e) {
    console.error(red(`[batched] bad --discover-pattern / --discover-exclude regex: ${e.message}`));
    process.exit(2);
  }
  const beforeFilter = found.length;
  if (patternRe) found = found.filter((p) => patternRe.test(p));
  if (excludeRe) found = found.filter((p) => !excludeRe.test(p));
  if (patternRe || excludeRe) {
    console.log(dim(`[batched] pattern filter: ${beforeFilter} -> ${found.length}`));
  }
  const newOnes = found.filter((p) => !existingSet.has(p));
  console.log(
    `[batched] --discover ${opts.discover}: ${found.length} candidate(s), ${newOnes.length} new`,
  );
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

(async () => {
  if (opts.discover) {
    runDiscover();
    process.exit(0);
  }

  let tests = loadJSON(opts.testsFile ? resolve(opts.testsFile) : TESTS_FILE, []);
  if (opts.filter) tests = tests.filter((t) => t.includes(opts.filter));
  if (opts.shard) tests = applyShard(tests);
  if (opts.reftestsOnly) {
    const before = tests.length;
    tests = tests.filter(isReftestSource);
    console.log(dim(`[batched] --reftests-only: ${before} -> ${tests.length}`));
  }
  if (tests.length === 0) {
    console.error(
      red(
        `[batched] no tests selected${opts.filter ? ` for filter ${JSON.stringify(opts.filter)}` : ""}`,
      ),
    );
    process.exit(2);
  }

  {
    const footprint = [];
    for (let i = 0; i < 2 * opts.concurrency; i++) footprint.push(opts.port + i);
    if (refuseHeldPorts(footprint)) process.exit(2);
  }
  if (opts.build) runPrebuild();
  if (opts.engineLauncher === "miniflare") {
    if (opts.build) await prepareEngineDist(opts.engineDist);
    else if (!existsSync(resolve(opts.engineDist, "engine-mf.json"))) {
      console.error(red(`[batched] Miniflare dist is missing engine-mf.json: ${opts.engineDist}`));
      console.error(
        dim(
          `[batched] create it with node scripts/wpt-engine.mjs prepare --dist ${opts.engineDist}`,
        ),
      );
      process.exit(2);
    }
  }
  if (opts.startServer) await startWptServe();
  if (!(await probeWpt(3000))) {
    console.error(red(`[batched] cannot reach ${WPT_BASE}`));
    console.error(red(`          start it with: pnpm run wpt:serve  (or pass --start-server)`));
    console.error(
      red(`          and set up hosts: cd .wpt && ./wpt make-hosts-file | sudo tee -a /etc/hosts`),
    );
    stopWptServe();
    process.exit(2);
  }

  const total = tests.length;
  const batches = [];
  for (let i = 0; i < total; i += opts.batchSize) batches.push(tests.slice(i, i + opts.batchSize));
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

  const allUnexpected = [];
  const killedEngine = new Set();
  const stalledEngine = new Set();
  const byFile = {};
  const fullByTest = {};
  let ranBatches = 0;
  let totalRan = 0;
  let aborted = false;
  let truncated = false;
  const runStart = Date.now();
  for (let b = opts.start; b < batches.length; b++) {
    let remainingMs = null;
    if (opts.maxTotal != null) {
      remainingMs = opts.maxTotal - (Date.now() - runStart);
      if (remainingMs <= 0) {
        console.log(
          yellow(
            `[batched] --max-total ${opts.maxTotal}ms reached; ${batches.length - b} batch(es) not run`,
          ),
        );
        truncated = true;
        break;
      }
    }
    console.log(
      `\n========== batch ${b + 1}/${batches.length} (${batches[b].length} tests) ==========`,
    );
    const pending = new Set(batches[b]);
    let code = 0;
    let ran = 0;
    let passesRun = 0;
    const unexpected = [];
    const shelved = new Map();
    const retriedKillers = new Set();
    for (let pass = 0; pass < MAX_BATCH_PASSES && pending.size > 0; pass++) {
      passesRun++;
      if (pass > 0) {
        console.log(
          yellow(
            `[batched] batch ${b + 1} pass ${pass + 1}: ${pending.size} test(s) never ran ` +
              `— resuming on a fresh workerd`,
          ),
        );
      }
      const lastPass = pass === MAX_BATCH_PASSES - 1;
      const bootT0 = Date.now();
      const set = acquireEngines();
      const ports = await set.ready;
      if (!ports) {
        console.error(`[batched] engine(s) failed health on batch ${b}. Aborting.`);
        aborted = true;
        break;
      }
      const bootWaitMs = Date.now() - bootT0;
      writeFileSync(BATCH_FILE, JSON.stringify([...pending]));
      const execT0 = Date.now();
      const attempt = await runBatch(b, pass === 0 ? remainingMs : null, ports);
      const execMs = Date.now() - execT0;
      killSet(set);
      console.log(
        dim(
          `[batched] batch ${b + 1} pass ${pass + 1}: ${ports.length} engine(s), boot ${set.bootMs}ms ` +
            `(${set.freeMs}ms freeing ports; waited ${bootWaitMs}ms` +
            `${set.retries ? `; ${set.retries} reboot(s)` : ""}), exec ${execMs}ms ` +
            `(${attempt.ran} tests, ${attempt.ran ? Math.round(execMs / attempt.ran) : 0}ms/test wall)`,
        ),
      );
      code = attempt.code;
      ran += attempt.ran;
      for (const t of attempt.killedEngine) killedEngine.add(t);
      for (const t of attempt.stalledEngine) stalledEngine.add(t);
      const sawDeath = attempt.killedEngine.length > 0;
      const requeued = new Set();
      const disposition = planRowDisposition({
        results: attempt.results,
        sawDeath,
        lastPass,
        retriedKillers,
      });
      for (const r of disposition.requeue) {
        shelved.set(r.test, r);
        requeued.add(r.test);
      }
      for (const r of disposition.accept) {
        byFile[r.test] = compactRow(r);
        fullByTest[r.test] = r;
        pending.delete(r.test);
      }
      unexpected.push(...attempt.unexpected.filter((u) => !requeued.has(u.test)));
      if (requeued.size > 0) {
        console.log(
          yellow(
            `[batched] batch ${b + 1} pass ${pass + 1}: requeueing ${requeued.size} ` +
              `unexpected CRASH/TIMEOUT/ERROR result(s) as engine-death collateral`,
          ),
        );
      }
      if (attempt.truncated) truncated = true;
      if (remainingMs != null || opts.bail) break;
      if (attempt.results.length === 0 && attempt.code !== 2 && attempt.killedEngine.length > 0)
        break;
    }
    if (pending.size > 0) {
      let restored = 0;
      for (const t of [...pending]) {
        const r = shelved.get(t);
        if (!r) continue;
        byFile[t] = compactRow(r);
        fullByTest[t] = r;
        if (r.unexpected)
          unexpected.push({
            batch: b,
            test: t,
            expected: r.expected,
            actual: r.actual,
            reason: r.reason,
          });
        pending.delete(t);
        restored++;
      }
      if (restored) {
        console.log(
          yellow(
            `[batched] batch ${b + 1}: restored ${restored} shelved row(s) for test(s) that never got a retry`,
          ),
        );
      }
    }
    if (aborted) break;
    if (pending.size > 0) {
      truncated = true;
      console.log(
        red(
          `[batched] batch ${b + 1}: ${pending.size} test(s) never ran after ${passesRun} pass(es)`,
        ),
      );
    }
    allUnexpected.push(...unexpected);
    totalRan += ran;
    ranBatches++;
    console.log(
      `[batched] batch ${b + 1} exit=${code} ran=${ran} unexpected(batch)=${unexpected.length} unexpected(total)=${allUnexpected.length}`,
    );
    if (opts.bail && allUnexpected.length > 0) {
      console.log(yellow(`[batched] --bail: stopping after batch ${b + 1}`));
      if (b + 1 < batches.length) truncated = true;
      break;
    }
  }

  const results = Object.values(fullByTest);
  const summary = summarize(results);
  if (opts.resultsOut) writeConsolidated(opts.resultsOut, byFile);
  if (opts.fullOut) writeFull(opts.fullOut, results, summary);
  // Partial, filtered, resumed, or sharded runs are not full-run trend samples.
  const isFullRun =
    !opts.filter &&
    !opts.testsFile &&
    !opts.reftestsOnly &&
    !opts.shard &&
    opts.start === 0 &&
    !truncated &&
    !aborted;
  if (results.length > 0 && !opts.noReport) {
    const paths = writeReport(results, summary, {
      record: isFullRun && !opts.noRecord,
      base: WPT_BASE,
      ws: WS,
      commit: process.env.CI_COMMIT_SHORT_SHA || gitShortSha(),
      slice: opts.slice ?? null,
    });
    console.log(dim(`[batched] report → ${paths.mdPath}`));
    if (paths.historyPath) {
      const sub = tallySubtests(results);
      console.log(
        dim(`[batched] latest.{md,json} + history row (${sub.pass}/${sub.total} subtests)`),
      );
    }
  }
  if (opts.updateExpectations) updateExpectations(results);

  console.log(`\n========== BATCHED SUMMARY ==========`);
  console.log(
    `[batched] ran ${ranBatches}/${batches.length} batches, ${totalRan} tests; ${allUnexpected.length} unexpected result(s)`,
  );
  console.log(
    dim(
      `[batched] wall clock ${Math.round((Date.now() - runStart) / 1000)}s from first batch to summary`,
    ),
  );
  for (const u of allUnexpected)
    console.log(
      `  [b${u.batch}] ${u.test}  ${u.expected}→${u.actual}${u.reason ? "  (" + u.reason.slice(0, 70) + ")" : ""}`,
    );
  writeFileSync("/tmp/wpt-batched-unexpected.json", JSON.stringify(allUnexpected, null, 2));
  console.log(`[batched] full list → /tmp/wpt-batched-unexpected.json`);
  if (killedEngine.size > 0) {
    console.log(
      red(
        `[batched] ${killedEngine.size} test(s) took the engine down (each costs a workerd restart):`,
      ),
    );
    for (const t of [...killedEngine].sort()) console.log(red(`            ${t}`));
  }
  if (stalledEngine.size > 0) {
    console.log(
      yellow(
        `[batched] ${stalledEngine.size} test(s) stalled the engine past the 2s probe but it recovered:`,
      ),
    );
    for (const t of [...stalledEngine].sort()) console.log(yellow(`            ${t}`));
  }
  if (bootRetries > 0) {
    console.log(
      yellow(
        `[batched] ${bootRetries} engine boot(s) failed and were retried (see the attempt reports above)`,
      ),
    );
  }
  if (opts.killersOut) {
    writeFileSync(
      resolve(opts.killersOut),
      JSON.stringify([...killedEngine].sort(), null, 2) + "\n",
    );
    console.log(`[batched] engine-killers → ${opts.killersOut} (${killedEngine.size})`);
  }
  if (opts.stalledOut) {
    writeFileSync(
      resolve(opts.stalledOut),
      JSON.stringify([...stalledEngine].sort(), null, 2) + "\n",
    );
    console.log(`[batched] engine-stallers → ${opts.stalledOut} (${stalledEngine.size})`);
  }
  console.log(bold(`[batched] ${summary.expected}/${summary.total} matched expectations`));
  killWorkerd();
  stopWptServe();
  if (aborted || totalRan === 0) {
    console.error(
      `[batched] ❌ infrastructure failure (aborted=${aborted}, ran ${totalRan} tests) — exiting 2.`,
    );
    process.exit(2);
  }
  if (truncated) console.log(yellow(`[batched] partial run — exiting non-zero`));
  process.exit(allUnexpected.length > 0 || truncated ? 1 : 0);
})();

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

function compactRow(r) {
  let subPass = 0;
  let subTotal = 0;
  const real = (r.subtests || []).filter(
    (s) => !(s.name && s.name.includes("synthesized from summary")),
  );
  if (real.length > 0) {
    subTotal = real.length;
    for (const s of real) if (s.status === "PASS") subPass++;
  } else if (r.counts) {
    for (const [k, v] of Object.entries(r.counts)) {
      subTotal += v;
      if (k === "PASS") subPass += v;
    }
  }
  return {
    outcome: r.actual,
    expected: r.expected,
    unexpected: !!r.unexpected,
    subPass,
    subTotal,
  };
}

function writeConsolidated(outPath, byFile) {
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
  const commit = (process.env.CI_COMMIT_SHORT_SHA || gitShortSha()).trim();
  const doc = {
    commit: commit || null,
    date: new Date().toISOString(),
    ref: process.env.CI_COMMIT_BRANCH || process.env.CI_COMMIT_REF_NAME || "local",
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
  const commit = (process.env.CI_COMMIT_SHORT_SHA || gitShortSha()).trim();
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
