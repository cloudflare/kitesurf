// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { rewriteWasmMemoryViews } from "./wasm-memory-views.mjs";

// KITESURF_CORE_PKG_DIR points the regression at another built glue, such as a pre-fix bazel-bin.
const PKG_DIR = process.env.KITESURF_CORE_PKG_DIR
  ? resolve(process.env.KITESURF_CORE_PKG_DIR)
  : fileURLToPath(new URL("../packages/core/pkg/", import.meta.url));

const MIB = 1024 * 1024;
const WASM_PAGE_BYTES = 65536;
// Models a V8 embedder whose ArrayBuffer max is 128 MiB: typed-array-subarray.tq:79 compares the
// clamped begin byte offset with that max. Node has no such cap; the native cap is evidenced
// separately, outside this test.
const MODELED_EMBEDDER_CAP = 128 * MIB;
// The traced live selector call: ptr 145256848, 209 ids, in a 145948672-byte memory.
const LIVE_PTR = 145256848;
const LIVE_LEN = 209;
const LIVE_MEMORY_BYTES = 145948672;
const BELOW_CAP = MODELED_EMBEDDER_CAP - 64;
const ABOVE_CAP = MODELED_EMBEDDER_CAP + 64;

const glue = readFileSync(resolve(PKG_DIR, "kitesurf_core.js"), "utf8");
// Append test-only exports so the generated memory-view helpers are reachable.
const privateExports = `
export const __viewTestHooks = {
  getArrayF32FromWasm0, getArrayF64FromWasm0, getArrayI32FromWasm0, getArrayU32FromWasm0,
  getArrayU8FromWasm0, getStringFromWasm0, passStringToWasm0,
  memory: () => wasm.memory,
  vectorLen: () => WASM_VECTOR_LEN,
};
`;
const core = await import(
  `data:text/javascript;base64,${Buffer.from(glue + privateExports).toString("base64")}`
);
core.initSync({ module: readFileSync(resolve(PKG_DIR, "kitesurf_core_bg.wasm")) });
const hooks = core.__viewTestHooks;
const memory = hooks.memory();
// Grow to the traced memory size so LIVE_PTR is a real address in this module's memory.
const missingPages = (LIVE_MEMORY_BYTES - memory.buffer.byteLength) / WASM_PAGE_BYTES;
if (missingPages > 0) memory.grow(Math.ceil(missingPages));

const TypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const nativeSubarray = Object.getOwnPropertyDescriptor(TypedArrayPrototype, "subarray");

function withModeledEmbedderCap(run) {
  Object.defineProperty(TypedArrayPrototype, "subarray", {
    ...nativeSubarray,
    value: function subarray(begin, end) {
      if (this.buffer === memory.buffer) {
        const relative = Math.trunc(Number(begin)) || 0;
        const clamped =
          relative < 0 ? Math.max(this.length + relative, 0) : Math.min(relative, this.length);
        if (this.byteOffset + clamped * this.BYTES_PER_ELEMENT > MODELED_EMBEDDER_CAP) {
          throw new RangeError("Invalid array buffer length");
        }
      }
      return nativeSubarray.value.call(this, begin, end);
    },
  });
  try {
    return run();
  } finally {
    Object.defineProperty(TypedArrayPrototype, "subarray", nativeSubarray);
  }
}

test("the modeled cap rejects only Wasm-memory subarrays that begin above 128 MiB", () => {
  assert.equal(new Uint8Array(memory.buffer).subarray(LIVE_PTR, LIVE_PTR + 1).length, 1);
  withModeledEmbedderCap(() => {
    const whole = new Uint8Array(memory.buffer);
    assert.equal(whole.subarray(MODELED_EMBEDDER_CAP).byteOffset, MODELED_EMBEDDER_CAP);
    assert.throws(() => whole.subarray(MODELED_EMBEDDER_CAP + 1), {
      name: "RangeError",
      message: "Invalid array buffer length",
    });
    assert.throws(() => whole.subarray(LIVE_PTR, LIVE_PTR + LIVE_LEN), RangeError);
  });
});

