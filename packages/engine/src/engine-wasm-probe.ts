// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// This indirection lets CDP read memory stats without importing wasm.ts and its binary.
interface WasmMemoryProbe {
  bytes(): number;
  initialBytes(): number;
}

let probe: WasmMemoryProbe | null = null;

export function registerEngineWasmProbe(p: WasmMemoryProbe): void {
  probe = p;
}

export function engineWasmBytes(): number {
  return probe ? probe.bytes() : 0;
}

export function engineWasmInitialBytes(): number {
  return probe ? probe.initialBytes() : 0;
}
