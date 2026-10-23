// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Initializes core WebAssembly on demand and exposes document, render, and font helpers.

import wasmModule from "../../core/pkg/kitesurf_core_bg.wasm";
import { registerEngineWasmProbe } from "./engine-wasm-probe.ts";
import { setDomFactory } from "./cdp/dom-release.ts";
import {
  initSync,
  DomHandle,
  ks_render_html_to_image,
  ks_scan_document,
  stripFontForShaping as ks_strip_font_for_shaping,
  __setBridgeFetchResource,
} from "kitesurf-core";

let coreWasmMemory: WebAssembly.Memory | null = null;
let coreWasmInitialBytes = 0;

export function getEngineWasmBytes(): number {
  return coreWasmMemory ? coreWasmMemory.buffer.byteLength : 0;
}

export function getEngineWasmInitialBytes(): number {
  return coreWasmInitialBytes;
}

let initialized = false;
// Delay initSync until a parent DOM or render operation needs the core instance.
function ensureInit(): void {
  if (initialized) return;
  __setBridgeFetchResource((_id: number, _url: string, _kind: string) => {});
  // SAFETY: This engine isolate owns the field; PageScript's namesake is separate.
  // TypeScript has no declaration for this private initialization hook.
  // Verified by: packages/engine/test/e2e/target-dom-reclaim.e2e.test.ts.
  const g = globalThis as typeof globalThis & {
    __ks_memprof_imports?: WebAssembly.ModuleImports;
  };
  let memprofImports = g.__ks_memprof_imports;
  if (!memprofImports) {
    memprofImports = new Proxy<WebAssembly.ModuleImports>({}, { get: () => () => {} });
    g.__ks_memprof_imports = memprofImports;
  }
  // Capture exported memory while initSync creates its otherwise-hidden instance.
  const OrigInstance = WebAssembly.Instance;
  // SAFETY: This view narrows the temporary mutation to WebAssembly.Instance only.
  // The platform declaration does not provide a mutable namespace-slot type.
  // Verified by: packages/engine/test/e2e/target-dom-reclaim.e2e.test.ts.
  const wasmNs = WebAssembly as { Instance: typeof WebAssembly.Instance };
  const instrumentedInstance = function Instance(
    module: WebAssembly.Module,
    imports?: WebAssembly.Imports,
  ) {
    if (imports && !imports.wmprof) {
      imports.wmprof = memprofImports;
    }
    const inst = new OrigInstance(module, imports);
    if (inst.exports && inst.exports.memory instanceof WebAssembly.Memory) {
      coreWasmMemory = inst.exports.memory;
    }
    return inst;
  };
  Object.defineProperty(instrumentedInstance, "prototype", { value: OrigInstance.prototype });
  // SAFETY: The wrapper returns a native instance and preserves its prototype.
  // TypeScript cannot infer a constructor signature from this function expression.
  // Verified by: packages/engine/test/e2e/target-dom-reclaim.e2e.test.ts.
  // eslint-disable-next-line kitesurf/no-chained-type-assertions -- Dynamic wasm constructor bridge.
  wasmNs.Instance = instrumentedInstance as unknown as typeof WebAssembly.Instance;
  try {
    initSync({ module: wasmModule });
  } finally {
    wasmNs.Instance = OrigInstance;
  }
  coreWasmInitialBytes = getEngineWasmBytes();
  registerEngineWasmProbe({
    bytes: getEngineWasmBytes,
    initialBytes: getEngineWasmInitialBytes,
  });
  initialized = true;
}

export function createDom(html: string, baseUrl: string): DomHandle {
  ensureInit();
  return new DomHandle(html, baseUrl);
}

setDomFactory(createDom);

export interface ScannedScript {
  src: string | null;
  kind: "classic" | "module";
  defer: boolean;
  async: boolean;
  body: string;
  crossOrigin: string | null;
  integrity: string | null;
  nonce: string | null;
  scriptDomIndex: number;
}

export interface ScannedIframe {
  src: string | null;
  name: string | null;
  loading: string | null;
  docOrderIndex: number;
}

export interface DocScan {
  title: string;
  baseHref: string | null;
  metaCsp: string[];
  importMaps: Array<{
    body: string;
    scriptDomIndex: number;
    baseHref: string | null;
    nonce: string | null;
  }>;
  scripts: ScannedScript[];
  iframes: ScannedIframe[];
}

export function scanDocument(html: string): DocScan {
  ensureInit();
  return JSON.parse(ks_scan_document(html)) as DocScan;
}

