// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "kitesurf-vendor-fetch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "bin"));
  copyFileSync(
    new URL("./get-patched-vendor-crates.mjs", import.meta.url),
    join(root, "scripts/get-patched-vendor-crates.mjs"),
  );
  const manifest = '[workspace]\n[patch.crates-io]\ntaffy = { path = "missing/taffy-0.15.0" }\n';
  const lock = 'version = 4\n[[package]]\nname = "taffy"\nversion = "0.15.0"\n';
  writeFileSync(join(root, "Cargo.toml"), manifest);
  writeFileSync(join(root, "Cargo.lock"), lock);
  // Model a registry whose newest compatible release is not the patched version.
  writeFileSync(
    join(root, "bin/cargo"),
    `#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
if (process.env.FAIL_CARGO) process.exit(23);
const args = process.argv.slice(2);
const spec = args[0] === "fetch" ? "taffy@0.15.1" : args.at(-1);
const [name, version] = spec.split("@");
mkdirSync(join(process.env.CARGO_HOME, "registry/src/index.crates.io-fixture", name + "-" + version), { recursive: true });
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    CARGO_HOME: join(root, "cargo-home"),
    PATH: join(root, "bin") + delimiter + process.env.PATH,
    FAIL_CARGO: "",
  };
  const run = () =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { findRegistrySource } from ${JSON.stringify(pathToFileURL(join(root, "scripts/get-patched-vendor-crates.mjs")).href)};
process.stdout.write(findRegistrySource("taffy", "0.15.0"));`,
      ],
      { cwd: root, env, encoding: "utf8" },
    );
  const assertWorkspaceUnchanged = () => {
    assert.equal(readFileSync(join(root, "Cargo.toml"), "utf8"), manifest);
    assert.equal(readFileSync(join(root, "Cargo.lock"), "utf8"), lock);
  };
  return { env, run, assertWorkspaceUnchanged };
}

test("cold bootstrap downloads the patched version, then reuses its registry source", (t) => {
  const f = fixture(t);
  const cold = f.run();
  assert.equal(cold.status, 0, cold.stderr);
  assert.equal(
    cold.stdout,
    join(f.env.CARGO_HOME, "registry/src/index.crates.io-fixture/taffy-0.15.0"),
  );
  f.assertWorkspaceUnchanged();

  f.env.FAIL_CARGO = "1";
  const warm = f.run();
  assert.equal(warm.status, 0, warm.stderr);
  assert.equal(warm.stdout, cold.stdout);
});

test("a failed crate download leaves the workspace untouched", (t) => {
  const f = fixture(t);
  f.env.FAIL_CARGO = "1";
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cargo/);
  f.assertWorkspaceUnchanged();
});
