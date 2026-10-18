// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Check the public Cargo workspace lockfile on a temporary workspace and vendored crate sources.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const fromRoot = (name) => resolve(root, process.env[name]);
const vendor = dirname(fromRoot("CARGO_VENDOR_INDEX"));
const work = join(process.env.TEST_TMPDIR, "workspace");
const manifest = readFileSync(join(root, "Cargo.toml"), "utf8");

mkdirSync(work, { recursive: true });
copyFileSync(join(root, "Cargo.toml"), join(work, "Cargo.toml"));
copyFileSync(join(root, "Cargo.lock"), join(work, "Cargo.lock"));
const members = JSON.parse(/^members = (\[.*\])$/m.exec(manifest)?.[1] ?? "null");
if (!Array.isArray(members))
  throw new Error("no one-line `members = [...]` in Cargo.toml's [workspace]");
for (const member of members) {
  mkdirSync(join(work, member, "src"), { recursive: true });
  try {
    copyFileSync(join(root, member, "Cargo.toml"), join(work, member, "Cargo.toml"));
  } catch (error) {
    throw new Error(`${member}/Cargo.toml is not an input to //:cargo_lock_test`, { cause: error });
  }
  writeFileSync(join(work, member, "src/lib.rs"), "");
}
for (const [, path, key] of manifest.matchAll(/path = "(\S*\/vendor-patched\/([^"/]+))"/g)) {
  mkdirSync(dirname(join(work, path)), { recursive: true });
  symlinkSync(join(vendor, "patched", key), join(work, path));
}

const home = join(work, ".cargo-home");
mkdirSync(home);
writeFileSync(
  join(home, "config.toml"),
  `[source.crates-io]\nreplace-with = "vendored"\n[source.vendored]\ndirectory = ${JSON.stringify(join(vendor, "vendor"))}\n`,
);
const result = spawnSync(
  fromRoot("CARGO"),
  ["metadata", "--locked", "--offline", "--format-version", "1"],
  {
    cwd: work,
    stdio: ["ignore", "ignore", "inherit"],
    env: { PATH: process.env.PATH, HOME: home, CARGO_HOME: home, RUSTC: fromRoot("RUSTC") },
  },
);
if (result.status !== 0) {
  console.error(
    `[cargo-lock] ${result.signal ?? `exit ${result.status}`}: Cargo.lock does not match public workspace manifests`,
  );
  process.exit(1);
}
console.log("[cargo-lock] Cargo.lock matches the public workspace manifests");
