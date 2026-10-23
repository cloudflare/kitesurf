// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

export const BINARYEN_VERSION = "125";

const CACHE_ROOT = resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "kitesurf");

function bundledWasmOpt() {
  const bundled = resolve(
    process.env.HOME || "",
    ".cache/worker-build/wasm-opt-x86_64-linux-125/bin/wasm-opt",
  );
  return existsSync(bundled) ? bundled : "";
}

function pathWasmOpt() {
  try {
    return execSync("command -v wasm-opt", { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function supportsCachedWasmOpt() {
  return process.platform === "linux" && process.arch === "x64";
}

function cachedBinary(cacheDir, binary) {
  const marker = resolve(cacheDir, ".fetched");
  if (existsSync(marker) && existsSync(binary)) return binary;
  return "";
}

function errorMessage(error) {
  return (error && error.message) || error;
}

function fetchWasmOpt(cacheDir, binary) {
  const marker = resolve(cacheDir, ".fetched");
  try {
    console.log(`[build-wasm] fetching binaryen ${BINARYEN_VERSION} → ${cacheDir}`);
    rmSync(cacheDir, { recursive: true, force: true });
    mkdirSync(cacheDir, { recursive: true });
    const url =
      `https://github.com/WebAssembly/binaryen/releases/download/` +
      `version_${BINARYEN_VERSION}/binaryen-version_${BINARYEN_VERSION}-x86_64-linux.tar.gz`;
    const tarball = resolve(cacheDir, "binaryen.tar.gz");
    execSync(`curl -fsSL "${url}" -o "${tarball}"`, { stdio: "inherit" });
    execSync(`tar -xzf "${tarball}" -C "${cacheDir}"`, { stdio: "inherit" });
    if (existsSync(binary)) {
      writeFileSync(marker, new Date().toISOString() + "\n");
      return binary;
    }
  } catch (e) {
    console.log(`[build-wasm] binaryen fetch failed (${errorMessage(e)}); skipping wasm-opt`);
  }
  return "";
}

function cachedWasmOpt() {
  if (!supportsCachedWasmOpt()) return "";
  const cacheDir = resolve(CACHE_ROOT, `binaryen-${BINARYEN_VERSION}`);
  const binary = resolve(cacheDir, `binaryen-version_${BINARYEN_VERSION}/bin/wasm-opt`);
  const cached = cachedBinary(cacheDir, binary);
  if (cached) return cached;
  return fetchWasmOpt(cacheDir, binary);
}

/** @returns {string} */
export function getWasmOpt() {
  if (process.env.WASM_OPT_BIN) return process.env.WASM_OPT_BIN;
  const bundled = bundledWasmOpt();
  if (bundled) return bundled;
  const onPath = pathWasmOpt();
  if (onPath) return onPath;
  return cachedWasmOpt();
}
