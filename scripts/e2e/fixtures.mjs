// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Bundle the test fixtures Worker using its public Wrangler config.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ENGINE_DIR = resolve(import.meta.dirname, "../../packages/engine");
const index = process.argv.indexOf("--outdir");
if (index < 0 || !process.argv[index + 1]) {
  console.error("usage: node scripts/e2e/fixtures.mjs --outdir <dir>");
  process.exit(2);
}
const outdir = resolve(process.argv[index + 1]);
const fromEngine = createRequire(resolve(ENGINE_DIR, "package.json"));
const wranglerPackage = fromEngine.resolve("wrangler/package.json");
const wrangler = resolve(
  dirname(wranglerPackage),
  JSON.parse(readFileSync(wranglerPackage, "utf8")).bin.wrangler,
);
execFileSync(
  process.execPath,
  [
    wrangler,
    "deploy",
    "--dry-run",
    "--config",
    "test/fixtures-worker/wrangler.jsonc",
    "--outdir",
    outdir,
  ],
  {
    cwd: ENGINE_DIR,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  },
);
rmSync(resolve(outdir, "README.md"), { force: true });
const mapFile = resolve(outdir, "index.js.map");
const map = JSON.parse(readFileSync(mapFile, "utf8"));
writeFileSync(mapFile, JSON.stringify({ ...map, sourceRoot: "" }));
