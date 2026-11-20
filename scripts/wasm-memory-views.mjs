// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// V8's %TypedArray%.prototype.subarray checks the begin byte offset against the embedder's
// ArrayBuffer size cap, so it throws for a valid window high in Wasm memory. The constructor
// form builds the same aliasing view without that check.
const WASM_MEMORY_VIEW_REWRITES = [
  [
    "getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len)",
    "new Float32Array(wasm.memory.buffer, ptr, len)",
  ],
  [
    "getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len)",
    "new Float64Array(wasm.memory.buffer, ptr, len)",
  ],
  [
    "getInt32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len)",
    "new Int32Array(wasm.memory.buffer, ptr, len)",
  ],
  [
    "getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len)",
    "new Uint32Array(wasm.memory.buffer, ptr, len)",
  ],
  [
    "getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len)",
    "new Uint8Array(wasm.memory.buffer, ptr, len)",
  ],
  [
    "getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf)",
    "new Uint8Array(wasm.memory.buffer, ptr, buf.length).set(buf)",
  ],
  [
    "getUint8ArrayMemory0().subarray(ptr + offset, ptr + len)",
    "new Uint8Array(wasm.memory.buffer, ptr + offset, len - offset)",
  ],
  [
    "cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len))",
    "cachedTextDecoder.decode(new Uint8Array(wasm.memory.buffer, ptr, len))",
  ],
];

const MEMORY_WINDOW = /(?:get\w+ArrayMemory\d+\(\)|cached\w+Memory\d+)\.subarray\(/;

function countOccurrences(source, needle) {
  let count = 0;
  for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + needle.length)) {
    count++;
  }
  return count;
}

// Throws when the glue lacks exactly one of each known window or has an unknown one.
/** @param {string} source wasm-bindgen `--target web` glue @returns {string} */
export function rewriteWasmMemoryViews(source) {
  const problems = [];
  const rewritten = rewriteKnownWindows(source, problems);
  problems.push(...unrewrittenWindowsIn(rewritten));
  if (problems.length > 0) {
    throw new Error(
      `wasm-bindgen glue drift: ${problems.join("; ")}. Revisit scripts/wasm-memory-views.mjs.`,
    );
  }
  return rewritten;
}

/** @param {string} source @param {string[]} problems @returns {string} */
function rewriteKnownWindows(source, problems) {
  let rewritten = source;
  for (const [subarray, view] of WASM_MEMORY_VIEW_REWRITES) {
    const count = countOccurrences(source, subarray);
    if (count !== 1) {
      problems.push(`expected exactly one ${JSON.stringify(subarray)}, found ${count}`);
    }
    rewritten = rewritten.split(subarray).join(view);
  }
  return rewritten;
}

/** @param {string} source @returns {string[]} */
function unrewrittenWindowsIn(source) {
  const problems = [];
  for (const line of source.split("\n")) {
    if (MEMORY_WINDOW.test(line)) {
      problems.push(`unrewritten Wasm memory window ${JSON.stringify(line.trim())}`);
    }
  }
  return problems;
}
