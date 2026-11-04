// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Consumes per-navigation inputs and prepares wasm and dynamic import before scripts run.

import {
  cdpDebug as startupCdpDebug,
  csp as startupCsp,
  metaCsp as startupMetaCsp,
  lagWatchdog as startupLagWatchdog,
  resourceDrainQuietTurns as startupResourceDrainQuietTurns,
  hasClassicAsync as startupHasClassicAsync,
  insertedBaked as startupInsertedBaked,
  hasClassicRegular as startupHasClassicRegular,
  html as startupHtml,
  moduleScriptCount as startupModuleScriptCount,
  moduleScriptUrls as startupModuleScriptUrls,
  jsonModuleUrls as startupJsonModuleUrls,
  cookies as startupCookies,
  pixelFree as startupPixelFree,
  fontDefer as startupFontDefer,
  fontProfile as startupFontProfile,
  scriptDescriptors as startupScriptDescriptors,
  url as startupUrl,
  userAgent as startupUserAgent,
  referrer as startupReferrer,
  referrerPolicy as startupReferrerPolicy,
} from "./__ks_startup_probe_input.js";
import { initSync, ks_bridge_install_desc_helpers } from "./wasm-glue.js";
import wasmModule from "./core_bg.wasm";

import { ksInternals } from "./internals.ts";

let coreWasmMemory: WebAssembly.Memory | null = null;
const OriginalWebAssemblyInstance = WebAssembly.Instance;
// FFI: observe wasm-bindgen init for memprof imports and core-memory capture.
const trackedInstance = new Proxy(OriginalWebAssemblyInstance, {
  construct(target, argumentsList) {
    const imports: unknown = argumentsList[1];
    if (
      imports &&
      (typeof imports === "object" || typeof imports === "function") &&
      ksInternals.memprofImports
    ) {
      Object.assign(imports, { wmprof: ksInternals.memprofImports });
    }
    const instance = Reflect.construct(target, argumentsList);
    if (
      instance instanceof OriginalWebAssemblyInstance &&
      instance.exports &&
      instance.exports.memory instanceof WebAssembly.Memory
    ) {
      coreWasmMemory = instance.exports.memory;
    }
    return instance;
  },
});
Object.assign(WebAssembly, { Instance: trackedInstance });

initSync({ module: wasmModule });
// One V8 object per bridged descriptor instead of four Reflect.set crossings. A
// null-rooted class prototype keeps a page's Object.prototype.get out, and the map fast.
class DataDesc {
  readonly value: unknown;
  readonly writable: boolean;
  readonly enumerable: boolean;
  readonly configurable: boolean;
  constructor(value: unknown, flags: number) {
    this.value = value;
    this.writable = (flags & 1) !== 0;
    this.enumerable = (flags & 2) !== 0;
    this.configurable = (flags & 4) !== 0;
  }
}
Object.setPrototypeOf(DataDesc.prototype, null);
class AccessorDesc {
  readonly get: unknown;
  readonly set: unknown;
  readonly enumerable: boolean;
  readonly configurable: boolean;
  constructor(get: unknown, set: unknown, flags: number) {
    this.get = get;
    this.set = set;
    this.enumerable = (flags & 2) !== 0;
    this.configurable = (flags & 4) !== 0;
  }
}
Object.setPrototypeOf(AccessorDesc.prototype, null);
ks_bridge_install_desc_helpers(
  (value, flags) => new DataDesc(value, flags),
  (get, set, flags) => new AccessorDesc(get, set, flags),
);
Object.assign(WebAssembly, { Instance: OriginalWebAssemblyInstance });

const coreWasmInitialBytes = getCoreWasmMemoryBytes();

export function getCoreWasmMemoryBytes(): number {
  return coreWasmMemory ? coreWasmMemory.buffer.byteLength : 0;
}

export function getCoreWasmMemoryInitialBytes(): number {
  return coreWasmInitialBytes;
}

export {
  coreWasmMemory,
  startupCdpDebug,
  startupLagWatchdog,
  startupResourceDrainQuietTurns,
  startupCookies,
  startupPixelFree,
  startupFontDefer,
  startupFontProfile,
  startupHasClassicAsync,
  startupInsertedBaked,
  startupHasClassicRegular,
  startupHtml,
  startupModuleScriptCount,
  startupModuleScriptUrls,
  startupJsonModuleUrls,
  startupScriptDescriptors,
  startupUrl,
  startupUserAgent,
  startupReferrer,
  startupReferrerPolicy,
  startupCsp,
  startupMetaCsp,
};

const STARTUP_SCRIPT_DESCRIPTOR_SAMPLE_SIZE = 5;

export const startupInputSnapshot = {
  hasHtml: typeof startupHtml === "string",
  htmlLength: typeof startupHtml === "string" ? startupHtml.length : 0,
  url: startupUrl,
  hasCookies: typeof startupCookies === "string" && startupCookies.length > 0,
  scriptDescriptorCount: Array.isArray(startupScriptDescriptors)
    ? startupScriptDescriptors.length
    : 0,
  scriptDescriptorSample: Array.isArray(startupScriptDescriptors)
    ? startupScriptDescriptors
        .slice(0, STARTUP_SCRIPT_DESCRIPTOR_SAMPLE_SIZE)
        .map((descriptor) => ({
          src: descriptor.src,
          kind: descriptor.kind,
          defer: descriptor.defer,
          async: descriptor.async,
          bodyLen: typeof descriptor.body === "string" ? descriptor.body.length : 0,
          prefetchedLen: descriptor.prefetchedLength ?? 0,
          prefetchError: descriptor.prefetchError || null,
        }))
    : [],
};

let dynamicImport: ((spec: string) => Promise<Record<string, unknown>>) | null = null;

try {
  const AsyncFunctionConstructor = (async () => {}).constructor as new (
    ...args: string[]
  ) => (spec: string) => Promise<Record<string, unknown>>;
  dynamicImport = new AsyncFunctionConstructor("spec", "return await import(spec);");
} catch {
  dynamicImport = null;
}

export function importModule(spec: string): Promise<Record<string, unknown>> {
  if (!dynamicImport) throw new TypeError("dynamic import() is unavailable");
  return dynamicImport(spec);
}
