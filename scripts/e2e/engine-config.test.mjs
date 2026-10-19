// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { engineE2EConfig } from "../../packages/engine/vitest.e2e.config.mts";

test("e2e config defers module discovery until after global setup builds the dist", () => {
  const engineDist = resolve(tmpdir(), `kitesurf-e2e-not-built-${randomUUID()}`);
  const wranglerConfig = resolve(import.meta.dirname, "../../packages/engine/wrangler.jsonc");

  assert.doesNotThrow(() => engineE2EConfig({ wranglerConfig, engineDist }));
});
