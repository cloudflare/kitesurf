// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Run one e2e test file against the engine and fixtures dists built by Bazel.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";

// Bazel supplies the engine directory in its bin tree, including the external repository prefix.
// Resolve Vitest and its inputs from that same tree so it is loaded only once.
const USAGE = `usage: node scripts/e2e-file.mjs --engine-dist <dir> --fixtures-dist <dir> --out-dir <dir>
       [--engine-dir <dir>] [--max-wall-ms <ms>] <test file>
It runs the file again on a fresh Vitest when it fails, and exits 2 when the retry fails too.`;

function parseArgs(argv) {
  const options = {
    files: [],
    engineDir: resolve(import.meta.dirname, "../packages/engine"),
    maxWallMs: 600_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--engine-dir") options.engineDir = resolve(next());
    else if (arg === "--engine-dist") options.engineDist = resolve(next());
    else if (arg === "--fixtures-dist") options.fixturesDist = resolve(next());
    else if (arg === "--out-dir") options.outDir = resolve(next());
    else if (arg === "--max-wall-ms") options.maxWallMs = parseInt(next(), 10);
    else if (arg.startsWith("--")) fail(`unknown option ${arg}\n${USAGE}`);
    else options.files.push(arg);
  }
  if (!options.engineDist || !options.fixturesDist || !options.outDir) {
    fail(`engine/fixtures dists and --out-dir are required\n${USAGE}`);
  }
  if (options.files.length !== 1) fail(`expected one test file\n${USAGE}`);
  options.file = options.files[0];
  return options;
}

function fail(message, log) {
  console.error(`[e2e-file] ${message}`);
  if (log && existsSync(log))
    console.error(readFileSync(log, "utf8").split("\n").slice(-80).join("\n"));
  process.exit(2);
}

function vitestBin(engineDir) {
  const require = createRequire(resolve(engineDir, "package.json"));
  const manifest = require.resolve("vitest/package.json");
  return resolve(dirname(manifest), JSON.parse(readFileSync(manifest, "utf8")).bin.vitest);
}

/** Run Vitest on the file once; returns its exit status and the seconds it took. */
function attempt(options, vitest, report, log) {
  const fd = openSync(log, "w");
  const started = Date.now();
  // A relative filter, because vitest matches it as a substring of the paths it discovers. A local
  // sandbox links its inputs into the execroot, so those resolve outside ENGINE_DIR; an absolute
  // filter under ENGINE_DIR would match nothing there.
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
      "--maxWorkers=1",
      options.file,
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
  const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
  if (result.error?.code === "ETIMEDOUT" || result.signal)
    fail(`vitest killed after ${seconds}s (${result.signal ?? result.error.code})`, log);
  if (![0, 1].includes(result.status) || !existsSync(report))
    fail(`vitest exited ${result.status} after ${seconds}s without a report`, log);
  // Match by the path under packages/engine/, for the same reason as the filter.
  const ran = JSON.parse(readFileSync(report, "utf8")).testResults.some((test) =>
    test.name.split(sep).join("/").endsWith(`/packages/engine/${options.file}`),
  );
  if (!ran) fail(`vitest did not run ${options.file}`, log);
  return { exit: result.status, seconds };
}

function failures(report) {
  return JSON.parse(readFileSync(report, "utf8")).testResults.flatMap((file) =>
    file.assertionResults
      .filter((test) => test.status === "failed")
      .map((test) => `  FAIL ${test.fullName}`)
      .concat(
        file.status === "failed" && !file.assertionResults.some((t) => t.status === "failed")
          ? [`  FAIL (file) ${String(file.message ?? "").split("\n")[0]}`]
          : [],
      ),
  );
}

function main(options) {
  mkdirSync(options.outDir, { recursive: true });
  const report = resolve(options.outDir, "report.json");
  const log = resolve(options.outDir, "vitest.log");
  const vitest = vitestBin(options.engineDir);
  const attempts = [attempt(options, vitest, report, log)];
  // A failure fails the action, so Bazel caches no flaky result and a rerun runs this file again.
  if (attempts[0].exit !== 0) {
    console.log(`[e2e-file] ${options.file} failed; retrying on a fresh Vitest`);
    console.log(failures(report).join("\n"));
    attempts.push(attempt(options, vitest, report, log));
    if (attempts[1].exit !== 0)
      fail(`${options.file} failed twice:\n${failures(report).join("\n")}`, log);
  }
  const seconds = attempts.reduce((sum, run) => sum + run.seconds, 0);
  writeFileSync(
    resolve(options.outDir, "file.json"),
    JSON.stringify({ file: options.file, seconds, attempts: attempts.length }, null, 1) + "\n",
  );
  console.log(
    readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => /^\s*(Test Files|Tests|Duration)\s/.test(line))
      .join("\n"),
  );
  console.log(`[e2e-file] ${options.file} in ${seconds}s (${attempts.length} attempt(s))`);
}

main(parseArgs(process.argv.slice(2)));
