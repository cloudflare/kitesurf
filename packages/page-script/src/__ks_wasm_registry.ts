// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// @ks-declaration-twin for the runtime-resolved sibling

export type BakedWasmModule = object;

export interface WasmManifestEntry {
  size: number;
  sha256: string;
  head16: string;
  tail16: string;
  bytesB64?: string;
}

export declare const emptyModule: BakedWasmModule;
export declare const bakedWasm: Record<string, BakedWasmModule>;
export declare const manifest: Record<string, WasmManifestEntry>;
