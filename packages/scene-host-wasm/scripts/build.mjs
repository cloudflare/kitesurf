// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getWasmOpt } from "../../../scripts/wasm-opt.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const crate = resolve(root, "packages/scene-host-wasm");
// Bazel compiles the wasm and passes it with --postprocess, plus output and scene-record paths.
// wasm-opt runs only if WASM_OPT_BIN names a binary.
const option = (flag) => {
  const at = process.argv.indexOf(flag);
  return at > 0 ? resolve(process.argv[at + 1]) : null;
};
const postprocessWasm = option("--postprocess");
const assets = option("--out-dir") ?? resolve(root, "packages/engine/public/rbi");
const sceneRecord =
  option("--scene-record") ?? resolve(root, "packages/core/src/paint/scene_record.rs");
const SCENE_HOST_ABI = 4;
const wasm = resolve(assets, "scene_host.wasm");
const manifest = resolve(assets, "scene_host.json");
if (
  process.env.KITESURF_REUSE_WASM &&
  !postprocessWasm &&
  existsSync(wasm) &&
  existsSync(manifest)
) {
  process.exit(0);
}

const built =
  postprocessWasm ?? resolve(crate, "target/wasm32-unknown-unknown/release/scene_host_wasm.wasm");
if (!postprocessWasm) {
  execFileSync("node", ["scripts/get-patched-vendor-crates.mjs"], { cwd: root, stdio: "inherit" });
  const rustflags = [process.env.RUSTFLAGS, "-C target-feature=+simd128"].filter(Boolean).join(" ");
  execFileSync(
    "cargo",
    ["build", "-p", "scene-host-wasm", "--release", "--target", "wasm32-unknown-unknown"],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, CARGO_TARGET_DIR: resolve(crate, "target"), RUSTFLAGS: rustflags },
    },
  );
}
mkdirSync(assets, { recursive: true });
const optimizer = postprocessWasm ? process.env.WASM_OPT_BIN : getWasmOpt();
if (optimizer && existsSync(optimizer)) {
  execFileSync(
    optimizer,
    [
      "-O3",
      "--enable-simd",
      "--enable-bulk-memory",
      "--enable-nontrapping-float-to-int",
      "--enable-sign-ext",
      built,
      "-o",
      wasm,
    ],
    { stdio: "inherit" },
  );
} else {
  console.log("[scene-host] wasm-opt not found; staging the unoptimized wasm");
  cpSync(built, wasm);
}
const bytes = readFileSync(wasm);
const version = /pub const WIRE_VERSION: u32 = (\d+);/.exec(readFileSync(sceneRecord, "utf8"))?.[1];
if (!version) throw new Error("scene wire version not found");
writeFileSync(
  manifest,
  JSON.stringify({
    abi: SCENE_HOST_ABI,
    wireVersion: Number(version),
    wasm: "scene_host.wasm",
    retainedFrames: true,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  }) + "\n",
);
