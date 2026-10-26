// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CRATES } from "./get-patched-vendor-crates.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "kitesurf-vendor-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "scripts");
  const home = join(root, "cargo-home");
  const bin = join(root, "bin");
  for (const dir of [scripts, home, bin]) mkdirSync(dir);
  copyFileSync(
    new URL("./get-patched-vendor-crates.mjs", import.meta.url),
    join(scripts, "vendor.mjs"),
  );
  const manifest =
    '[package]\nname = "fixture"\nversion = "0.1.0"\n[dependencies]\ntaffy = "0.15"\n';
  const lock = CRATES.map(
    ({ name, version }) => `[[package]]\nname = "${name}"\nversion = "${version}"\n`,
  ).join("\n");
  writeFileSync(join(root, "Cargo.toml"), manifest);
  writeFileSync(join(root, "Cargo.lock"), lock);
  writeFileSync(
    join(bin, "cargo"),
    `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const manifestFlag = process.argv.indexOf("--manifest-path");
const manifestPath = manifestFlag < 0 ? join(process.cwd(), "Cargo.toml") : process.argv[manifestFlag + 1];
const work = dirname(manifestPath);
const manifest = readFileSync(manifestPath, "utf8");
writeFileSync(join(process.env.CARGO_HOME, "fetch.json"), JSON.stringify({
  work,
  manifest,
  originalManifest: readFileSync(join(process.env.FIXTURE_ROOT, "Cargo.toml"), "utf8"),
  originalLock: readFileSync(join(process.env.FIXTURE_ROOT, "Cargo.lock"), "utf8"),
}));
if (process.env.FAIL_FETCH) process.exit(1);
for (const match of manifest.matchAll(/^([\\w-]+) = \\{ version = "=([^"]+)"/gm)) {
  mkdirSync(join(process.env.CARGO_HOME, "registry/src/index.crates.io-test", match[1] + "-" + match[2]), { recursive: true });
}
`,
    { mode: 0o755 },
  );
  const run = (expression, extraEnv = {}) =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { findRegistrySource, getPatchedVendorCrates } from ${JSON.stringify(join(scripts, "vendor.mjs"))};\n${expression}`,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          CARGO_HOME: home,
          FIXTURE_ROOT: root,
          ...extraEnv,
        },
        encoding: "utf8",
        timeout: 10000,
      },
    );
  return { root, home, manifest, lock, run };
}

test("cold bootstrap obtains exact patch versions without changing workspace files", (t) => {
  const { root, home, manifest, lock, run } = fixture(t);
  const result = run('console.log(findRegistrySource("taffy", "0.15.0"))');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), join(home, "registry/src/index.crates.io-test/taffy-0.15.0"));
  const fetched = JSON.parse(readFileSync(join(home, "fetch.json"), "utf8"));
  assert.equal(fetched.originalManifest, manifest);
  assert.equal(fetched.originalLock, lock);
  assert.notEqual(fetched.work, root);
  assert.equal(existsSync(fetched.work), false, "bootstrap workspace is cleaned up");
  for (const { name, version } of CRATES) {
    assert.equal(
      existsSync(join(home, `registry/src/index.crates.io-test/${name}-${version}`)),
      true,
    );
  }
  assert.equal(readFileSync(join(root, "Cargo.toml"), "utf8"), manifest);
  assert.equal(readFileSync(join(root, "Cargo.lock"), "utf8"), lock);
});

test("warm registry sources do not invoke cargo", (t) => {
  const { home, run } = fixture(t);
  const source = join(home, "registry/src/index.crates.io-test/taffy-0.15.0");
  mkdirSync(source, { recursive: true });
  const result = run('console.log(findRegistrySource("taffy", "0.15.0"))', { FAIL_FETCH: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), source);
  assert.equal(existsSync(join(home, "fetch.json")), false);
});

test("version drift fails before materialization or fetching", (t) => {
  const { root, home, lock, run } = fixture(t);
  writeFileSync(join(root, "Cargo.lock"), lock.replace('version = "0.15.0"', 'version = "0.15.1"'));
  const result = run("getPatchedVendorCrates()");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /taffy-0\.15\.0.*Cargo\.lock.*0\.15\.1/);
  assert.equal(existsSync(join(home, "fetch.json")), false);
  assert.equal(existsSync(join(root, "packages")), false);
});

test("fetch failures name missing versions and clean up the bootstrap workspace", (t) => {
  const { home, run } = fixture(t);
  const result = run('findRegistrySource("taffy", "0.15.0")', { FAIL_FETCH: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fetch.*taffy-0\.15\.0/);
  assert.match(result.stderr, /retry/i);
  const fetched = JSON.parse(readFileSync(join(home, "fetch.json"), "utf8"));
  assert.equal(existsSync(fetched.work), false);
});
