// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

export const BINARYEN_VERSION = "125";

// sha256 of the exact release tarball, identical to the MODULE.bazel pin for
// the same artifact. Transport security is not artifact identity.
export const BINARYEN_SHA256 = "7c3bc16599c8274a04d34a504fe4be2047884f900e0e2da2f6fb9cd667183be4";

/** @param {string} file @returns {string} */
export function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const CACHE_ROOT = resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "kitesurf");

/** @returns {string} */
export function getWasmOpt() {
  if (process.env.WASM_OPT_BIN) return process.env.WASM_OPT_BIN;
  const bundled = resolve(
    process.env.HOME || "",
    ".cache/worker-build/wasm-opt-x86_64-linux-125/bin/wasm-opt",
  );
  if (existsSync(bundled)) return bundled;
  try {
    const onPath = execSync("command -v wasm-opt", { encoding: "utf8" }).trim();
    if (onPath) return onPath;
  } catch {}
  if (process.platform !== "linux" || process.arch !== "x64") return "";
  const cacheDir = resolve(CACHE_ROOT, `binaryen-${BINARYEN_VERSION}`);
  const binary = resolve(cacheDir, `binaryen-version_${BINARYEN_VERSION}/bin/wasm-opt`);
  const marker = resolve(cacheDir, ".fetched");
  if (existsSync(marker) && existsSync(binary)) return binary;
  try {
    console.log(`[build-wasm] fetching binaryen ${BINARYEN_VERSION} → ${cacheDir}`);
    rmSync(cacheDir, { recursive: true, force: true });
    mkdirSync(cacheDir, { recursive: true });
    const url =
      `https://github.com/WebAssembly/binaryen/releases/download/` +
      `version_${BINARYEN_VERSION}/binaryen-version_${BINARYEN_VERSION}-x86_64-linux.tar.gz`;
    const tarball = resolve(cacheDir, "binaryen.tar.gz");
    execSync(`curl -fsSL "${url}" -o "${tarball}"`, { stdio: "inherit" });
    const digest = sha256File(tarball);
    if (digest !== BINARYEN_SHA256) {
      throw new Error(`binaryen tarball sha256 ${digest} does not match pinned ${BINARYEN_SHA256}`);
    }
    execSync(`tar -xzf "${tarball}" -C "${cacheDir}"`, { stdio: "inherit" });
    if (existsSync(binary)) {
      writeFileSync(marker, new Date().toISOString() + "\n");
      return binary;
    }
  } catch (e) {
    console.log(`[build-wasm] binaryen fetch failed (${(e && e.message) || e}); skipping wasm-opt`);
  }
  return "";
}
