// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { existsSync, rmSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PPTR_DIR = resolve(ROOT, ".puppeteer");
const PPTR_REPO = "https://github.com/puppeteer/puppeteer.git";
const PATCH_DIR = resolve(ROOT, "scripts/patches/puppeteer");

// Keep in step with the puppeteer-core devDependency.
const PPTR_TAG = "puppeteer-v25.16.0";

const args = process.argv.slice(2);
const force = args.includes("--force");
const skipBuild = args.includes("--skip-build");
const env = { ...process.env, PUPPETEER_SKIP_DOWNLOAD: "1" };

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit", cwd: opts.cwd ?? ROOT, env });
  if (r.status !== 0) {
    console.error(`[pptr-setup] ${cmd} ${cmdArgs.join(" ")} failed (code ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

if (force && existsSync(PPTR_DIR)) {
  console.log(`[pptr-setup] removing existing ${PPTR_DIR}`);
  rmSync(PPTR_DIR, { recursive: true, force: true });
}

if (existsSync(PPTR_DIR)) {
  console.log(`[pptr-setup] .puppeteer/ already exists (use --force to redo)`);
  process.exit(0);
}

const started = Date.now();
console.log(`[pptr-setup] cloning ${PPTR_REPO} @ ${PPTR_TAG} (depth=1) → .puppeteer/`);
run("git", ["clone", "--depth=1", "--branch", PPTR_TAG, "--single-branch", PPTR_REPO, PPTR_DIR]);

const patches = existsSync(PATCH_DIR)
  ? readdirSync(PATCH_DIR)
      .filter((f) => f.endsWith(".patch"))
      .sort()
  : [];
for (const p of patches) {
  console.log(`[pptr-setup] applying ${p}`);
  run("git", ["apply", "--whitespace=nowarn", join(PATCH_DIR, p)], { cwd: PPTR_DIR });
}
if (patches.length === 0) console.log("[pptr-setup] no patches to apply");

if (skipBuild) {
  console.log("[pptr-setup] --skip-build: done (npm ci + build skipped)");
  process.exit(0);
}

console.log("[pptr-setup] npm ci (no browser download)");
run("npm", ["ci"], { cwd: PPTR_DIR });

// The test build pulls in puppeteer, puppeteer-core, browsers and testserver through wireit; the
// mocha runner supplies the custom BDD interface and JSON reporter the specs need.
for (const workspace of ["@puppeteer-test/test", "@puppeteer/mocha-runner"]) {
  console.log(`[pptr-setup] npm run build -w ${workspace}`);
  run("npm", ["run", "build", "--workspace", workspace], { cwd: PPTR_DIR });
}

const seconds = ((Date.now() - started) / 1000).toFixed(0);
console.log(`[pptr-setup] done in ${seconds}s — puppeteer ${PPTR_TAG} ready in .puppeteer/`);
console.log("[pptr-setup] next: pnpm run test:puppeteer");
