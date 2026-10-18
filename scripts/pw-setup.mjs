// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { existsSync, rmSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PW_DIR = resolve(ROOT, ".playwright");
const PW_REPO = "https://github.com/microsoft/playwright.git";
const PATCH_DIR = resolve(ROOT, "scripts/patches/playwright");

const PW_TAG = "v1.62.0";

const args = process.argv.slice(2);
const force = args.includes("--force");
const skipBuild = args.includes("--skip-build");

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    stdio: "inherit",
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, NPM_TOKEN: process.env.NPM_TOKEN ?? "" },
  });
  if (r.status !== 0) {
    console.error(`[pw-setup] ${cmd} ${cmdArgs.join(" ")} failed (code ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

if (force && existsSync(PW_DIR)) {
  console.log(`[pw-setup] removing existing ${PW_DIR}`);
  rmSync(PW_DIR, { recursive: true, force: true });
}

if (existsSync(PW_DIR)) {
  console.log(`[pw-setup] .playwright/ already exists (use --force to redo)`);
  process.exit(0);
}

console.log(`[pw-setup] cloning ${PW_REPO} @ ${PW_TAG} (depth=1) → .playwright/`);
run("git", ["clone", "--depth=1", "--branch", PW_TAG, "--single-branch", PW_REPO, PW_DIR]);

const patches = existsSync(PATCH_DIR)
  ? readdirSync(PATCH_DIR)
      .filter((f) => f.endsWith(".patch"))
      .sort()
  : [];
for (const p of patches) {
  console.log(`[pw-setup] applying ${p}`);
  run("git", ["apply", "--whitespace=nowarn", join(PATCH_DIR, p)], { cwd: PW_DIR });
}
if (patches.length === 0) console.log("[pw-setup] no patches to apply");

if (skipBuild) {
  console.log("[pw-setup] --skip-build: done (npm ci + build skipped)");
  process.exit(0);
}

console.log("[pw-setup] npm ci (playwright workspace deps)");
run("npm", ["ci"], { cwd: PW_DIR });

console.log("[pw-setup] npm run build (playwright-core + test runner)");
run("npm", ["run", "build"], { cwd: PW_DIR });

console.log(`[pw-setup] done — playwright ${PW_TAG} ready in .playwright/`);
console.log("[pw-setup] next: pnpm run test:playwright");
