// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Run one allow-listed Playwright spec file against a patched upstream checkout and engine dist.

import { spawnSync } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PATCH_DIR = resolve(ROOT, "scripts/patches/playwright");
const USAGE = `usage: node scripts/pw-spec.mjs --spec <file> --dist <engine dist> --out-dir <dir>
       [--pw-base <directory>] [--max-wall-ms <ms>] [--keep-deviations]
--pw-base defaults to KITESURF_PW_BASE or .playwright. The checkout must be built by pw:setup.
It exits 2 when the spec deviates from its expectations after the retry; --keep-deviations
writes the results and exits 0 instead, as rebaselining needs.`;

function parseArgs(argv) {
  const options = { maxWallMs: 600_000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--spec") options.spec = next();
    else if (arg === "--dist") options.dist = resolve(next());
    else if (arg === "--out-dir") options.outDir = resolve(next());
    else if (arg === "--pw-base") options.base = resolve(next());
    else if (arg === "--max-wall-ms") options.maxWallMs = parseInt(next(), 10);
    else if (arg === "--keep-deviations") options.keepDeviations = true;
    else fail(`unknown option ${arg}\n${USAGE}`);
  }
  options.base ??= resolve(process.env.KITESURF_PW_BASE ?? resolve(ROOT, ".playwright"));
  if (!options.spec || !options.dist || !options.outDir)
    fail(`--spec, --dist, and --out-dir are required\n${USAGE}`);
  return options;
}

function fail(message, log) {
  console.error(`[pw-spec] ${message}`);
  if (log && existsSync(log))
    console.error(readFileSync(log, "utf8").split("\n").slice(-60).join("\n"));
  process.exit(2);
}

function checkTag(base) {
  const tag = /const PW_TAG = "v?([^"]+)"/.exec(
    readFileSync(resolve(ROOT, "scripts/pw-setup.mjs"), "utf8"),
  )?.[1];
  const packageFile = resolve(base, "package.json");
  const version = existsSync(packageFile)
    ? JSON.parse(readFileSync(packageFile, "utf8")).version
    : "";
  if (!tag || version !== tag)
    fail(`Playwright checkout at ${base} is ${version || "missing"}, setup pins ${tag}`);
  if (!existsSync(resolve(base, "packages/playwright/cli.js")))
    fail(`${base} is not built; run pnpm run pw:setup`);
}

function overlay(base) {
  const directory = mkdtempSync(join(os.tmpdir(), "pw-"));
  for (const name of readdirSync(base)) {
    if (name === ".git" || name === "test-results") continue;
    if (name === "tests")
      cpSync(resolve(base, name), resolve(directory, name), { recursive: true });
    else symlinkSync(resolve(base, name), resolve(directory, name));
  }
  const patches = readdirSync(PATCH_DIR)
    .filter((file) => file.endsWith(".patch"))
    .sort();
  for (const patch of patches) {
    const result = spawnSync("git", ["apply", "--whitespace=nowarn", resolve(PATCH_DIR, patch)], {
      cwd: directory,
      stdio: "inherit",
      env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(directory) },
    });
    if (result.status !== 0)
      fail(`git apply ${patch} failed (exit ${result.status ?? result.error})`);
  }
  return directory;
}

function main(options) {
  checkTag(options.base);
  mkdirSync(options.outDir, { recursive: true });
  const playwrightDir = overlay(options.base);
  const log = resolve(options.outDir, "pw-run.log");
  const results = resolve(options.outDir, "results.json");
  const fd = openSync(log, "w");
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    [
      resolve(ROOT, "scripts/pw-run.mjs"),
      "--pw-dir",
      playwrightDir,
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
      env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
    },
  );
  closeSync(fd);
  rmSync(playwrightDir, { recursive: true, force: true });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.error?.code === "ETIMEDOUT" || result.signal)
    fail(`pw-run killed after ${seconds}s (${result.signal ?? result.error.code})`, log);
  if (!existsSync(results))
    fail(`pw-run exited ${result.status} after ${seconds}s without results`, log);
  if (result.status !== 0 && options.keepDeviations)
    fail(`pw-run exited ${result.status} after ${seconds}s`, log);
  // Without --keep-deviations pw-run gates its own results; failing keeps a flaky one out of
  // Bazel's cache, so a rerun runs this spec again.
  if (result.status !== 0)
    fail(
      `${options.spec} deviates from tests/pw-expectations.json after its retry. Rebaseline with: ` +
        "bazel run --//bazel:keep_deviations //tests/pw:update_expectations",
      log,
    );
  console.log(
    readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("[pw-run]"))
      .join("\n"),
  );
  console.log(`[pw-spec] ${options.spec} done in ${seconds}s`);
}

main(parseArgs(process.argv.slice(2)));
