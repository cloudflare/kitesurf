// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { ROOT, sourceFiles } from "./lint/scope.mjs";

const files = sourceFiles(["rs"], ".oxfmtrc.json").map((file) => resolve(ROOT, file));
if (files.length > 0) {
  const result = spawnSync(
    "bazel",
    [
      "run",
      "@rust_tools//:rustfmt",
      "--",
      "--edition",
      "2021",
      "--config-path",
      resolve(ROOT, "rustfmt.toml"),
      "--config",
      "skip_children=true",
      ...files,
    ],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (result.error) console.error(`[format:rust] Could not start bazel: ${result.error.message}`);
  if (result.signal) console.error(`[format:rust] bazel terminated after signal ${result.signal}`);
  process.exitCode = result.status ?? 1;
}
