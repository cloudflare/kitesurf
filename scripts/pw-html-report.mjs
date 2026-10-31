// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Merge the Playwright shards' blob reports into one HTML report.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const USAGE = `usage: node scripts/pw-html-report.mjs --shards <dir> --out <dir> [--pw-base <directory>]
--shards holds shard_*/test-results/blob/*.zip, as tests/pw's shards write them.
--pw-base defaults to KITESURF_PW_BASE or .playwright. The checkout must be built by pw:setup.`;

function fail(message) {
  console.error(`[pw-html-report] ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--shards") options.shards = resolve(next());
    else if (arg === "--out") options.out = resolve(next());
    else if (arg === "--pw-base") options.base = resolve(next());
    else fail(`unknown option ${arg}\n${USAGE}`);
  }
  options.base ??= resolve(process.env.KITESURF_PW_BASE ?? resolve(ROOT, ".playwright"));
  if (!options.shards || !options.out) fail(`--shards and --out are required\n${USAGE}`);
  return options;
}

// Every shard names its batches b0, b1, ..., so prefix each blob with its shard.
function collectBlobs(shards, directory) {
  let count = 0;
  const names = readdirSync(shards).filter((name) => name.startsWith("shard_"));
  for (const shard of names.sort()) {
    const blobs = join(shards, shard, "test-results", "blob");
    if (!existsSync(blobs)) continue;
    for (const blob of readdirSync(blobs).filter((name) => name.endsWith(".zip"))) {
      copyFileSync(join(blobs, blob), join(directory, `${shard}-${blob}`));
      count++;
    }
  }
  return count;
}

function main(options) {
  const cli = resolve(options.base, "packages/playwright/cli.js");
  if (!existsSync(cli)) fail(`${options.base} is not built; run pnpm run pw:setup`);
  const directory = mkdtempSync(join(os.tmpdir(), "pw-blobs-"));
  const count = collectBlobs(options.shards, directory);
  if (count === 0) fail(`no blob reports under ${options.shards}`);
  // Each shard ran in its own copy of the checkout, so the blobs disagree on rootDir. The base's
  // tests/page holds the same specs, unpatched, which also gives the report its code snippets.
  const config = join(directory, "merge.config.mjs");
  const testDir = resolve(options.base, "tests/page");
  writeFileSync(config, `export default { testDir: ${JSON.stringify(testDir)} };\n`);
  const args = [cli, "merge-reports", "--config", config, "--reporter", "html", "."];
  const result = spawnSync(process.execPath, args, {
    cwd: directory,
    stdio: "inherit",
    env: {
      ...process.env,
      PLAYWRIGHT_HTML_OUTPUT_DIR: options.out,
      PLAYWRIGHT_HTML_OPEN: "never",
      PLAYWRIGHT_HTML_TITLE: "Kitesurf: Playwright tests/page",
    },
  });
  rmSync(directory, { recursive: true, force: true });
  if (result.status !== 0) fail(`merge-reports exited ${result.status ?? result.error}`);
  console.log(`[pw-html-report] merged ${count} blob report(s) into ${options.out}`);
}

main(parseArgs(process.argv.slice(2)));
