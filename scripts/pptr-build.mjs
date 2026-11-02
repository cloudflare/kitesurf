// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Patch and rebuild Puppeteer's test project once, for every spec action to copy.

import { spawnSync } from "node:child_process";
import { cpSync, readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { checkoutBase, checkoutProblem, overlay } from "./pptr-checkout.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const PATCH_DIR = resolve(ROOT, "scripts/patches/puppeteer");
const USAGE = `usage: node scripts/pptr-build.mjs --out-dir <dir> [--pptr-base <directory>]
--pptr-base defaults to KITESURF_PPTR_BASE or .puppeteer. The checkout must be built by
pptr:setup, without its patches. The output is its patched, built test/ without node_modules.`;

function fail(message) {
  console.error(`[pptr-build] ${message}`);
  process.exit(2);
}

function run(command, args, cwd, what) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(cwd) },
  });
  if (result.status !== 0) fail(`${what} failed (exit ${result.status ?? result.error})`);
}

function main(argv) {
  const index = argv.indexOf("--out-dir");
  const outDir = index >= 0 ? resolve(argv[index + 1]) : null;
  if (!outDir) fail(`--out-dir is required\n${USAGE}`);
  const base = checkoutBase(argv);
  const problem = checkoutProblem(base);
  if (problem) fail(problem);
  const started = Date.now();
  const directory = overlay(base);
  cpSync(resolve(base, "test"), resolve(directory, "test"), {
    recursive: true,
    preserveTimestamps: true,
  });
  const patches = readdirSync(PATCH_DIR)
    .filter((file) => file.endsWith(".patch"))
    .sort();
  for (const patch of patches)
    run("git", ["apply", "--whitespace=nowarn", resolve(PATCH_DIR, patch)], directory, patch);
  const tsc = resolve(directory, "node_modules/typescript/bin/tsc");
  run(process.execPath, [tsc, "-b", "test"], directory, "tsc -b test");
  const test = resolve(directory, "test");
  cpSync(test, outDir, {
    recursive: true,
    preserveTimestamps: true,
    filter: (source) => source !== resolve(test, "node_modules"),
  });
  rmSync(directory, { recursive: true, force: true });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[pptr-build] ${patches.length} patch(es) applied, test/ built in ${seconds}s`);
}

main(process.argv.slice(2));
