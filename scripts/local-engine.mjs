// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Starts and stops throwaway local engines for the upstream-suite runners (pw-run, pptr-run).

import { existsSync, mkdirSync, openSync, closeSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import net from "node:net";

const ROOT = resolve(import.meta.dirname, "..");
const ENGINE_DIR = resolve(ROOT, "packages/engine");

const MAX_PORT_ALLOCATION_ATTEMPTS = 500;
const ENGINE_HEALTH_POLL_INTERVAL_MS = 300;
const ENGINE_HEALTH_STARTUP_BUDGET_MS = 90_000;
const MINIFLARE_VARS = [
  "KITESURF_ENV:local",
  "KITESURF_RESOURCE_DRAIN_QUIET_TURNS:5",
  "KITESURF_LAG_WATCHDOG:1",
  "KITESURF_OTLP_ENDPOINT:http://localhost:4318/v1/traces",
];

const ALL_STOPS = new Set();
function cleanupAll() {
  for (const s of Array.from(ALL_STOPS)) {
    try {
      s();
    } catch {}
  }
  ALL_STOPS.clear();
}
let cleanupInstalled = false;
function installCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.on("exit", cleanupAll);
  process.on("SIGINT", () => {
    cleanupAll();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanupAll();
    process.exit(143);
  });
}

function isFree(port) {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once("error", () => res(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => res(true)));
  });
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

/** @typedef {{wsEndpoint: string, port: number, stop: () => void}} LocalEngine */
/** @param {{tag: string, launcher: "wrangler" | "miniflare", dist: string, outDir: string, firstPort: number, skipBuildEnv: string}} options @returns {{buildBundles: () => Promise<void>, startEngine: () => Promise<LocalEngine>}} */
export function localEngines({ tag, launcher, dist, outDir, firstPort, skipBuildEnv }) {
  installCleanup();
  let nextPort = firstPort;

  async function allocPort() {
    for (let i = 0; i < MAX_PORT_ALLOCATION_ATTEMPTS; i++) {
      const p = nextPort++;
      if (await isFree(p)) return p;
    }
    throw new Error("no free port found");
  }

  async function buildBundles() {
    if (process.env[skipBuildEnv] === "1" || launcher === "miniflare") return;
    const wasm = resolve(ROOT, "packages/core/pkg/kitesurf_core_bg.wasm");
    if (!existsSync(wasm))
      throw new Error(`core wasm not built — run \`pnpm run build\` first (or ${skipBuildEnv}=1)`);
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
    console.log(`[${tag}] built dom-shim + page-script + page-renderer + worker-script bundles`);
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
            dist,
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
    mkdirSync(outDir, { recursive: true });
    const logPath = join(outDir, `kitesurf-engine-${port}.log`);
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

  return { buildBundles, startEngine };
}
