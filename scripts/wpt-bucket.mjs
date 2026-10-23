// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Run one WPT bucket with its own wpt serve and Miniflare engine set.

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = resolve(import.meta.dirname, "..");
const USAGE =
  "usage: node scripts/wpt-bucket.mjs --tests <json> --expectations <json> --dist <engine dist> --out-dir <dir> [--wpt-dir <dir>] [-j <engines>] [--draw]";
const WPT_PORTS = [8000, 8443];
const EXIT_GRACE_MS = 30_000;
const PORT_RELEASE_MS = 15_000;

function parseArgs(argv) {
  const options = { engines: 2, port: 18787, attemptMs: 180_000, maxWallMs: 600_000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--tests":
        options.tests = resolve(next());
        break;
      case "--dist":
        options.dist = resolve(next());
        break;
      case "--expectations":
        options.expectations = resolve(next());
        break;
      case "--out-dir":
        options.outDir = resolve(next());
        break;
      case "--wpt-dir":
        options.wptDir = resolve(next());
        break;
      case "--hosts-file":
        options.hostsFile = resolve(next());
        break;
      case "--revision-file":
        options.revision = JSON.parse(readFileSync(resolve(next()), "utf8")).revision;
        break;
      case "-j":
        options.engines = parseInt(next(), 10);
        break;
      case "--port":
        options.port = parseInt(next(), 10);
        break;
      case "--attempt-ms":
        options.attemptMs = parseInt(next(), 10);
        break;
      case "--max-wall-ms":
        options.maxWallMs = parseInt(next(), 10);
        break;
      case "--draw":
        options.draw = true;
        break;
      case "--help":
      case "-h":
        console.log(USAGE);
        process.exit(0);
      default:
        fail(`unknown option ${arg}\n${USAGE}`);
    }
  }
  fillOptionDefaults(options);
  requireOptions(options);
  return options;
}

function defaultWptDirectory(options) {
  options.wptDir ??= resolve(process.env.KITESURF_WPT_DIR ?? resolve(ROOT, ".wpt"));
}

function defaultHostsFileFromEnv(options) {
  options.hostsFile ??= process.env.KITESURF_WPT_HOSTS
    ? resolve(process.env.KITESURF_WPT_HOSTS)
    : undefined;
}

function findHostsFile(options) {
  if (!options.hostsFile && existsSync(resolve(options.wptDir, ".hosts")))
    options.hostsFile = resolve(options.wptDir, ".hosts");
}

function fillOptionDefaults(options) {
  defaultWptDirectory(options);
  defaultHostsFileFromEnv(options);
  findHostsFile(options);
}

function requireOptions(options) {
  if (!options.tests || !options.expectations || !options.dist || !options.outDir) {
    fail(`--tests, --expectations, --dist, and --out-dir are required\n${USAGE}`);
  }
}

let drawOut;
const children = new Set();

function track(child) {
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function stopChildren() {
  for (const child of children) stopGroup(child);
}

process.on("exit", stopChildren);
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
]) {
  process.once(signal, () => {
    stopChildren();
    process.exit(code);
  });
}

function fail(message, log) {
  console.error(`[wpt-bucket] ${message}`);
  if (log && existsSync(log))
    console.error(readFileSync(log, "utf8").split("\n").slice(-40).join("\n"));
  if (drawOut) {
    mkdirSync(resolve(drawOut, "logs"), { recursive: true });
    writeFileSync(resolve(drawOut, "results.json"), JSON.stringify({ byFile: {} }) + "\n");
    writeFileSync(
      resolve(drawOut, "run.json"),
      JSON.stringify({ completed: false, error: message }) + "\n",
    );
    process.exit(0);
  }
  process.exit(2);
}

function gitHead(dir) {
  const head = readFileSync(resolve(dir, ".git/HEAD"), "utf8").trim();
  if (!head.startsWith("ref: ")) return head;
  const ref = resolve(dir, ".git", head.slice(5));
  return existsSync(ref) ? readFileSync(ref, "utf8").trim() : "";
}

