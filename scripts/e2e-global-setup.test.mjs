// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("extra fixtures use the engine package's Wrangler install", async (t) => {
  const dist = mkdtempSync(join(tmpdir(), "kitesurf-e2e-setup-"));
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  const engineDist = join(dist, "engine");
  mkdirSync(engineDist);
  const wranglerConfig = join(dist, "wrangler.jsonc");
  writeFileSync(wranglerConfig, "{}");
  utimesSync(wranglerConfig, 1_000, 1_000);
  writeFileSync(join(engineDist, "index.js"), "export default {};");
  const values = {
    KS_E2E_ENGINE_DIST: engineDist,
    KS_E2E_FIXTURES_DIST: undefined,
    KS_E2E_SKIP_BUILD: "1",
    KS_E2E_ALLOW_STALE_DIST: undefined,
    KS_E2E_WRANGLER_CONFIG: wranglerConfig,
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

  // Age the dist below every input: setup() must refuse it, not reuse it.
  utimesSync(join(engineDist, "index.js"), 0, 0);
  assert.throws(() => setup(), /KS_E2E_SKIP_BUILD is set but the engine dist is stale/);
});

const touch = (path, seconds) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
  utimesSync(path, seconds, seconds);
};

test("a KS_E2E_SKIP_BUILD dist older than its inputs fails setup by name", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "kitesurf-e2e-stale-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = process.env.KS_E2E_ALLOW_STALE_DIST;
  t.after(() => {
    if (original === undefined) delete process.env.KS_E2E_ALLOW_STALE_DIST;
    else process.env.KS_E2E_ALLOW_STALE_DIST = original;
  });
  delete process.env.KS_E2E_ALLOW_STALE_DIST;
  const { assertDistFresh, distInputRoots, newestInput } =
    await import("../packages/engine/test/e2e/global-setup.ts");
  const distIndex = join(root, "dist/index.js");
  touch(distIndex, 2_000);
  touch(join(root, "packages/engine/src/index.ts"), 1_000);
  touch(join(root, "packages/engine/src/node_modules/dep/index.js"), 3_000);
  touch(join(root, "packages/engine/src/.cache/entry.js"), 3_000);
  touch(join(root, "packages/kitesurf-cli/src/main.rs"), 3_000);
  const roots = distInputRoots(root);
  assert.equal(newestInput(roots)?.path, join(root, "packages/engine/src/index.ts"));
  assertDistFresh(distIndex, roots);

  const edited = join(root, "packages/dom-shim/src/element.ts");
  touch(edited, 3_000);
  assert.throws(
    () => assertDistFresh(distIndex, distInputRoots(root)),
    (error) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(edited));
      assert.ok(error.message.includes("KS_E2E_ALLOW_STALE_DIST=1"));
      return true;
    },
  );
  process.env.KS_E2E_ALLOW_STALE_DIST = "1";
  assertDistFresh(distIndex, distInputRoots(root));
});
