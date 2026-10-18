// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TOOLING_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const ROOT = resolve(process.cwd());
export const RUST_TARGET_DIR = resolve(
  ROOT,
  existsSync(resolve(ROOT, "packages/core")) ? "packages/core/target" : "target",
);
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

/** @returns {string} */
export function pinnedRustToolchain() {
  const toolchainPath = resolve(TOOLING_ROOT, "rust-toolchain.toml");
  const source = readFileSync(toolchainPath, "utf8");
  const channel = source.match(/^\s*channel\s*=\s*"(nightly-\d{4}-\d{2}-\d{2})"\s*$/mu)?.[1];
  if (channel === undefined) {
    throw new Error(`${toolchainPath} must pin an exact nightly-YYYY-MM-DD toolchain`);
  }
  return channel;
}

function exclusionsFor(configFile) {
  const configPath = resolve(ROOT, configFile);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (
    !Array.isArray(config.ignorePatterns) ||
    !config.ignorePatterns.every((pattern) => typeof pattern === "string")
  ) {
    throw new Error(`${configFile} must define string ignorePatterns for authored-source checks`);
  }
  return config.ignorePatterns.map((pattern) => `:(glob,exclude)${pattern}`);
}

/** @param {string[]} extensions @param {string} configFile @returns {string[]} */
export function sourceFiles(extensions, configFile = ".oxlintrc.json") {
  return execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...extensions.map((extension) => `*.${extension}`),
      ...exclusionsFor(configFile),
    ],
    { cwd: ROOT, encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT_BYTES },
  )
    .split("\0")
    .filter((file) => file.length > 0 && existsSync(resolve(ROOT, file)));
}