function corpusRevision(options) {
  const marker = resolve(options.wptDir, ".revision");
  const head = resolve(options.wptDir, ".git/HEAD");
  if (existsSync(marker)) return readFileSync(marker, "utf8").trim();
  if (existsSync(head)) return gitHead(options.wptDir);
  return "";
}

function checkRevision(options) {
  if (!existsSync(resolve(options.wptDir, "wpt"))) fail(`no WPT checkout at ${options.wptDir}`);
  if (!options.revision) return;
  const revision = corpusRevision(options);
  if (revision !== options.revision)
    fail(
      `WPT corpus at ${options.wptDir} is ${revision || "unknown"}, expected ${options.revision}`,
    );
}

function childEnv(options) {
  const env = { ...process.env };
  if (!options.hostsFile) return env;
  const wrapper =
    process.env.NSS_WRAPPER_LIB ??
    ["/usr/lib/x86_64-linux-gnu", "/usr/lib64", "/usr/lib"]
      .map((dir) => resolve(dir, "libnss_wrapper.so"))
      .find((path) => existsSync(path));
  if (!wrapper) fail("a hosts file needs nss_wrapper; set NSS_WRAPPER_LIB");
  env.LD_PRELOAD = [wrapper, env.LD_PRELOAD].filter(Boolean).join(":");
  env.NSS_WRAPPER_HOSTS = options.hostsFile;
  env.RES_OPTIONS = "timeout:1 attempts:1";
  return env;
}

function probeTcp(port) {
  return new Promise((done) => {
    const socket = net.createConnection({ host: "127.0.0.1", port, timeout: 1000 });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
    socket.once("timeout", () => {
      socket.destroy();
      done(false);
    });
  });
}

async function waitPortsFree(ports, label, stop = () => {}) {
  const deadline = Date.now() + PORT_RELEASE_MS;
  while ((await Promise.all(ports.map(probeTcp))).some(Boolean)) {
    if (Date.now() >= deadline) {
      stop();
      fail(`ports ${ports.join("/")} remain occupied before ${label}`);
    }
    await sleep(250);
  }
}

function isRunningChild(child) {
  return child?.pid && child.exitCode === null && child.signalCode === null;
}

function stopGroup(child) {
  if (!isRunningChild(child)) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
}

async function startWptServe(options, env, scratch) {
  await waitPortsFree(WPT_PORTS, "wpt serve");
  const log = resolve(options.outDir, "logs/wpt-serve.log");
  const fd = openSync(log, "w");
  const child = track(
    spawn("python3", ["wpt", "--venv", resolve(scratch, "venv"), "--skip-venv-setup", "serve"], {
      cwd: options.wptDir,
      env,
      stdio: ["ignore", fd, fd],
      detached: true,
    }),
  );
  closeSync(fd);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if ((await Promise.all(WPT_PORTS.map(probeTcp))).every(Boolean)) return child;
    if (child.exitCode !== null) fail(`wpt serve exited with ${child.exitCode}`, log);
    await sleep(250);
  }
  stopGroup(child);
  fail("wpt serve did not bind ports 8000/8443 within 60 seconds", log);
}

