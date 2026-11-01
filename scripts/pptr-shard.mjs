// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Run one Puppeteer shard against a patched upstream checkout and the public engine dist.

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
const PATCH_DIR = resolve(ROOT, "scripts/patches/puppeteer");
const USAGE = `usage: node scripts/pptr-shard.mjs --shard <k>/<n> --dist <engine dist> --out-dir <dir>
       [--pptr-base <directory>] [--max-wall-ms <ms>]
--pptr-base defaults to KITESURF_PPTR_BASE or .puppeteer. The checkout must be built by
pptr:setup, without its patches.`;

function parseArgs(argv) {
  const options = { maxWallMs: 600_000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--shard") options.shard = next();
    else if (arg === "--dist") options.dist = resolve(next());
    else if (arg === "--out-dir") options.outDir = resolve(next());
    else if (arg === "--pptr-base") options.base = resolve(next());
    else if (arg === "--max-wall-ms") options.maxWallMs = parseInt(next(), 10);
    else fail(`unknown option ${arg}\n${USAGE}`);
  }
  options.base ??= resolve(process.env.KITESURF_PPTR_BASE ?? resolve(ROOT, ".puppeteer"));
  if (!options.shard || !options.dist || !options.outDir)
    fail(`--shard, --dist, and --out-dir are required\n${USAGE}`);
  return options;
}

function fail(message, log) {
  console.error(`[pptr-shard] ${message}`);
  if (log && existsSync(log))
    console.error(readFileSync(log, "utf8").split("\n").slice(-60).join("\n"));
  process.exit(2);
}

function checkTag(base) {
  const tag = /const PPTR_TAG = "([^"]+)"/.exec(
    readFileSync(resolve(ROOT, "scripts/pptr-setup.mjs"), "utf8"),
  )?.[1];
  const packageFile = resolve(base, "packages/puppeteer/package.json");
  const version = existsSync(packageFile)
    ? JSON.parse(readFileSync(packageFile, "utf8")).version
    : "";
  if (!tag || tag !== `puppeteer-v${version}`)
    fail(`Puppeteer checkout at ${base} is ${version || "missing"}, setup pins ${tag}`);
  for (const built of ["test/build/mocha-utils.js", "tools/mocha-runner/bin/interface.js"])
    if (!existsSync(resolve(base, built))) fail(`${base} is not built; run pnpm run pptr:setup`);
}

function run(command, args, cwd, what) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(cwd) },
  });
  if (result.status !== 0) fail(`${what} failed (exit ${result.status ?? result.error})`);
}

// The patches change test/src, so the overlay copies test/, patches it and rebuilds only that
// project; everything else links to the read-only checkout.
function overlay(base) {
  const directory = mkdtempSync(join(os.tmpdir(), "pptr-"));
  for (const name of readdirSync(base)) {
    if (name === ".git" || name === "test-results") continue;
    if (name === "test")
      cpSync(resolve(base, name), resolve(directory, name), {
        recursive: true,
        preserveTimestamps: true,
      });
    else symlinkSync(resolve(base, name), resolve(directory, name));
  }
  const patches = readdirSync(PATCH_DIR)
    .filter((file) => file.endsWith(".patch"))
    .sort();
  for (const patch of patches)
    run("git", ["apply", "--whitespace=nowarn", resolve(PATCH_DIR, patch)], directory, patch);
  const tsc = resolve(directory, "node_modules/typescript/bin/tsc");
  run(process.execPath, [tsc, "-b", "test"], directory, "tsc -b test");
  return directory;
}

function main(options) {
  checkTag(options.base);
  mkdirSync(options.outDir, { recursive: true });
  const puppeteerDir = overlay(options.base);
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
      "--shard",
      options.shard,
      "--results-out",
      results,
      "--no-gate",
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
  if (result.status !== 0 || !existsSync(results))
    fail(`pptr-run exited ${result.status} after ${seconds}s without results`, log);
  console.log(
    readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("[pptr-run]"))
      .join("\n"),
  );
  console.log(`[pptr-shard] shard ${options.shard} done in ${seconds}s`);
}

main(parseArgs(process.argv.slice(2)));
