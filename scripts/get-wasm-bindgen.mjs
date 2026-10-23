// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// Keep this CLI pin aligned with the wasm-bindgen crate version in the root workspace.
export const WASM_BINDGEN_VERSION = "0.2.127";

const CACHE_ROOT = resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "kitesurf");

function cachedBinary(binary, marker) {
  return existsSync(marker) && existsSync(binary) ? binary : null;
}

function installWasmBindgen(version, cacheDir, binary, marker) {
  console.log(`[wasm-bindgen] cargo install wasm-bindgen-cli@${version} → ${cacheDir}`);
  rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
  execSync(`cargo install wasm-bindgen-cli --version ${version} --locked --root "${cacheDir}"`, {
    stdio: "inherit",
  });
  if (!existsSync(binary)) {
    throw new Error(`expected binary at ${binary} after cargo install`);
  }
  writeFileSync(marker, new Date().toISOString() + "\n");
  return binary;
}

/** @param {string} [version=WASM_BINDGEN_VERSION]
 * @returns {string} */
export function getWasmBindgen(version = WASM_BINDGEN_VERSION) {
  if (process.env.WASM_BINDGEN_BIN) return process.env.WASM_BINDGEN_BIN;
  const cacheDir = resolve(CACHE_ROOT, `wasm-bindgen-${version}`);
  const binary = resolve(cacheDir, "bin/wasm-bindgen");
  const marker = resolve(cacheDir, ".built");
  return cachedBinary(binary, marker) ?? installWasmBindgen(version, cacheDir, binary, marker);
}
