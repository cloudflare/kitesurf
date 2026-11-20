// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Run one allow-listed Puppeteer spec file against the built test project and the engine dist.

import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { checkoutBase, checkoutProblem, copyWritable, overlay } from "./pptr-checkout.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const USAGE = `usage: node scripts/pptr-spec.mjs --spec <file> --test-project <dir> --dist <engine dist>
       --out-dir <dir> [--pptr-base <directory>] [--max-wall-ms <ms>] [--keep-deviations]
--test-project is pptr-build's output. --pptr-base defaults to KITESURF_PPTR_BASE or .puppeteer,
and must be the checkout pptr-build used. It exits 2 when the spec deviates from its expectations
after the retry; --keep-deviations writes the results and exits 0 instead, as rebaselining needs.`;

function parseArgs(argv) {
  const options = { maxWallMs: 600_000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--spec") options.spec = next();
    else if (arg === "--test-project") options.testProject = resolve(next());
    else if (arg === "--dist") options.dist = resolve(next());
    else if (arg === "--out-dir") options.outDir = resolve(next());
    else if (arg === "--pptr-base") next();
    else if (arg === "--max-wall-ms") options.maxWallMs = parseInt(next(), 10);
    else if (arg === "--keep-deviations") options.keepDeviations = true;
    else fail(`unknown option ${arg}\n${USAGE}`);
  }
  options.base = checkoutBase(argv);
  if (!options.spec || !options.testProject || !options.dist || !options.outDir)
    fail(`--spec, --test-project, --dist, and --out-dir are required\n${USAGE}`);
  return options;
}

function fail(message, log) {
  console.error(`[pptr-spec] ${message}`);
  if (log && existsSync(log))
    console.error(readFileSync(log, "utf8").split("\n").slice(-60).join("\n"));
  process.exit(2);
}

// The specs resolve packages from their real path, so test/ is a copy inside the overlay; its
// node_modules, which pptr-build leaves out, links back to the checkout's.
function checkout(options) {
  const directory = overlay(options.base);
  const test = resolve(directory, "test");
  copyWritable(options.testProject, test);
  symlinkSync(resolve(options.base, "test/node_modules"), resolve(test, "node_modules"));
  return directory;
}

function main(options) {
  const problem = checkoutProblem(options.base);
  if (problem) fail(problem);
  mkdirSync(options.outDir, { recursive: true });
  const puppeteerDir = checkout(options);
  const log = resolve(options.outDir, "pptr-run.log");
  const results = resolve(options.outDir, "results.json");
  const fd = openSync(log, "w");
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    [
      resolve(ROOT, "scripts/pptr-run.mjs"),
      "--pptr-dir",
      puppeteerDir,
      "--out-dir",
      resolve(options.outDir, "test-results"),
      "--engine-launcher",
      "miniflare",
      "--dist",
      options.dist,
      "--spec",
      options.spec,
      "--results-out",
      results,
      ...(options.keepDeviations ? ["--no-gate"] : []),
    ],
    {
      stdio: ["ignore", fd, fd],
      timeout: options.maxWallMs,
      killSignal: "SIGTERM",
      env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: "1" },
    },
  );
  closeSync(fd);
  rmSync(puppeteerDir, { recursive: true, force: true });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.error?.code === "ETIMEDOUT" || result.signal)
    fail(`pptr-run killed after ${seconds}s (${result.signal ?? result.error.code})`, log);
  if (!existsSync(results))
    fail(`pptr-run exited ${result.status} after ${seconds}s without results`, log);
  if (result.status !== 0 && options.keepDeviations)
    fail(`pptr-run exited ${result.status} after ${seconds}s`, log);
  // Without --keep-deviations pptr-run gates its own results; failing keeps a flaky one out of
  // Bazel's cache, so a rerun runs this spec again.
  if (result.status !== 0)
    fail(
      `${options.spec} deviates from tests/pptr-expectations.json after its retry. Rebaseline with: ` +
        "bazel run --//bazel:keep_deviations //tests/pptr:update_expectations",
      log,
    );
  console.log(
    readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("[pptr-run]"))
      .join("\n"),
  );
  console.log(`[pptr-spec] ${options.spec} done in ${seconds}s`);
}

main(parseArgs(process.argv.slice(2)));
