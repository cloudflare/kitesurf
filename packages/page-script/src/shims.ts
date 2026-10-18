// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Ambient declarations live in .ts because skipLibCheck skips declaration files.

declare module "cloudflare:workers" {
  // Loaded workers provide this binding; the native reason type is not established in-tree.
  export function abortIsolate(reason?: unknown): void;
}

// Worker Loader supplies this compiled sibling module at runtime.
declare module "*.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