export function renderHtmlToImage(
  html: string,
  baseUrl: string,
  width: number,
  height: number,
  format: "png" | "jpeg" | "webp",
  quality: number,
): Uint8Array {
  ensureInit();
  return ks_render_html_to_image(html, baseUrl, width, height, format, quality);
}

export function stripFontForShaping(bytes: Uint8Array): Uint8Array | undefined {
  ensureInit();
  return ks_strip_font_for_shaping(bytes);
}

export type { DomHandle };

export interface ParentScriptDescriptor {
  src: string | null;
  kind: "classic" | "module";
  defer: boolean;
  async: boolean;
  body: string;
  prefetchedSource?: string;
  prefetchError?: string;
  resolvedSrc?: string;
  crossOrigin?: string | null;
  integrity?: string | null;
  nonce?: string | null;
  blocked?: { reason: string; message: string };
  injected?: boolean;
  scriptDomIndex?: number;
}

const EXECUTABLE_SCRIPT_TYPES = new Set([
  "",
  "text/javascript",
  "application/javascript",
  "module",
]);

function scriptInfo(dom: DomHandle, id: number): { attributes?: string[] } | null {
  try {
    return dom.nodeInfo(id) as { attributes?: string[] } | null;
  } catch {
    return null;
  }
}

function scriptAttributes(flat: string[]): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (let j = 0; j + 1 < flat.length; j += 2) {
    const key = flat[j];
    const value = flat[j + 1];
    if (typeof key !== "string" || typeof value !== "string") continue;
    attrs[key.toLowerCase()] = value;
  }
  return attrs;
}

function scriptBody(dom: DomHandle, id: number, src: string): string {
  if (src) return "";
  try {
    return dom.textContent(id) ?? "";
  } catch {
    return "";
  }
}

function isEmptyInlineScript(src: string, body: string): boolean {
  return !src && (!body || !body.trim());
}

function normalizedScriptType(attrs: Record<string, string>): string {
  return (attrs.type || "").trim().toLowerCase();
}

function normalizedScriptSource(attrs: Record<string, string>): string {
  return attrs.src ? String(attrs.src).trim() : "";
}

function scriptKind(rawType: string): "classic" | "module" {
  return rawType === "module" ? "module" : "classic";
}

function nullableScriptSource(src: string): string | null {
  return src || null;
}

function scriptCrossOrigin(attrs: Record<string, string>): string | null {
  return "crossorigin" in attrs ? String(attrs.crossorigin ?? "") : null;
}

function scriptIntegrity(attrs: Record<string, string>): string | null {
  return attrs.integrity?.trim() ? attrs.integrity.trim() : null;
}

function scriptNonce(attrs: Record<string, string>): string | null {
  return attrs.nonce ? attrs.nonce : null;
}

function scriptDescriptorFields(
  attrs: Record<string, string>,
  rawType: string,
  src: string,
  body: string,
  index: number,
): ParentScriptDescriptor {
  return {
    src: nullableScriptSource(src),
    kind: scriptKind(rawType),
    defer: "defer" in attrs,
    async: "async" in attrs,
    body,
    crossOrigin: scriptCrossOrigin(attrs),
    integrity: scriptIntegrity(attrs),
    nonce: scriptNonce(attrs),
    scriptDomIndex: index,
  };
}

function scriptDescriptor(
  dom: DomHandle,
  id: number,
  index: number,
): ParentScriptDescriptor | null {
  const info = scriptInfo(dom, id);
  if (!info) return null;
  const attrs = scriptAttributes(info.attributes || []);
  const rawType = normalizedScriptType(attrs);
  if (!EXECUTABLE_SCRIPT_TYPES.has(rawType)) return null;
  const src = normalizedScriptSource(attrs);
  const body = scriptBody(dom, id, src);
  if (isEmptyInlineScript(src, body)) return null;
  return scriptDescriptorFields(attrs, rawType, src, body, index);
}

function queryScriptIds(dom: DomHandle): Int32Array | number[] | null {
  try {
    return dom.querySelectorAll("script");
  } catch {
    return null;
  }
}

function appendScriptDescriptor(
  out: ParentScriptDescriptor[],
  dom: DomHandle,
  id: number | undefined,
  index: number,
): void {
  if (typeof id !== "number") return;
  const descriptor = scriptDescriptor(dom, id, index);
  if (descriptor) out.push(descriptor);
}

export function extractScriptDescriptorsFromDom(dom: DomHandle | null): ParentScriptDescriptor[] {
  if (!dom) return [];
  const ids = queryScriptIds(dom);
  if (ids === null) return [];
  const out: ParentScriptDescriptor[] = [];
  for (let i = 0; i < ids.length; i++) {
    appendScriptDescriptor(out, dom, ids[i], i);
  }
  return out;
}