const TYPED_HELPERS = [
  { read: hooks.getArrayF32FromWasm0, View: Float32Array, sample: (i) => i + 0.5 },
  { read: hooks.getArrayF64FromWasm0, View: Float64Array, sample: (i) => -i - 0.25 },
  { read: hooks.getArrayI32FromWasm0, View: Int32Array, sample: (i) => -i - 1 },
  { read: hooks.getArrayU32FromWasm0, View: Uint32Array, sample: (i) => 0xfffffff0 - i },
  { read: hooks.getArrayU8FromWasm0, View: Uint8Array, sample: (i) => (i * 7 + 3) & 0xff },
];

function assertAliasingView({ read, View, sample }, ptr) {
  const direct = new View(memory.buffer, ptr, LIVE_LEN);
  for (let i = 0; i < LIVE_LEN; i++) direct[i] = sample(i);
  const view = read(ptr, LIVE_LEN);
  assert.equal(view.constructor, View);
  assert.equal(view.length, LIVE_LEN);
  assert.equal(view.buffer, memory.buffer);
  assert.equal(view.byteOffset, ptr);
  assert.deepEqual(Array.from(view), Array.from(direct));
  const copy = view.slice();
  view[1] = sample(LIVE_LEN);
  assert.equal(direct[1], sample(LIVE_LEN));
  assert.equal(copy[1], sample(1));
  assert.notEqual(copy.buffer, memory.buffer);
}

function writeBytes(ptr, bytes) {
  new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
}

function readString(ptr, length) {
  return new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, length).slice());
}

const VIEW_POINTERS = [BELOW_CAP, MODELED_EMBEDDER_CAP, ABOVE_CAP, LIVE_PTR];

function assertViewsAboveCap() {
  for (const helper of TYPED_HELPERS) {
    for (const ptr of VIEW_POINTERS) assertAliasingView(helper, ptr);

    const empty = helper.read(LIVE_PTR, 0);
    assert.equal(empty.length, 0);
    assert.equal(empty.byteOffset, LIVE_PTR);
  }
}

function assertViewsSurviveGrowth() {
  memory.grow(1);
  for (const { read } of TYPED_HELPERS) {
    assert.equal(read(LIVE_PTR, LIVE_LEN).buffer, memory.buffer);
  }
}

function assertStringHelpersAboveCap() {
  const text = "kitesurf ✓ 🌊";
  const encoded = new TextEncoder().encode(text);

  writeBytes(ABOVE_CAP, encoded);
  assert.equal(hooks.getStringFromWasm0(ABOVE_CAP, encoded.length), text);

  const mallocAboveCap = () => ABOVE_CAP;
  assert.equal(hooks.passStringToWasm0(text, mallocAboveCap), ABOVE_CAP);
  assert.equal(hooks.vectorLen(), encoded.length);
  assert.equal(readString(ABOVE_CAP, encoded.length), text);

  const reallocs = [];
  const reallocGrowingToLivePtr = (ptr, oldLength) => {
    reallocs.push(ptr);
    if (ptr === LIVE_PTR) return LIVE_PTR;
    memory.grow(1);
    writeBytes(LIVE_PTR, new Uint8Array(memory.buffer, ptr, oldLength).slice());
    return LIVE_PTR;
  };
  assert.equal(hooks.passStringToWasm0(text, mallocAboveCap, reallocGrowingToLivePtr), LIVE_PTR);
  assert.equal(hooks.vectorLen(), encoded.length);
  assert.equal(readString(LIVE_PTR, encoded.length), text);
  assert.deepEqual(reallocs, [ABOVE_CAP, LIVE_PTR]);
}

test("glue memory views stay valid above the embedder cap and across growth", () => {
  withModeledEmbedderCap(() => {
    assertViewsAboveCap();
    assertViewsSurviveGrowth();
    assertStringHelpersAboveCap();
  });
});

test("rewriteWasmMemoryViews rejects wasm-bindgen glue drift", () => {
  const typedWindow = "getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len)";
  assert.throws(() => rewriteWasmMemoryViews(""), /found 0/);
  assert.throws(() => rewriteWasmMemoryViews(`${typedWindow}\n${typedWindow}\n`), /found 2/);
  assert.throws(
    () => rewriteWasmMemoryViews("getInt16ArrayMemory0().subarray(ptr / 2, ptr / 2 + len)"),
    /unrewritten Wasm memory window .*getInt16ArrayMemory0/,
  );
});
