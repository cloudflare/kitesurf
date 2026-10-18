// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Supplies ambient types for PageRenderer's Worker and wasm module imports.

declare module "cloudflare:workers" {
  export function abortIsolate(reason?: Error): void;
}

declare module "*.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
