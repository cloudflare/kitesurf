#!/usr/bin/env node
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { execSync } from "node:child_process";
import {
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
  readdirSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { copyFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPatchedVendorCrates } from "./get-patched-vendor-crates.mjs";
import { WASM_BINDGEN_VERSION, getWasmBindgen } from "./get-wasm-bindgen.mjs";
import { getWasmOpt } from "./wasm-opt.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE_DIR = resolve(ROOT, "packages/core");
function pathOption(flag) {
  const at = process.argv.indexOf(flag);
  if (at === -1) return null;
  const value = process.argv[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a path`);
  return resolve(value);
}

const postprocessWasm = pathOption("--postprocess");
const PKG_DIR = pathOption("--out-dir") ?? resolve(CORE_DIR, "pkg");
const WASM_OUT = resolve(PKG_DIR, "kitesurf_core_bg.wasm");
const PKG_OUTPUTS = [
  WASM_OUT,
  resolve(PKG_DIR, "kitesurf_core.js"),
  resolve(PKG_DIR, "kitesurf_core.glue.js"),
  resolve(PKG_DIR, "kitesurf_core.glue.d.ts"),
];
const SELF = resolve(dirname(fileURLToPath(import.meta.url)), "build-wasm.mjs");

const inCI = Boolean(process.env.CI);

const reuseWasm = Boolean(process.env.KITESURF_REUSE_WASM);

// Bazel compiles the wasm itself (rules_rust) and hands this script the raw wasm:
// only the post-passes run, with the tools named by WASM_BINDGEN_BIN/WASM_OPT_BIN.
const memprof = process.argv.includes("--memprof");
if (process.env.KITESURF_MEMPROF && !memprof) {
  console.error("[build-wasm] use `pnpm run build:wasm:memprof` for the Bazel memprof build");
  process.exit(2);
}
if (memprof && !postprocessWasm) {
  console.error("[build-wasm] memprof requires Bazel's --postprocess wasm input");
  process.exit(2);
}
if (postprocessWasm && !process.env.WASM_BINDGEN_BIN) {
  console.error("[build-wasm] --postprocess requires WASM_BINDGEN_BIN");
  process.exit(2);
}

const lastWasMemprof = existsSync(resolve(PKG_DIR, "kitesurf_core_bg.wasm.memprof.json"));
// A staged memprof wasm shares this package path and must not be reused as the normal wasm.
const force = process.argv.includes("--force") || inCI || memprof || lastWasMemprof;

function shouldRebuild() {
  if (force) return true;
  for (const out of PKG_OUTPUTS) {
    if (!existsSync(out)) return true;
  }
  const wasmMtime = statSync(WASM_OUT).mtimeMs;

  const inputs = [
    resolve(CORE_DIR, "Cargo.toml"),
    resolve(ROOT, "Cargo.toml"),
    resolve(ROOT, "Cargo.lock"),
    resolve(CORE_DIR, ".cargo/config.toml"),
    resolve(ROOT, "rust-toolchain.toml"),
    SELF,
    resolve(dirname(SELF), "get-patched-vendor-crates.mjs"),
  ];
  function walkPatches(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walkPatches(full);
      else if (entry.isFile() && entry.name.endsWith(".patch")) inputs.push(full);
    }
  }
  walkPatches(resolve(dirname(SELF), "patches"));
  function walkVendor(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walkVendor(full);
      else if (entry.isFile()) inputs.push(full);
    }
  }
  const vendorRoot = resolve(CORE_DIR, "target/vendor-patched");
  if (existsSync(vendorRoot)) walkVendor(vendorRoot);
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".rs")) inputs.push(full);
    }
  }
  walk(resolve(CORE_DIR, "src"));

  for (const path of inputs) {
    try {
      if (statSync(path).mtimeMs > wasmMtime) return true;
    } catch {
      return true;
    }
  }
  return false;
}

if (!postprocessWasm && reuseWasm && existsSync(WASM_OUT)) {
  console.log(
    `[build-wasm] KITESURF_REUSE_WASM=1 and ${WASM_OUT} present — reusing pre-staged pkg/`,
  );
  process.exit(0);
}

if (!postprocessWasm) {
  // Materialise first so Cargo patch paths exist even when the mtime check skips wasm.
  const vendorPaths = getPatchedVendorCrates();
  console.log("[build-wasm] vendor patches materialised: " + Object.keys(vendorPaths).join(", "));

  if (!shouldRebuild()) {
    console.log("[build-wasm] up to date (use --force to rebuild)");
    process.exit(0);
  }

  if (inCI) {
    console.log("[build-wasm] CI=1 detected, forcing full rebuild");
  }
}

const wasmBindgen = postprocessWasm
  ? resolve(process.env.WASM_BINDGEN_BIN)
  : getWasmBindgen(WASM_BINDGEN_VERSION);
console.log(`[build-wasm] using wasm-bindgen ${WASM_BINDGEN_VERSION} at ${wasmBindgen}`);

const cargoCmd = "cargo build --release --target wasm32-unknown-unknown --lib";
if (!postprocessWasm) {
  console.log(`[build-wasm] ${cargoCmd}`);
  execSync(cargoCmd, {
    cwd: CORE_DIR,
    stdio: "inherit",
    env: { ...process.env, CARGO_TARGET_DIR: resolve(CORE_DIR, "target") },
  });
}

const cargoWasm =
  postprocessWasm ?? resolve(CORE_DIR, "target/wasm32-unknown-unknown/release/kitesurf_core.wasm");
if (!existsSync(cargoWasm)) {
  console.error(`[build-wasm] expected ${cargoWasm} after cargo build`);
  process.exit(1);
}
mkdirSync(PKG_DIR, { recursive: true });
// Preserve the package BUILD file that rules_js needs; the Bazel action supplies
// empty generated outputs.
if (!postprocessWasm) {
  for (const entry of existsSync(PKG_DIR) ? readdirSync(PKG_DIR) : []) {
    if (entry !== "BUILD.bazel") rmSync(resolve(PKG_DIR, entry), { recursive: true, force: true });
  }
}
console.log("[build-wasm] wasm-bindgen --target web --typescript");
execSync(`"${wasmBindgen}" "${cargoWasm}" --out-dir "${PKG_DIR}" --target web --typescript`, {
  cwd: CORE_DIR,
  stdio: "inherit",
});

// This tracked manifest lets pnpm resolve core before the ignored wasm outputs exist.
const pkgJson = {
  name: "kitesurf-core",
  type: "module",
  description: "Wasm core for kitesurf: DOM data plane + Stylo + Blitz render.",
  version: "0.0.1",
  license: "Apache-2.0",
  files: ["kitesurf_core_bg.wasm", "kitesurf_core.js", "kitesurf_core.d.ts"],
  main: "kitesurf_core.js",
  types: "kitesurf_core.d.ts",
  sideEffects: ["./snippets/*"],
};
// Bazel uses the committed package manifest and checks it for drift.
if (!postprocessWasm) {
  console.log("[build-wasm] emit package.json");
  writeFileSync(resolve(PKG_DIR, "package.json"), JSON.stringify(pkgJson, null, 2) + "\n");
}

if (memprof) {
  console.log("[build-wasm] memprof: skipping wasm-opt post-pass");
} else {
  const WASM_OPT = postprocessWasm ? resolve(process.env.WASM_OPT_BIN) : getWasmOpt();
  if (postprocessWasm && !existsSync(WASM_OPT)) throw new Error(`no wasm-opt at ${WASM_OPT}`);
  if (WASM_OPT && existsSync(WASM_OPT)) {
    console.log("[build-wasm] wasm-opt -O3 " + WASM_OPT);
    const beforeBytes = statSync(WASM_OUT).size;
    // Keep optimizer features aligned with Cargo's wasm target flags.
    execSync(
      `"${WASM_OPT}" -O3 -g ` +
        "--enable-simd --enable-bulk-memory " +
        "--enable-nontrapping-float-to-int --enable-sign-ext " +
        "--enable-exception-handling " +
        `"${WASM_OUT}" -o "${WASM_OUT}.opt"`,
      { cwd: CORE_DIR, stdio: "inherit" },
    );
    execSync(`mv "${WASM_OUT}.opt" "${WASM_OUT}"`, { stdio: "inherit" });
    const afterBytes = statSync(WASM_OUT).size;
    const pct = (((beforeBytes - afterBytes) / beforeBytes) * 100).toFixed(1);
    console.log(`[build-wasm] wasm-opt: ${beforeBytes} → ${afterBytes} bytes (-${pct}%)`);
  } else {
    console.log(`[build-wasm] wasm-opt not found at ${WASM_OPT} — skipping post-pass`);
  }
}

if (memprof) {
  const rewriterBin = process.env.MEMPROF_REWRITER_BIN;
  if (!rewriterBin) throw new Error("--memprof requires MEMPROF_REWRITER_BIN");
  const rewriter = resolve(rewriterBin);
  if (!existsSync(rewriter)) throw new Error(`memprof-rewriter not found at ${rewriter}`);
  console.log("[build-wasm] memprof: instrumenting wasm");
  const instrumented = `${WASM_OUT}.memprof`;
  execSync(`"${rewriter}" "${WASM_OUT}" "${instrumented}"`, {
    stdio: "inherit",
  });
  execSync(`mv "${instrumented}" "${WASM_OUT}"`, { stdio: "inherit" });
  execSync(`mv "${instrumented}.memprof.json" "${WASM_OUT}.memprof.json"`, {
    stdio: "inherit",
  });
  console.log("[build-wasm] memprof: wrote instrumented wasm + manifest");
}

console.log("[build-wasm] post-pass: hide fetchResource bridge");
{
  const gluePath = resolve(PKG_DIR, "kitesurf_core.js");
  const original = readFileSync(gluePath, "utf8");
  if (original.includes("// HIDDEN-BRIDGE-MARKER-v1")) {
    console.log("[build-wasm]   marker present; skipping");
  } else {
    const BRIDGE_PREAMBLE =
      "// HIDDEN-BRIDGE-MARKER-v1 — see scripts/build-wasm.mjs post-pass\n" +
      "// Module-private capture of the JS-side fetchResource bridge.\n" +
      "// Set exactly once by the bootstrap path via\n" +
      "// __setBridgeFetchResource(fn) before initSync(wasm). After\n" +
      "// that the wasm-bindgen imports object calls through this\n" +
      "// binding instead of via globalThis, which means page JS has\n" +
      "// no reachable handle to override or call it.\n" +
      "let __bridgeFetchResource = null;\n" +
      "export function __setBridgeFetchResource(fn) {\n" +
      '  if (typeof fn !== "function") {\n' +
      "    throw new TypeError(\n" +
      '      "__setBridgeFetchResource: fn must be a function",\n' +
      "    );\n" +
      "  }\n" +
      "  __bridgeFetchResource = fn;\n" +
      "}\n";
    const LEGACY_CALL = "globalThis.__ks_state.fetchResource(";
    if (!original.includes(LEGACY_CALL)) {
      console.error(
        "[build-wasm] FATAL: expected " +
          JSON.stringify(LEGACY_CALL) +
          " in glue but didn't find it. wasm-bindgen codegen shape " +
          "may have changed; revisit the post-pass.",
      );
      process.exit(1);
    }
    const replaced = original.replace(
      LEGACY_CALL,
      "(__bridgeFetchResource ? __bridgeFetchResource : (() => {})).call(null, ",
    );
    if (replaced === original) {
      console.error(
        "[build-wasm] FATAL: bridge replacement failed (string.replace " +
          "returned identical content)",
      );
      process.exit(1);
    }
    writeFileSync(gluePath, BRIDGE_PREAMBLE + replaced);
    console.log("[build-wasm]   rewrote " + LEGACY_CALL + " → closure");
  }

  const dtsPath = resolve(PKG_DIR, "kitesurf_core.d.ts");
  const dtsOriginal = readFileSync(dtsPath, "utf8");
  if (!dtsOriginal.includes("__setBridgeFetchResource")) {
    const appendix =
      "\n// HIDDEN-BRIDGE-MARKER-v1 — appended by build-wasm.mjs.\n" +
      "// Bootstrap path calls this once, before initSync(wasm), with\n" +
      "// the JS-side implementation of the wasm → JS fetchResource\n" +
      "// bridge. See packages/core/src/resources/net.rs + the rationale in\n" +
      "// the post-pass block in scripts/build-wasm.mjs.\n" +
      "export declare function __setBridgeFetchResource(\n" +
      "  fn: (request_id: number, url: string, kind: string) => void,\n" +
      "): void;\n";
    writeFileSync(dtsPath, dtsOriginal + appendix);
  }
}

// Every trap (stack overflow, OOM, unreachable) poisons the module on this one glue path, including
// async tasks. Hand the trap to PageScript there, so it can end the page instead of hanging.
console.log("[build-wasm] post-pass: terminated hook");
{
  const gluePath = resolve(PKG_DIR, "kitesurf_core.js");
  const original = readFileSync(gluePath, "utf8");
  if (original.includes("// TERMINATED-HOOK-MARKER-v1")) {
    console.log("[build-wasm]   marker present; skipping");
  } else {
    const FLAG_STORE = "getInt32ArrayMemory0()[__wbg_terminated_addr] = 1;";
    const at = original.indexOf(FLAG_STORE);
    const preamble =
      "// TERMINATED-HOOK-MARKER-v1 — see scripts/build-wasm.mjs post-pass\n" +
      "let __ksOnTerminated = null;\n" +
      "export function __setOnTerminated(fn) {\n" +
      "  __ksOnTerminated = fn;\n" +
      "}\n";
    if (memprof && !original.includes("function __wbg_handle_catch(")) {
      // panic=abort has no terminate path; preserve the setter expected by PageScript.
      writeFileSync(gluePath, preamble + original);
      console.log("[build-wasm]   memprof: no terminate path to hook (panic=abort)");
    } else if (
      at < 0 ||
      original.indexOf(FLAG_STORE, at + 1) >= 0 ||
      !original.includes("function __wbg_handle_catch(e) {")
    ) {
      console.error(
        "[build-wasm] FATAL: expected one " +
          JSON.stringify(FLAG_STORE) +
          " in __wbg_handle_catch; wasm-bindgen's terminate path changed, revisit the post-pass.",
      );
      process.exit(1);
    } else {
      const hook = " try { if (__ksOnTerminated) __ksOnTerminated(e); } catch (_) {}";
      const end = at + FLAG_STORE.length;
      writeFileSync(gluePath, preamble + original.slice(0, end) + hook + original.slice(end));
      console.log("[build-wasm]   hooked __wbg_handle_catch");
    }
  }
}

console.log("[build-wasm] cp kitesurf_core.js → kitesurf_core.glue.js");
copyFileSync(resolve(PKG_DIR, "kitesurf_core.js"), resolve(PKG_DIR, "kitesurf_core.glue.js"));

console.log("[build-wasm] emit kitesurf_core.glue.d.ts");
const glueDts = `// Companion declaration for kitesurf_core.glue.js (verbatim copy of
// the wasm-bindgen JS glue). The Wrangler "Text" rule on **/*.glue.js
// makes the import yield the file's contents as a string, which we
// embed in the eval sandbox's module bundle.
//
// Regenerated by scripts/build-wasm.mjs — don't hand-edit.
declare const value: string;
export default value;
`;
writeFileSync(resolve(PKG_DIR, "kitesurf_core.glue.d.ts"), glueDts);

console.log("[build-wasm] done");