function runBatched(options, env, limitMs) {
  const args = [
    resolve(ROOT, "scripts/wpt-batched.mjs"),
    "--tests-file",
    options.tests,
    "--expectations",
    options.expectations,
    "-j",
    String(options.engines),
    "--port",
    String(options.port),
    "--no-build",
    "--no-record",
    "--no-report",
    "--engine-launcher",
    "miniflare",
    "--engine-dist",
    options.dist,
    ...(options.draw ? [] : ["--skip-expected-timeouts", "--skip-expected-crashes"]),
    "--engine-log-dir",
    resolve(options.outDir, "logs"),
    "--results-out",
    resolve(options.outDir, "results.json"),
    "--full-out",
    resolve(options.outDir, "full.json"),
  ];
  return new Promise((done) => {
    const child = track(
      spawn(process.execPath, args, {
        cwd: ROOT,
        env,
        stdio: ["ignore", "inherit", "inherit"],
        detached: true,
      }),
    );
    let finished = false;
    let grace;
    const watchdog = setTimeout(() => {
      console.error(`[wpt-bucket] watchdog: no result after ${limitMs} ms; stopping the bucket`);
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {}
      setTimeout(() => stopGroup(child), 10_000).unref();
    }, limitMs);
    const poll = setInterval(() => {
      if (!existsSync(resolve(options.outDir, "full.json"))) return;
      clearInterval(poll);
      grace = setTimeout(() => {
        finished = true;
        stopGroup(child);
      }, EXIT_GRACE_MS).unref();
    }, 500);
    child.on("exit", (code, signal) => {
      clearTimeout(watchdog);
      clearTimeout(grace);
      clearInterval(poll);
      done({ code: signal ? 2 : (code ?? 2), finished });
    });
  });
}

function readReceivedResults(resultPath) {
  return existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")).byFile : {};
}

function reportMissingTests(listed, missing) {
  if (missing.length)
    console.error(
      `[wpt-bucket] ${missing.length} of ${listed.length} tests have no result, e.g. ${missing[0]}`,
    );
}

function canComplete(code, finished, missing) {
  return (code === 0 || code === 1 || finished) && missing.length === 0;
}

function complete(options, code, finished) {
  const listed = JSON.parse(readFileSync(options.tests, "utf8"));
  const resultPath = resolve(options.outDir, "results.json");
  const received = readReceivedResults(resultPath);
  const missing = listed.filter((test) => !(test in received));
  reportMissingTests(listed, missing);
  return canComplete(code, finished, missing);
}

async function attempt(options, env, scratch, limitMs) {
  for (const file of ["results.json", "full.json"])
    rmSync(resolve(options.outDir, file), { force: true });
  const serve = await startWptServe(options, env, scratch);
  try {
    const ports = Array.from({ length: 2 * options.engines }, (_, index) => options.port + index);
    await waitPortsFree(ports, "engines", () => stopGroup(serve));
    const result = await runBatched(options, env, limitMs);
    return { code: result.code, completed: complete(options, result.code, result.finished) };
  } finally {
    stopGroup(serve);
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.draw) drawOut = options.outDir;
checkRevision(options);
mkdirSync(resolve(options.outDir, "logs"), { recursive: true });
const scratch = mkdtempSync(resolve(os.tmpdir(), "wpt-bucket-"));
const env = childEnv(options);
const started = Date.now();
let result;
try {
  result = await attempt(options, env, scratch, Math.min(options.attemptMs, options.maxWallMs));
  const remaining = options.maxWallMs - (Date.now() - started);
  if (!result.completed && remaining >= 60_000) {
    console.error(
      `[wpt-bucket] attempt one incomplete after ${Date.now() - started} ms; retrying once`,
    );
    const logs = resolve(options.outDir, "logs");
    const previous = resolve(options.outDir, "attempt-1-logs");
    renameSync(logs, previous);
    mkdirSync(logs, { recursive: true });
    renameSync(previous, resolve(logs, "attempt-1"));
    result = { ...(await attempt(options, env, scratch, remaining)), retried: true };
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
const summary = {
  exit: result.code,
  completed: result.completed,
  retried: !!result.retried,
  wallMs: Date.now() - started,
};
writeFileSync(resolve(options.outDir, "run.json"), JSON.stringify(summary) + "\n");
console.log(
  `[wpt-bucket] ${summary.completed ? "completed" : "failed"}: batched exit ${result.code} in ${summary.wallMs} ms${summary.retried ? " (retried)" : ""}`,
);
if (options.draw && !summary.completed)
  writeFileSync(resolve(options.outDir, "results.json"), JSON.stringify({ byFile: {} }) + "\n");
process.exit(summary.completed || options.draw ? 0 : 2);
