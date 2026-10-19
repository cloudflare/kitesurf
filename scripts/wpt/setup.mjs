// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const WPT_DIR = resolve(ROOT, ".wpt");
const WPT_REPO = "https://github.com/web-platform-tests/wpt.git";
const REVISION_FILE = resolve(ROOT, "tests", "wpt-revision.json");

const args = process.argv.slice(2);
const update = args.includes("--update");
const force = args.includes("--force");

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    stdio: "inherit",
    cwd: opts.cwd ?? ROOT,
    ...opts,
  });
  if (r.status !== 0) {
    console.error(`[wpt-setup] ${cmd} ${cmdArgs.join(" ")} failed (code ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

function tryRun(cmd, cmdArgs, opts = {}) {
  return spawnSync(cmd, cmdArgs, {
    stdio: "pipe",
    encoding: "utf8",
    cwd: opts.cwd ?? ROOT,
    ...opts,
  });
}

function readPin() {
  const raw = JSON.parse(readFileSync(REVISION_FILE, "utf8"));
  if (!/^[0-9a-f]{40}$/.test(raw.revision ?? "")) {
    console.error(`[wpt-setup] ${REVISION_FILE} has no 40-char revision`);
    process.exit(2);
  }
  return raw;
}

function headSha() {
  const r = tryRun("git", ["rev-parse", "HEAD"], { cwd: WPT_DIR });
  return r.status === 0 ? r.stdout.trim() : null;
}

function fetchRevision(sha) {
  if (!existsSync(WPT_DIR)) {
    run("git", ["init", "--quiet", WPT_DIR]);
    run("git", ["remote", "add", "origin", WPT_REPO], { cwd: WPT_DIR });
  }
  run("git", ["fetch", "--depth=1", "origin", sha], { cwd: WPT_DIR });
  run("git", ["checkout", "--quiet", "--force", "FETCH_HEAD"], { cwd: WPT_DIR });
}

if (force && existsSync(WPT_DIR)) {
  console.log(`[wpt-setup] removing existing ${WPT_DIR}`);
  rmSync(WPT_DIR, { recursive: true, force: true });
}

// Only --update advances the corpus; normal setup restores the tracked revision.
if (update) {
  console.log(`[wpt-setup] bumping the pin to ${WPT_REPO} master tip`);
  if (!existsSync(WPT_DIR)) {
    run("git", ["init", "--quiet", WPT_DIR]);
    run("git", ["remote", "add", "origin", WPT_REPO], { cwd: WPT_DIR });
  }
  run("git", ["fetch", "--depth=1", "origin", "master"], { cwd: WPT_DIR });
  run("git", ["checkout", "--quiet", "--force", "FETCH_HEAD"], { cwd: WPT_DIR });
  const sha = headSha();
  const when = tryRun("git", ["log", "-1", "--format=%cI"], { cwd: WPT_DIR }).stdout.trim();
  const pin = readPin();
  writeFileSync(
    REVISION_FILE,
    JSON.stringify({ ...pin, revision: sha, bumpedAt: when }, null, 2) + "\n",
  );
  console.log(`[wpt-setup] pin rewritten: ${pin.revision} → ${sha}`);
  console.log(`[wpt-setup] commit tests/wpt-revision.json in its OWN MR and rebaseline there`);
} else {
  const pin = readPin();
  const at = headSha();
  if (at === pin.revision) {
    console.log(`[wpt-setup] .wpt/ already at the pinned ${pin.revision.slice(0, 12)}`);
  } else {
    console.log(
      at
        ? `[wpt-setup] .wpt/ is at ${at.slice(0, 12)}, pin wants ${pin.revision.slice(0, 12)} — refetching`
        : `[wpt-setup] fetching pinned revision ${pin.revision.slice(0, 12)} → .wpt/`,
    );
    fetchRevision(pin.revision);
  }
}

const pythonCheck = spawnSync("python3", ["--version"], { stdio: "pipe" });
if (pythonCheck.status !== 0) {
  console.warn("[wpt-setup] WARNING: python3 not found on PATH. wpt serve needs Python 3.9+.");
} else {
  console.log(`[wpt-setup] python3 OK: ${pythonCheck.stdout.toString().trim()}`);
}

console.log("");
console.log("[wpt-setup] next steps:");
console.log("  1. Add WPT hostnames to /etc/hosts (one-time, requires sudo):");
console.log("       cd .wpt && ./wpt make-hosts-file | sudo tee -a /etc/hosts");
console.log("  2. Start the kitesurf dev server in one terminal:");
console.log("       pnpm run dev");
console.log("  3. Start wpt serve in another:");
console.log("       pnpm run wpt:serve");
console.log("  4. Run the test rig:");
console.log("       pnpm run test:wpt");
