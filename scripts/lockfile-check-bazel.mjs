// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Check the public pnpm lockfile against tracked package manifests without running install scripts.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { trackedFiles } from "./tracked-files.mjs";

const root = resolve(import.meta.dirname, "..");
const temp = process.env.TEST_TMPDIR;
const work = join(temp, "workspace");
const manifests = trackedFiles(root, ["package.json", "*/package.json", ":(exclude)vendor/**"]);
for (const file of [".npmrc", "pnpm-lock.yaml", "pnpm-workspace.yaml", ...manifests]) {
  mkdirSync(dirname(join(work, file)), { recursive: true });
  copyFileSync(join(root, file), join(work, file));
}

const pnpm = resolve(dirname(resolve(process.env.PNPM_BIN)), "../package/dist/pnpm.cjs");
const home = join(temp, "home");
const result = spawnSync(
  process.execPath,
  [pnpm, "install", "--frozen-lockfile", "--lockfile-only", "--ignore-scripts", "--offline"],
  {
    cwd: work,
    stdio: "inherit",
    env: {
      ...process.env,
      HOME: home,
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"),
      npm_config_store_dir: join(home, "store"),
    },
  },
);
if (result.signal) console.error(`pnpm died of ${result.signal}`);
process.exit(result.status ?? 1);
