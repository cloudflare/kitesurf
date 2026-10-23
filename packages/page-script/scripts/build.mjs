// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { build } from "esbuild";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { esbuildTwinGuard } from "../../../scripts/declaration-twin-guard.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const SRC_ENTRY = resolve(PKG_ROOT, "src/index.ts");
const INTERNAL_STATE_ENTRY = resolve(PKG_ROOT, "src/internal-state.ts");
const DIST_DIR = resolve(PKG_ROOT, "dist");
const BUNDLE_OUT = resolve(DIST_DIR, "page-script.js");
const INTERNAL_STATE_OUT = resolve(DIST_DIR, "internal-state.js");
const INDEX_OUT = resolve(DIST_DIR, "index.js");
const TYPES_OUT = resolve(DIST_DIR, "index.d.ts");
const BYTES_PER_KIB = 1024;

const MEMPROF = Boolean(process.env.KITESURF_MEMPROF);
const MANIFEST_PATH = resolve(PKG_ROOT, "../core/pkg/kitesurf_core_bg.wasm.memprof.json");

function generateHookClosure(t) {
  const key = JSON.stringify(`posthook_${t.wasm_name}`);
  switch (t.hook_suffix) {
    case "rust_alloc":
    case "rust_alloc_zeroed":
      return `__memprofImports[${key}] = function(_size, _align, ret) { __memprofRecordAlloc(ret, _size); };`;
    case "rust_dealloc":
      return `__memprofImports[${key}] = function(ptr, _size, _align) { __memprofRecordFree(ptr); };`;
    case "rust_realloc":
      return `__memprofImports[${key}] = function(ptr, _osize, _align, nsize, ret) { __memprofRecordFree(ptr); __memprofRecordAlloc(ret, nsize); };`;
    default:
      return `// unhandled hook_suffix: ${t.hook_suffix}`;
  }
}

function memprofBanner() {
  if (!MEMPROF) return "";
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(
      `KITESURF_MEMPROF=1 but manifest missing at ${MANIFEST_PATH}. ` +
        `Run \`pnpm run dev:memprof\`, which builds it first.`,
    );
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const hookClosures = manifest.tracees.map(generateHookClosure).join("\n");
  return `// ---- wasm-memprof recorder (injected by build.mjs, KITESURF_MEMPROF=1) ----
const __memprofSampleRate = parseInt(globalThis.MEMPROF_SAMPLE_RATE || "2048", 10);
let __memprofNextSample = __memprofSampleRate;
const __memprofInUse = new Map();
let __memprofTotalAllocs = 0;
let __memprofTotalFrees = 0;
let __memprofSampledAllocs = 0;
// workerd holds Date.now() at 0 while modules evaluate, so the first allocation stamps the start.
let __memprofStart = 0;
function __memprofCaptureStack() {
  const e = new Error();
  const orig = Error.prepareStackTrace;
  const origLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 100;
  Error.prepareStackTrace = (_, s) => s;
  const stack = e.stack;
  Error.prepareStackTrace = orig;
  Error.stackTraceLimit = origLimit;
  const out = [];
  for (const cs of stack || []) {
    let fn; try { fn = cs.getFunctionName(); } catch { fn = null; }
    let file; try { file = cs.getFileName(); } catch { file = null; }
    let line; try { line = cs.getLineNumber(); } catch { line = null; }
    let col; try { col = cs.getColumnNumber(); } catch { col = null; }
    out.push({ fn, file, line, col });
  }
  return out;
}
function __memprofRecordAlloc(ptr, size) {
  __memprofTotalAllocs++;
  if (__memprofStart === 0) __memprofStart = Date.now();
  if (ptr === 0 || size === 0) return;
  __memprofNextSample -= size;
  if (__memprofNextSample > 0) return;
  __memprofNextSample = __memprofSampleRate;
  __memprofSampledAllocs++;
  __memprofInUse.set(ptr, { size, stack: __memprofCaptureStack() });
}
function __memprofRecordFree(ptr) {
  __memprofTotalFrees++;
  __memprofInUse.delete(ptr);
}
const __memprofImports = {};
${hookClosures}
globalThis.__ks_memprof_imports = __memprofImports;
globalThis.__memprof_dump = function() {
  const groups = new Map();
  let inUseBytes = 0;
  for (const [_ptr, { size, stack }] of __memprofInUse) {
    inUseBytes += size;
    const key = stack.slice(3).map((f) => (f.fn || "") + ":" + (f.line || 0)).join("|");
    let g = groups.get(key);
    if (!g) { g = { count: 0, bytes: 0, max: 0, stack }; groups.set(key, g); }
    g.count++; g.bytes += size; if (size > g.max) g.max = size;
  }
  const samples = [];
  for (const g of groups.values()) samples.push({ ptr: 0, size: g.bytes, count: g.count, max: g.max, stack: g.stack });
  // Raw (ptr, size, siteIdx) triples for address-space/fragmentation
  // maps; sites indexes the first non-allocator frame per allocation.
  const siteIdx = new Map();
  const ptrs = [];
  const skip = /alloc|raw_vec|memprof|__rust|dlmalloc|reserve|grow_amortized/i;
  for (const [ptr, { size, stack }] of __memprofInUse) {
    let fn = "?";
    for (let i = 3; i < stack.length; i++) {
      const f = stack[i] && stack[i].fn;
      if (f && !skip.test(f)) { fn = f; break; }
    }
    let idx = siteIdx.get(fn);
    if (idx === undefined) { idx = siteIdx.size; siteIdx.set(fn, idx); }
    ptrs.push(ptr, size, idx);
  }
  return JSON.stringify({
    ptr_sites: [...siteIdx.keys()],
    ptrs,
    sample_rate: __memprofSampleRate,
    total_allocs: __memprofTotalAllocs,
    total_frees: __memprofTotalFrees,
    sampled_allocs: __memprofSampledAllocs,
    in_use_count: __memprofInUse.size,
    in_use_bytes: inUseBytes,
    elapsed_ms: __memprofStart ? Date.now() - __memprofStart : 0,
    samples,
  });
};
globalThis.__memprof_reset = function() {
  __memprofInUse.clear();
  __memprofTotalAllocs = 0; __memprofTotalFrees = 0; __memprofSampledAllocs = 0;
  __memprofStart = Date.now();
};
// ---- end wasm-memprof recorder ----
`;
}

