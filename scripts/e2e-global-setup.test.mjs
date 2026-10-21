// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("extra fixtures use the engine package's Wrangler install", async (t) => {
  const dist = mkdtempSync(join(tmpdir(), "kitesurf-e2e-setup-"));
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  const engineDist = join(dist, "engine");
  mkdirSync(engineDist);
  writeFileSync(join(engineDist, "index.js"), "export default {};");
  const values = {
    KS_E2E_ENGINE_DIST: engineDist,
    KS_E2E_FIXTURES_DIST: undefined,
    KS_E2E_SKIP_BUILD: "1",
    KS_E2E_FIXTURE_WORKER_BUILDS: JSON.stringify([
      { wranglerConfig: join(dist, "private/wrangler.jsonc"), outdir: join(dist, "fixtures") },
    ]),
  };
  for (const [key, value] of Object.entries(values)) {
    const original = process.env[key];
    t.after(() => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    });
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const calls = [];
  t.mock.method(childProcess, "execFileSync", (...args) => calls.push(args));
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const { default: setup } = await import("../packages/engine/test/e2e/global-setup.ts");
  setup();
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], "pnpm");
  assert.equal(calls[1][2].cwd, resolve(import.meta.dirname, "../packages/engine"));
  assert.ok(calls[1][1].includes(join(dist, "private/wrangler.jsonc")));
});
