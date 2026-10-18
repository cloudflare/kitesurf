// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Adapt Vitest's sharding and JUnit reporter to the Bazel test environment.

import { spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const args = ["run", ...process.argv.slice(2)];
const total = Number(process.env.TEST_TOTAL_SHARDS ?? 1);
if (total > 1) {
  args.push(`--shard=${Number(process.env.TEST_SHARD_INDEX) + 1}/${total}`);
  closeSync(openSync(process.env.TEST_SHARD_STATUS_FILE, "w"));
}
if (process.env.XML_OUTPUT_FILE)
  args.push(
    "--reporter=default",
    "--reporter=junit",
    `--outputFile.junit=${process.env.XML_OUTPUT_FILE}`,
  );
const require = createRequire(join(process.cwd(), "package.json"));
const cli = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const result = spawnSync(process.execPath, [cli, ...args], { stdio: "inherit" });
process.exit(result.status ?? 1);
