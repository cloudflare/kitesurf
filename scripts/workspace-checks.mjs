// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// `bazel run //scripts:workspace_checks`: the checks that read every tracked file's contents, run
// on the workspace rather than as Bazel tests, which would need the whole tree as inputs.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const CHECKS = ["check-public-imports.mjs", "check-license-headers.mjs"];

for (const check of CHECKS) {
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, check)], {
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
