// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { execSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getWasmBindgen } from "../../../scripts/get-wasm-bindgen.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(PKG_ROOT, "../..");
const CORE_DIR = resolve(REPO_ROOT, "packages/core");
const PKG_DIR = resolve(PKG_ROOT, "pkg");

const OUT_WASM = resolve(PKG_DIR, "renderer_core_bg.wasm");
const OUT_GLUE = resolve(PKG_DIR, "renderer_core.glue.js");
const OUT_GLUE_DTS = resolve(PKG_DIR, "renderer_core.glue.d.ts");

// Bazel compiles the wasm itself (rules_rust) and hands this script the raw wasm:
// only the post-passes run, with tools named by WASM_BINDGEN_BIN/WASM_OPT_BIN.
const postprocessAt = process.argv.indexOf("--postprocess");
const postprocessWasm = postprocessAt > 0 ? resolve(process.argv[postprocessAt + 1]) : null;

if (process.env.KITESURF_REUSE_WASM && !postprocessWasm) {
  if ([OUT_WASM, OUT_GLUE, OUT_GLUE_DTS].every((outputPath) => existsSync(outputPath))) {
    console.log("[renderer-core] KITESURF_REUSE_WASM=1 and pkg/ present; reusing");
    process.exit(0);
  }
}

if (!postprocessWasm) {
  execSync("node scripts/get-patched-vendor-crates.mjs", {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
}

const cargoWasm =
  postprocessWasm ?? resolve(PKG_ROOT, "target/wasm32-unknown-unknown/release/renderer_core.wasm");

function newestMtime(filePaths) {
  let latestMtime = 0;
  for (const filePath of filePaths) {
    try {
      latestMtime = Math.max(latestMtime, statSync(filePath).mtimeMs);
    } catch {
      return Infinity;
    }
  }
  return latestMtime;
}
function oldestMtime(filePaths) {
  let earliestMtime = Infinity;
  for (const filePath of filePaths) {
    try {
      earliestMtime = Math.min(earliestMtime, statSync(filePath).mtimeMs);
    } catch {
      return -Infinity;
    }
  }
  return earliestMtime;
}
function commandSuffixes(command) {
  return process.platform === "win32" && !extname(command)
    ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(delimiter)
    : [""];
}

function isExecutableFile(candidate) {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findCommandInPath(command, workingDirectory) {
  const suffixes = commandSuffixes(command);
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    for (const suffix of suffixes) {
      const candidate = resolve(workingDirectory, directory, `${command}${suffix}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function resolveCommand(command, workingDirectory) {
  if (command.includes("/") || command.includes("\\")) {
    return resolve(workingDirectory, command);
  }
  return findCommandInPath(command, workingDirectory);
}

function existingToolIdentity(absolutePath) {
  if (!existsSync(absolutePath)) return { path: absolutePath, missing: true };
  const { dev: device, ino: inode, size, mtimeMs } = statSync(absolutePath);
  return { path: absolutePath, dev: device, ino: inode, size, mtimeMs };
}

function toolIdentity(command, workingDirectory, resolveFromPath = false) {
  const absolutePath = resolveFromPath
    ? resolveCommand(command, workingDirectory)
    : resolve(workingDirectory, command);
  if (!absolutePath) {
    return { command, searchPath: process.env.PATH || "", missing: true };
  }
  return existingToolIdentity(absolutePath);
}

const buildInputs = [
  resolve(PKG_ROOT, "Cargo.toml"),
  resolve(PKG_ROOT, "src/lib.rs"),
  resolve(PKG_ROOT, ".cargo/config.toml"),
  resolve(REPO_ROOT, "rust-toolchain.toml"),
  resolve(REPO_ROOT, "Cargo.toml"),
  resolve(REPO_ROOT, "Cargo.lock"),
  resolve(CORE_DIR, "src/scene_decode.rs"),
  resolve(CORE_DIR, "src/scene_record.rs"),
  resolve(CORE_DIR, "src/scene_replay.rs"),
  resolve(CORE_DIR, "src/screenshot.rs"),
  resolve(CORE_DIR, "src/pdf_paint.rs"),
  resolve(CORE_DIR, "src/ks_tracing.rs"),
];
const postProcessInputs = [
  ...buildInputs,
  cargoWasm,
  resolve(__dirname, "build.mjs"),
  resolve(REPO_ROOT, "scripts/get-wasm-bindgen.mjs"),
];
let WASM_OPT =
  process.env.WASM_OPT_BIN ||
  resolve(process.env.HOME || "", ".cache/worker-build/wasm-opt-x86_64-linux-125/bin/wasm-opt");
if (postprocessWasm) {
  WASM_OPT = process.env.WASM_OPT_BIN ? resolve(process.env.WASM_OPT_BIN) : "";
} else if (!process.env.WASM_OPT_BIN && !existsSync(WASM_OPT)) {
  WASM_OPT = resolveCommand("wasm-opt", process.cwd()) || WASM_OPT;
}
const postProcessState = resolve(PKG_ROOT, "target/renderer-core-postprocess.json");

if (!postprocessWasm) {
  console.log("[renderer-core] cargo build --release (replay slice)");
  execSync("cargo build --release --target wasm32-unknown-unknown", {
    cwd: PKG_ROOT,
    stdio: "inherit",
    env: { ...process.env, CARGO_TARGET_DIR: resolve(PKG_ROOT, "target") },
  });
}

const postProcessConfig = JSON.stringify({
  wasmBindgen: process.env.WASM_BINDGEN_BIN
    ? toolIdentity(process.env.WASM_BINDGEN_BIN, PKG_ROOT, true)
    : null,
  wasmOpt: toolIdentity(WASM_OPT, process.cwd()),
});
const outputs = [OUT_WASM, OUT_GLUE, OUT_GLUE_DTS];
const artifactsFresh =
  !postprocessWasm &&
  !process.env.RENDERER_CORE_FORCE &&
  oldestMtime(outputs) >= newestMtime(postProcessInputs) &&
  existsSync(postProcessState) &&
  readFileSync(postProcessState, "utf8") === postProcessConfig;
if (artifactsFresh) {
  console.log("[renderer-core] artifacts up to date");
  process.exit(0);
}

if (!postprocessWasm) writeFileSync(postProcessState, "");

const wasmBindgenCommand = postprocessWasm
  ? resolve(process.env.WASM_BINDGEN_BIN)
  : getWasmBindgen();
console.log("[renderer-core] wasm-bindgen --target web");
execSync(
  `"${wasmBindgenCommand}" "${cargoWasm}" --out-dir "${PKG_DIR}" --target web --typescript`,
  { cwd: PKG_ROOT, stdio: "inherit" },
);

if (postprocessWasm && WASM_OPT && !existsSync(WASM_OPT)) {
  throw new Error(`no wasm-opt at ${WASM_OPT}`);
}
if (WASM_OPT && existsSync(WASM_OPT)) {
  console.log("[renderer-core] wasm-opt -O3");
  execSync(
    `"${WASM_OPT}" -O3 -g --enable-simd --enable-bulk-memory ` +
      "--enable-nontrapping-float-to-int --enable-sign-ext " +
      `--enable-exception-handling "${OUT_WASM}" -o "${OUT_WASM}.opt"`,
    { stdio: "inherit" },
  );
  renameSync(`${OUT_WASM}.opt`, OUT_WASM);
} else {
  console.log(`[renderer-core] wasm-opt not found at ${WASM_OPT}; skipping`);
}

renameSync(resolve(PKG_DIR, "renderer_core.js"), OUT_GLUE);
writeFileSync(
  OUT_GLUE_DTS,
  `// Companion declaration for renderer_core.glue.js (verbatim copy of
// the wasm-bindgen JS glue). The Wrangler "Text" rule on **/*.glue.js
// makes the import yield the file's contents as a string, which the
// engine embeds in the renderer isolate's module bundle.
//
// Regenerated by packages/renderer-core/scripts/build.mjs; do not hand-edit.
declare const value: string;
export default value;
`,
);
if (!postprocessWasm) writeFileSync(postProcessState, postProcessConfig);

const wasmBytes = statSync(OUT_WASM).size;
console.log(`[renderer-core] pkg/ ready (${(wasmBytes / 1024 / 1024).toFixed(2)} MB wasm)`);
