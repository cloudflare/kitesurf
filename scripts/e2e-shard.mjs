// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Run one e2e shard against the engine and fixtures dists built by Bazel.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";

// Bazel supplies the engine directory in its bin tree, including the external repository prefix.
// Resolve Vitest and its inputs from that same tree so it is loaded only once.
const USAGE = `usage: node scripts/e2e-shard.mjs --engine-dist <dir> --fixtures-dist <dir> --out-dir <dir>
       [--engine-dir <dir>] [--max-workers <n>] [--max-wall-ms <ms>] <test file>...`;

function parseArgs(argv) {
  const options = {
    files: [],
    engineDir: resolve(import.meta.dirname, "../packages/engine"),
    maxWorkers: 3,
    maxWallMs: 900_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--engine-dir":
        options.engineDir = resolve(next());
        break;
      case "--engine-dist":
        options.engineDist = resolve(next());
        break;
      case "--fixtures-dist":
        options.fixturesDist = resolve(next());
        break;
      case "--out-dir":
        options.outDir = resolve(next());
        break;
      case "--max-workers":
        options.maxWorkers = parseInt(next(), 10);
        break;
      case "--max-wall-ms":
        options.maxWallMs = parseInt(next(), 10);
        break;
      default:
        if (arg.startsWith("--")) fail(`unknown option ${arg}\n${USAGE}`);
        options.files.push(arg);
    }
  }
  validateOptions(options);
  return options;
}

function validateOptions(options) {
  if (!options.engineDist || !options.fixturesDist || !options.outDir || !options.files.length) {
    fail(`engine/fixtures dists, --out-dir, and test files are required\n${USAGE}`);
  }
}

function fail(message, log) {
  console.error(`[e2e-shard] ${message}`);
  if (log && existsSync(log))
    console.error(readFileSync(log, "utf8").split("\n").slice(-80).join("\n"));
  process.exit(2);
}

function resolveVitest(options) {
  const require = createRequire(resolve(options.engineDir, "package.json"));
  const vitestPackage = require.resolve("vitest/package.json");
  return resolve(
    dirname(vitestPackage),
    JSON.parse(readFileSync(vitestPackage, "utf8")).bin.vitest,
  );
}

function runVitest(options, vitest, report, log) {
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
      cwd: options.engineDir,
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
  return { result, seconds };
}

function wasKilled(result) {
  return result.error?.code === "ETIMEDOUT" || result.signal;
}

function hasInvalidVitestResult(result, report) {
  return ![0, 1].includes(result.status) || !existsSync(report);
}

function checkVitestResult(result, seconds, report, log) {
  if (wasKilled(result))
    fail(`vitest killed after ${seconds}s (${result.signal ?? result.error.code})`, log);
  if (hasInvalidVitestResult(result, report))
    fail(`vitest exited ${result.status} after ${seconds}s without a report`, log);
}

function ranNames(report) {
  // Match by the path under packages/engine/, for the same reason as the filters.
  return JSON.parse(readFileSync(report, "utf8")).testResults.map((test) =>
    test.name.split(sep).join("/"),
  );
}

function missingFiles(files, names) {
  return files.filter((file) => !names.some((name) => name.endsWith(`/packages/engine/${file}`)));
}

function checkFilesRan(missing, log) {
  if (missing.length) fail(`vitest skipped ${missing.length} file(s): ${missing.join(", ")}`, log);
}

function writeShard(options, result, seconds) {
  writeFileSync(
    resolve(options.outDir, "shard.json"),
    JSON.stringify(
      { exit: result.status, seconds: Number(seconds), files: options.files },
      null,
      1,
    ) + "\n",
  );
}

function printVitestLog(log) {
  console.log(
    readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => /^\s*(Test Files|Tests|Duration)\s/.test(line))
      .join("\n"),
  );
}

function main(options) {
  mkdirSync(options.outDir, { recursive: true });
  const report = resolve(options.outDir, "report.json");
  const log = resolve(options.outDir, "vitest.log");
  const vitest = resolveVitest(options);
  const { result, seconds } = runVitest(options, vitest, report, log);
  checkVitestResult(result, seconds, report, log);
  checkFilesRan(missingFiles(options.files, ranNames(report)), log);
  writeShard(options, result, seconds);
  printVitestLog(log);
  console.log(
    `[e2e-shard] ${options.files.length} file(s) in ${seconds}s (vitest exit ${result.status})`,
  );
}

main(parseArgs(process.argv.slice(2)));
