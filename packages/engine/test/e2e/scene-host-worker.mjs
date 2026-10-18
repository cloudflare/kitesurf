// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Precompiled import: workerd forbids compiling the downloaded wasm from bytes.
import sceneHost from "../../public/rbi/scene_host.wasm";

const {
  memory,
  ks_alloc: alloc,
  ks_call: call,
  ks_free: free,
} = new WebAssembly.Instance(sceneHost).exports;

export default {
  /** @returns {Promise<Response>} */
  async fetch(request) {
    const op = Number(new URL(request.url).pathname.slice(1));
    const input = new Uint8Array(await request.arrayBuffer());
    const pointer = alloc(input.length);
    new Uint8Array(memory.buffer, pointer, input.length).set(input);
    let packed;
    try {
      packed = call(op, pointer, input.length);
    } finally {
      free(pointer, input.length);
    }
    const outputPointer = Number(packed & 0xffffffffn),
      length = Number(packed >> 32n);
    const output = new Uint8Array(memory.buffer, outputPointer, length).slice();
    if (length) free(outputPointer, length);
    return new Response(output);
  },
};
