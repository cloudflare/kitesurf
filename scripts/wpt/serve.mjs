// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const WPT_DIR = resolve(ROOT, ".wpt");

if (!existsSync(WPT_DIR)) {
  console.error("[wpt-serve] .wpt/ not found. Run `pnpm run wpt:setup` first.");
  process.exit(2);
}

const extraArgs = process.argv.slice(2);
const args = ["wpt", "serve", ...extraArgs];

console.log(`[wpt-serve] python3 ${args.join(" ")}  (cwd: .wpt)`);
const proc = spawn("python3", args, {
  cwd: WPT_DIR,
  stdio: "inherit",
});

proc.on("exit", (code, signal) => {
  if (signal) {
    console.log(`[wpt-serve] exited via ${signal}`);
    process.exit(0);
  }
  process.exit(code ?? 0);
});

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    try {
      proc.kill(sig);
    } catch {}
  });
}
