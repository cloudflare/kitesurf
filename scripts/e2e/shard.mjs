// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Run one e2e shard against the engine and fixtures dists built by Bazel.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";

// Under Bazel the shard's inputs (config, test files, node_modules links) sit in the bin tree that
// js_run_binary runs in, while this script runs from its own runfiles tree. Run vitest from the
// inputs, so every module resolves through one tree; two trees load vitest twice.
const ROOT = process.env.BAZEL_BINDIR ? process.cwd() : resolve(import.meta.dirname, "../..");
const ENGINE_DIR = resolve(ROOT, "packages/engine");
const USAGE = `usage: node scripts/e2e/shard.mjs --engine-dist <dir> --fixtures-dist <dir> --out-dir <dir>
       [--max-workers <n>] [--max-wall-ms <ms>] <test file>...`;

function parseArgs(argv) {
  const options = { files: [], maxWorkers: 3, maxWallMs: 900_000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--engine-dist") options.engineDist = resolve(next());
    else if (arg === "--fixtures-dist") options.fixturesDist = resolve(next());
    else if (arg === "--out-dir") options.outDir = resolve(next());
    else if (arg === "--max-workers") options.maxWorkers = parseInt(next(), 10);
    else if (arg === "--max-wall-ms") options.maxWallMs = parseInt(next(), 10);
    else if (arg.startsWith("--")) fail(`unknown option ${arg}\n${USAGE}`);
    else options.files.push(arg);
  }
  if (!options.engineDist || !options.fixturesDist || !options.outDir || !options.files.length) {
    fail(`engine/fixtures dists, --out-dir, and test files are required\n${USAGE}`);
  }
  return options;
}

function fail(message, log) {
  console.error(`[e2e-shard] ${message}`);
  if (log && existsSync(log))
    console.error(readFileSync(log, "utf8").split("\n").slice(-80).join("\n"));
  process.exit(2);
}

function main(options) {
  mkdirSync(options.outDir, { recursive: true });
  const report = resolve(options.outDir, "report.json");
  const log = resolve(options.outDir, "vitest.log");
  const require = createRequire(resolve(ENGINE_DIR, "package.json"));
  const vitestPackage = require.resolve("vitest/package.json");
  const vitest = resolve(
    dirname(vitestPackage),
    JSON.parse(readFileSync(vitestPackage, "utf8")).bin.vitest,
  );
  const fd = openSync(log, "w");
  const started = Date.now();
  // Relative filters, because vitest matches them as substrings of the paths it discovers. A local
  // sandbox links its inputs into the execroot, so those resolve outside ENGINE_DIR; an absolute
  // filter under ENGINE_DIR would match nothing there.
  const filters = options.files;
  const result = spawnSync(
    process.execPath,
    [
      vitest,
      "run",
      "--config",
      "vitest.e2e.config.mts",
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${report}`,
      `--maxWorkers=${options.maxWorkers}`,
      ...filters,
    ],
    {
      cwd: ENGINE_DIR,
      stdio: ["ignore", fd, fd],
      timeout: options.maxWallMs,
      killSignal: "SIGKILL",
      env: {
        ...process.env,
        KS_E2E_ENGINE_DIST: options.engineDist,
        KS_E2E_FIXTURES_DIST: options.fixturesDist,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        // Wrangler logs under the user's config directory by default, which a sandbox may not let
        // an action write.
        WRANGLER_LOG_PATH: resolve(tmpdir(), "kitesurf-e2e-wrangler-logs"),
      },
    },
  );
  closeSync(fd);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.error?.code === "ETIMEDOUT" || result.signal)
    fail(`vitest killed after ${seconds}s (${result.signal ?? result.error.code})`, log);
  if (![0, 1].includes(result.status) || !existsSync(report))
    fail(`vitest exited ${result.status} after ${seconds}s without a report`, log);
  // Match by the path under packages/engine/, for the same reason as the filters.
  const ranNames = JSON.parse(readFileSync(report, "utf8")).testResults.map((test) =>
    test.name.split(sep).join("/"),
  );
  const missing = options.files.filter(
    (file) => !ranNames.some((name) => name.endsWith(`/packages/engine/${file}`)),
  );
  if (missing.length) fail(`vitest skipped ${missing.length} file(s): ${missing.join(", ")}`, log);
  writeFileSync(
    resolve(options.outDir, "shard.json"),
    JSON.stringify(
      { exit: result.status, seconds: Number(seconds), files: options.files },
      null,
      1,
    ) + "\n",
  );
  console.log(
    readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => /^\s*(Test Files|Tests|Duration)\s/.test(line))
      .join("\n"),
  );
  console.log(
    `[e2e-shard] ${options.files.length} file(s) in ${seconds}s (vitest exit ${result.status})`,
  );
}

main(parseArgs(process.argv.slice(2)));
