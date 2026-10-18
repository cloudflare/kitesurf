#!/usr/bin/env node
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, resolve } from "node:path";
import { ROOT, RUST_TARGET_DIR, TOOLING_ROOT, pinnedRustToolchain, sourceFiles } from "./scope.mjs";

const MAX_CONTROL_FLOW_DEPTH = 4;
const HELPER_MANIFEST = resolve(TOOLING_ROOT, "scripts/lint/rust-check/Cargo.toml");
const files = sourceFiles(["rs"]);
const env = {
  ...process.env,
  PATH: [resolve(process.env.HOME || homedir(), ".cargo/bin"), process.env.PATH]
    .filter(Boolean)
    .join(delimiter),
  CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || "2",
  CARGO_TARGET_DIR: RUST_TARGET_DIR,
};

delete env.CARGO_BUILD_TARGET;
delete env.CARGO_ENCODED_RUSTFLAGS;
delete env.RUSTFLAGS;

const result = spawnSync(
  "rustup",
  [
    "run",
    pinnedRustToolchain(),
    "cargo",
    "run",
    "--quiet",
    "--locked",
    "--offline",
    "--manifest-path",
    HELPER_MANIFEST,
    "--",
    "--max-depth",
    String(MAX_CONTROL_FLOW_DEPTH),
    ...files,
  ],
  { cwd: ROOT, env, stdio: "inherit" },
);

if (result.error !== undefined) {
  console.error(`Could not start the Rust nesting checker: ${result.error.message}`);
  process.exitCode = 1;
} else if (result.signal !== null) {
  console.error(`Rust nesting checker exited after signal ${result.signal}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