// Keep this sibling external so PageScript and dom-shim share one state object.
const sharedStateGuard = {
  name: "shared-state-guard",
  setup(build) {
    build.onResolve({ filter: /(^|\/)internal-state\.ts$/ }, (args) => ({
      errors: [
        {
          text: `${args.importer} imports ${args.path}: use "./internal-state.js" so it stays the shared external module`,
        },
      ],
    }));
  },
};

async function run() {
  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });

  const result = await build({
    entryPoints: [SRC_ENTRY],
    outfile: BUNDLE_OUT,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "esnext",
    // Worker Loader resolves these runtime modules from the loaded worker's modules map.
    external: [
      "cloudflare:*",
      "node:*",
      "./wasm-glue.js",
      "./core_bg.wasm",
      "./dom-shim.js",
      "./internal-state.js",
      "./__ks_startup_probe_input.js",
      "./__ks_import_map.js",
      "./__ks_user_classic_regular.js",
      "./__ks_user_classic_async.js",
      "./__ks_wasm_registry.js",
    ],
    banner: { js: memprofBanner() },
    minify: true,
    keepNames: true,
    sourcemap: false,
    logLevel: "warning",
    metafile: false,
    conditions: ["workerd", "worker", "browser"],
    resolveExtensions: [".ts", ".mjs", ".js", ".json"],
    plugins: [esbuildTwinGuard, sharedStateGuard],
  });
  if (result.errors.length) {
    throw new Error(`esbuild reported ${result.errors.length} error(s); aborting`);
  }

  const bundled = await readFile(BUNDLE_OUT, "utf8");

  // Publish the shared singleton separately for PageScript and the DOM shim.
  const internalStateResult = await build({
    entryPoints: [INTERNAL_STATE_ENTRY],
    outfile: INTERNAL_STATE_OUT,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "esnext",
    minify: true,
    keepNames: true,
    sourcemap: false,
    logLevel: "warning",
    conditions: ["workerd", "worker", "browser"],
    resolveExtensions: [".ts", ".mjs", ".js", ".json"],
    plugins: [esbuildTwinGuard],
  });
  if (internalStateResult.errors.length) {
    throw new Error(
      `esbuild reported ${internalStateResult.errors.length} error(s) ` +
        `on internal-state bundle; aborting`,
    );
  }
  const internalStateBundled = await readFile(INTERNAL_STATE_OUT, "utf8");

  const wrapper =
    "// AUTO-GENERATED by scripts/build.mjs. Do not edit by hand.\n" +
    "// The bundled JS sources are the runtime modules that live inside\n" +
    "// the per-target Worker Loader loaded worker; the control worker\n" +
    "// feeds PAGE_SCRIPT_SOURCE as `page.js` and INTERNAL_STATE_SOURCE\n" +
    "// as the sibling `internal-state.js` module.\n" +
    "export const PAGE_SCRIPT_SOURCE = " +
    JSON.stringify(bundled) +
    ";\n" +
    "export const INTERNAL_STATE_SOURCE = " +
    JSON.stringify(internalStateBundled) +
    ";\n";
  await writeFile(INDEX_OUT, wrapper);

  const types =
    "// AUTO-GENERATED by scripts/build.mjs. Do not edit by hand.\n" +
    "export declare const PAGE_SCRIPT_SOURCE: string;\n" +
    "export declare const INTERNAL_STATE_SOURCE: string;\n";
  await writeFile(TYPES_OUT, types);

  const kib = (bundled.length / BYTES_PER_KIB).toFixed(1);
  const isKib = (internalStateBundled.length / BYTES_PER_KIB).toFixed(1);
  if (MEMPROF) {
    console.log(`[page-script] wasm-memprof recorder injected (banner)`);
  }
  console.log(`[page-script] bundled ${bundled.length} chars (${kib} KiB)`);
  console.log(
    `[page-script] internal-state bundle ${internalStateBundled.length} ` + `chars (${isKib} KiB)`,
  );
  console.log(`[page-script]   ${BUNDLE_OUT}`);
  console.log(`[page-script]   ${INTERNAL_STATE_OUT}`);
  console.log(`[page-script]   ${INDEX_OUT}`);
  console.log(`[page-script]   ${TYPES_OUT}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
