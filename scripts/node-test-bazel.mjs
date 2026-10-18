// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Run node --test with Bazel's JUnit output file when one is requested.

import { spawnSync } from "node:child_process";

const reporters = ["--test-reporter=spec", "--test-reporter-destination=stdout"];
if (process.env.XML_OUTPUT_FILE) {
  reporters.push(
    "--test-reporter=junit",
    `--test-reporter-destination=${process.env.XML_OUTPUT_FILE}`,
  );
}
const result = spawnSync(process.execPath, ["--test", ...reporters, ...process.argv.slice(2)], {
  stdio: "inherit",
});
if (result.signal) console.error(`node --test died of ${result.signal}`);
process.exit(result.status ?? 1);
