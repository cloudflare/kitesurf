// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// `bazel run //packages/engine:e2e -- [vitest filters and flags]`: run the e2e suite, or the files
// matching the filters, against the engine and fixtures dists Bazel built.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const ENGINE_DIR = resolve(import.meta.dirname, "../packages/engine");
const require = createRequire(resolve(ENGINE_DIR, "package.json"));
const manifest = require.resolve("vitest/package.json");
const vitest = resolve(dirname(manifest), JSON.parse(readFileSync(manifest, "utf8")).bin.vitest);

const result = spawnSync(
  process.execPath,
  [vitest, "run", "--config", "vitest.e2e.config.mts", ...process.argv.slice(2)],
  {
    cwd: ENGINE_DIR,
    stdio: "inherit",
    env: {
      ...process.env,
      KS_E2E_ENGINE_DIST: resolve(ENGINE_DIR, "dist"),
      KS_E2E_FIXTURES_DIST: resolve(ENGINE_DIR, "e2e_fixtures_dist"),
    },
  },
);
process.exit(result.status ?? 1);
