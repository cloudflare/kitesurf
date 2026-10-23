// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Builds classic-script bundles, module tables, and source maps for PageScript.

import type { ParentScriptDescriptor } from "../wasm.ts";
import {
  extractTopLevelDecls,
  hasUseStrictDirective,
  predeclareVarsHead,
  scriptSourceDigest,
} from "@kitesurf/script-gate";
import { type BakedModule, FALLBACK_MODULE_RESOLVER_SOURCE } from "./walk-module-graph.ts";

const INLINE_SCRIPT_BODY_KEY_PREFIX_CHARS = 120;

const VLQ_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function encodeVLQ(value: number): string {
  let v = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = v & 0b11111;
    v >>>= 5;
    if (v > 0) digit |= 0b100000;
    out += VLQ_ALPHABET[digit];
  } while (v > 0);
  return out;
}

function countLines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 0x0a) n++;
  return n;
}

interface ClassicSegment {
  source: string;
  generatedLine: number;
  lineCount: number;
}

function mapClassicSegmentLines(
  lineSegments: string[],
  sourceIndex: number,
  segment: ClassicSegment,
  totalLines: number,
  previousSourceIndex: number,
): void {
  let previousOriginalLine = 0;
  for (let originalLine = 0; originalLine < segment.lineCount; originalLine++) {
    const generatedLine = segment.generatedLine + originalLine;
    if (generatedLine >= totalLines) break;
    const sourceDelta = originalLine === 0 ? sourceIndex - previousSourceIndex : 0;
    lineSegments[generatedLine] =
      encodeVLQ(0) +
      encodeVLQ(sourceDelta) +
      encodeVLQ(originalLine - previousOriginalLine) +
      encodeVLQ(0);
    previousOriginalLine = originalLine;
  }
}

function sourceMapDataUrl(json: string): string {
  try {
    return `data:application/json;base64,${btoa(json)}`;
  } catch {
    return `data:application/json;base64,${btoa(unescape(encodeURIComponent(json)))}`;
  }
}

function buildClassicSourceMap(segments: ClassicSegment[], totalLines: number): string {
  if (segments.length === 0) return "";
  const lineSegments: string[] = new Array(totalLines).fill("");
  let previousSourceIndex = 0;
  for (const [sourceIndex, segment] of segments.entries()) {
    mapClassicSegmentLines(lineSegments, sourceIndex, segment, totalLines, previousSourceIndex);
    previousSourceIndex = sourceIndex;
  }
  const mappings = lineSegments.join(";");
  const map = {
    version: 3,
    file: "",
    sources: segments.map((segment) => segment.source),
    sourcesContent: segments.map(() => null),
    names: [] as string[],
    mappings,
  };
  return sourceMapDataUrl(JSON.stringify(map));
}

export interface ScriptBundle {
  classicRegularSource: string | null;
  classicAsyncSource: string | null;
  moduleScriptUrls: string[];
  additionalModules: Record<string, BakedModule>;
  importMapModuleSource: string;
  classicRegularSourceMapURL?: string;
  classicAsyncSourceMapURL?: string;
  insertedModules: Record<string, string>;
  insertedManifest: InsertedBakeEntry[];
}

export interface InsertedBakeEntry {
  url: string;
  module: string;
  digest: string;
}

export async function insertedSourceDigests(
  bake: readonly ParentScriptDescriptor[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    bake.map(async (d) => {
      const url = d.resolvedSrc ?? d.src;
      if (url && typeof d.prefetchedSource === "string")
        out.set(url, await scriptSourceDigest(d.prefetchedSource));
    }),
  );
  return out;
}

const BLOCKED_CLASSIC_GLOBAL_NAMES = new Set(["module", "exports", "require"]);

function failedClassicSegment(
  descriptor: ParentScriptDescriptor,
  label: string,
): { source: string; sourceLineOffset: number } | null {
  if (descriptor.blocked) {
    return {
      source: `console.error(${JSON.stringify(descriptor.blocked.message)});\n`,
      sourceLineOffset: 0,
    };
  }
  if (descriptor.prefetchError) {
    return {
      source: `console.error(${JSON.stringify(`[${label}] prefetch failed: ${descriptor.prefetchError}`)});\n`,
      sourceLineOffset: 0,
    };
  }
  return null;
}

function classicDescriptorSource(descriptor: ParentScriptDescriptor): string {
  return descriptor.src ? (descriptor.prefetchedSource ?? "") : (descriptor.body ?? "");
}

function withoutTopLevelVarDeclarations(source: string, varSites: number[]): string {
  if (varSites.length === 0) return source;
  const parts: string[] = [];
  let last = 0;
  for (const start of varSites) {
    parts.push(source.slice(last, start), "   ");
    last = start + 3;
  }
  parts.push(source.slice(last));
  return parts.join("");
}

function liveVariableHead(label: string, names: string[]): string {
  if (names.length === 0) return "";
  return `// === ${label} (live-globalize top-level vars) ===\n${predeclareVarsHead(names, "globalThis")}\n`;
}

function promotedTopLevelDeclarations(label: string, names: string[]): string {
  const lines: string[] = [];
  for (const name of names) {
    if (BLOCKED_CLASSIC_GLOBAL_NAMES.has(name)) continue;
    lines.push(
      `try { if (typeof ${name} !== "undefined") globalThis.${name} = ${name}; } catch (e) {}`,
    );
  }
  if (lines.length === 0) return "";
  return `// === ${label} (promote top-level decls to globalThis) ===
${lines.join("\n")}
`;
}

function currentScriptPrefix(
  descriptor: ParentScriptDescriptor,
  bodyKey: string,
  enabled: boolean,
): string {
  if (!enabled) return "";
  const url = currentScriptUrl(descriptor);
  const domIndex = currentScriptDomIndex(descriptor);
  return `__ks_state_local.setCurrentScript(${JSON.stringify(url)}, ${domIndex}, ${JSON.stringify(bodyKey)}, ${JSON.stringify(descriptor.src ?? "")});\n`;
}

function currentScriptUrl(descriptor: ParentScriptDescriptor): string {
  return descriptor.resolvedSrc ?? descriptor.src ?? "";
}

function currentScriptDomIndex(descriptor: ParentScriptDescriptor): number {
  return typeof descriptor.scriptDomIndex === "number" ? descriptor.scriptDomIndex : -1;
}

function classicSegmentBodyKey(descriptor: ParentScriptDescriptor): string {
  if (descriptor.src) return "";
  return (descriptor.body ?? "").trim().slice(0, INLINE_SCRIPT_BODY_KEY_PREFIX_CHARS);
}

function liveClassicVariableNames(names: string[]): string[] {
  return names.filter((name) => !BLOCKED_CLASSIC_GLOBAL_NAMES.has(name));
}

function currentScriptSuffix(enabled: boolean): string {
  return enabled
    ? "if (__ks_state_local.endClassicScript) { await __ks_state_local.endClassicScript(); } else { __ks_state_local.setCurrentScript(null); }\n"
    : "";
}

function buildClassicSegment(
  d: ParentScriptDescriptor,
  index: number,
  opts: { currentScript?: boolean } = {},
): { source: string; sourceLineOffset: number } {
  const label = classicSegmentLabel(d, index);
  const failed = failedClassicSegment(d, label);
  if (failed) return failed;
  const source = classicDescriptorSource(d);
  if (!source.trim()) return { source: "", sourceLineOffset: 0 };
  return compileClassicSegment(d, label, source, opts.currentScript !== false);
}

function compileClassicSegment(
  descriptor: ParentScriptDescriptor,
  label: string,
  source: string,
  currentScript: boolean,
): { source: string; sourceLineOffset: number } {
  const bodyKey = classicSegmentBodyKey(descriptor);
  const scan = extractTopLevelDecls(source);
  const bodySource = withoutTopLevelVarDeclarations(source, scan.varSites);
  const liveVarNames = liveClassicVariableNames(scan.varNames);
  const predeclareHead = liveVariableHead(label, liveVarNames);
  const liveVarSet = new Set(liveVarNames);
  const topDecls = scan.names.filter((n) => !liveVarSet.has(n));
  const promoteTail = promotedTopLevelDeclarations(label, topDecls);
  const prefix =
    `// === ${label} ===\n${predeclareHead}` +
    currentScriptPrefix(descriptor, bodyKey, currentScript);
  return {
    source: `${prefix}${bodySource}\n${promoteTail}${currentScriptSuffix(currentScript)}\n`,
    sourceLineOffset: countLines(prefix),
  };
}

export interface BuildScriptBundleOptions {
  cdpDebug?: boolean;
  additionalModules?: Record<string, BakedModule>;
  importMapModuleSource?: string;
  insertedBake?: ParentScriptDescriptor[];
  insertedDigests?: ReadonlyMap<string, string>;
}

interface ScriptBuckets {
  regularInline: ParentScriptDescriptor[];
  regularDeferred: ParentScriptDescriptor[];
  async: ParentScriptDescriptor[];
  modules: ParentScriptDescriptor[];
}

function isExternalAsyncScript(descriptor: ParentScriptDescriptor): boolean {
  return descriptor.async && Boolean(descriptor.src);
}

function isExternalDeferredScript(descriptor: ParentScriptDescriptor): boolean {
  return descriptor.defer && Boolean(descriptor.src);
}

function bucketScript(descriptor: ParentScriptDescriptor, buckets: ScriptBuckets): void {
  if (descriptor.kind === "module") {
    buckets.modules.push(descriptor);
    return;
  }
  if (isExternalAsyncScript(descriptor)) {
    buckets.async.push(descriptor);
    return;
  }
  if (isExternalDeferredScript(descriptor)) {
    buckets.regularDeferred.push(descriptor);
    return;
  }
  buckets.regularInline.push(descriptor);
}

function bucketScripts(descriptors: ParentScriptDescriptor[]): ScriptBuckets {
  const buckets: ScriptBuckets = {
    regularInline: [],
    regularDeferred: [],
    async: [],
    modules: [],
  };
  for (const descriptor of descriptors) bucketScript(descriptor, buckets);
  return buckets;
}

interface ClassicAccumulator {
  parts: string[];
  lines: number;
}

function pushClassicSegment(
  accumulator: ClassicAccumulator,
  source: string,
  sourceLineOffset: number,
  label: string,
  sourceBody: string,
  metadata: ClassicSegment[],
): void {
  if (!source) return;
  metadata.push({
    source: label,
    generatedLine: accumulator.lines + sourceLineOffset,
    lineCount: countLines(sourceBody) + 1,
  });
  accumulator.parts.push(source);
  accumulator.lines += countLines(source);
}

function classicSegmentLabel(descriptor: ParentScriptDescriptor, index: number): string {
  return descriptor.src ? descriptor.src : `inline#${index}`;
}

function classicSegmentSourceBody(descriptor: ParentScriptDescriptor): string {
  if (descriptor.prefetchError || descriptor.blocked) return "";
  return classicDescriptorSource(descriptor);
}

type ClassicDebugLabel = "regularInline" | "regularDeferred";

function appendClassicSegments(
  descriptors: ParentScriptDescriptor[],
  startIndex: number,
  accumulator: ClassicAccumulator,
  metadata: ClassicSegment[],
  cdpDebug: boolean,
  debugLabel?: ClassicDebugLabel,
): number {
  let index = startIndex;
  for (const descriptor of descriptors) {
    const segment = buildClassicSegment(descriptor, index);
    pushClassicSegment(
      accumulator,
      segment.source,
      segment.sourceLineOffset,
      classicSegmentLabel(descriptor, index),
      classicSegmentSourceBody(descriptor),
      metadata,
    );
    if (cdpDebug && debugLabel !== undefined) {
      console.log(
        `[kitesurf-nav] segment ${debugLabel}#${index} ` +
          `src=${JSON.stringify(descriptor.src)} added=${segment.source.length}chars`,
      );
    }
    index++;
  }
  return index;
}

interface ModuleAccumulator {
  scriptUrls: string[];
  additionalModules: Record<string, BakedModule>;
  walkerSupplied: boolean;
}

function moduleErrorUrl(index: number): string {
  return `https://kitesurf-error.invalid/module-${index}.js`;
}

function moduleFallbackUrl(descriptor: ParentScriptDescriptor, index: number): string {
  const kind = descriptor.src ? "external" : "inline";
  return `https://kitesurf-fallback.invalid/${kind}-${index}.js`;
}

function appendBlockedModule(
  descriptor: ParentScriptDescriptor,
  index: number,
  accumulator: ModuleAccumulator,
): boolean {
  if (!descriptor.blocked) return false;
  const url = moduleErrorUrl(index);
  accumulator.additionalModules[url] =
    `console.error(${JSON.stringify(descriptor.blocked.message)});\nexport {};\n`;
  accumulator.scriptUrls.push(url);
  return true;
}

function modulePrefetchErrorSource(descriptor: ParentScriptDescriptor): string {
  const label = descriptor.src || "inline-module";
  return `console.error(${JSON.stringify(
    `[${label}] module prefetch failed: ${descriptor.prefetchError}`,
  )});\nexport {};\n`;
}

function appendModulePrefetchError(
  descriptor: ParentScriptDescriptor,
  index: number,
  accumulator: ModuleAccumulator,
): boolean {
  if (!descriptor.prefetchError) return false;
  const url = moduleErrorUrl(index);
  accumulator.additionalModules[url] = modulePrefetchErrorSource(descriptor);
  accumulator.scriptUrls.push(url);
  return true;
}

function resolvedModuleUrl(descriptor: ParentScriptDescriptor, index: number): string {
  if (descriptor.resolvedSrc) return descriptor.resolvedSrc;
  return moduleFallbackUrl(descriptor, index);
}

function setModuleSourceIfMissing(
  accumulator: ModuleAccumulator,
  url: string,
  source: string,
): void {
  if (!accumulator.walkerSupplied || accumulator.additionalModules[url] === undefined) {
    accumulator.additionalModules[url] = source;
  }
}

function appendModuleDescriptor(
  descriptor: ParentScriptDescriptor,
  index: number,
  accumulator: ModuleAccumulator,
): void {
  if (appendBlockedModule(descriptor, index, accumulator)) return;
  if (appendModulePrefetchError(descriptor, index, accumulator)) return;
  const source = classicDescriptorSource(descriptor);
  if (!source.trim()) return;
  const url = resolvedModuleUrl(descriptor, index);
  setModuleSourceIfMissing(accumulator, url, source);
  accumulator.scriptUrls.push(url);
}

function appendModuleDescriptors(
  descriptors: ParentScriptDescriptor[],
  accumulator: ModuleAccumulator,
): void {
  for (const [index, descriptor] of descriptors.entries()) {
    appendModuleDescriptor(descriptor, index, accumulator);
  }
}

const UMD_SHADOW = "var module=undefined,exports=undefined,require=undefined;\n";
const STATE_LOCAL_DECL =
  'var __ks_state_local = (await import("./internal-state.js")).getInternalState();\n';

function productionWrapper(body: string, strict = false): string {
  return `module.exports.run = async function () {
${strict ? '"use strict"; ' : ""}${STATE_LOCAL_DECL}${UMD_SHADOW}${body}
};
`;
}

function debugWrapper(body: string): string {
  return `module.exports.run = async function () {
${STATE_LOCAL_DECL}${UMD_SHADOW}var __ks_diag = __ks_state_local.bundleDiag = {
  entered: true,
  exited: false,
  bodyChars: ${JSON.stringify(body.length)},
  entryDom: null,
  exitDom: null,
};
console.log('[kitesurf-debug] bundle body entered, bodyChars=' + ${JSON.stringify(body.length)});
try {
  var __ks_doc = (typeof document !== 'undefined') ? document : null;
  var __ks_root = __ks_doc && __ks_doc.getElementById ? __ks_doc.getElementById('root') : null;
  var __ks_body = __ks_doc ? __ks_doc.body : null;
  var __ks_entry = {
    hasDocument: !!__ks_doc,
    hasBody: !!__ks_body,
    bodyChildCount: __ks_body && __ks_body.children ? __ks_body.children.length : -1,
    rootExists: !!__ks_root,
    rootTag: __ks_root && __ks_root.tagName ? __ks_root.tagName : null,
    rootChildCount: __ks_root && __ks_root.children ? __ks_root.children.length : -1
  };
  __ks_diag.entryDom = __ks_entry;
  console.log('[kitesurf-debug] entryDom', JSON.stringify(__ks_entry));
} catch (e) {
  __ks_diag.entryDom = { error: String(e && e.message || e) };
  console.log('[kitesurf-debug] entryDom snapshot threw:', String(e && e.message || e));
}
${body}
console.log('[kitesurf-debug] bundle body completed (last user statement returned)');
try {
  var __ks_doc2 = (typeof document !== 'undefined') ? document : null;
  var __ks_root2 = __ks_doc2 && __ks_doc2.getElementById ? __ks_doc2.getElementById('root') : null;
  var __ks_body2 = __ks_doc2 ? __ks_doc2.body : null;
  var __ks_exit = {
    bodyChildCount: __ks_body2 && __ks_body2.children ? __ks_body2.children.length : -1,
    rootChildCount: __ks_root2 && __ks_root2.children ? __ks_root2.children.length : -1,
    rootTextLen: __ks_root2 && typeof __ks_root2.textContent === 'string' ? __ks_root2.textContent.length : -1
  };
  __ks_diag.exitDom = __ks_exit;
  console.log('[kitesurf-debug] exitDom', JSON.stringify(__ks_exit));
} catch (e) {
  __ks_diag.exitDom = { error: String(e && e.message || e) };
  console.log('[kitesurf-debug] exitDom snapshot threw:', String(e && e.message || e));
}
__ks_diag.exited = true;
};
`;
}

function wrapBundleBody(body: string, cdpDebug: boolean): string {
  return cdpDebug ? debugWrapper(body) : productionWrapper(body);
}

function wrapperHeaderLineCount(cdpDebug: boolean): number {
  const wrapEmpty = wrapBundleBody("", cdpDebug);
  const wrapHeaderLines =
    wrapEmpty.indexOf("\n};\n") >= 0
      ? countLines(wrapEmpty.slice(0, wrapEmpty.indexOf("\n};\n")))
      : countLines(wrapEmpty);
  return wrapHeaderLines;
}

function finalizeClassicSource(
  body: string,
  bundleUrl: string,
  segments: ClassicSegment[],
  cdpDebug: boolean,
  wrapperHeaderLines: number,
): { source: string; sourceMapURL: string } {
  const wrapped = wrapBundleBody(body, cdpDebug);
  const shifted = segments.map((segment) => ({
    ...segment,
    generatedLine: segment.generatedLine + wrapperHeaderLines,
  }));
  const totalLines = countLines(wrapped) + 1;
  const sourceMapURL = buildClassicSourceMap(shifted, totalLines);
  const directives =
    `\n//# sourceURL=${bundleUrl}\n` +
    (sourceMapURL ? `//# sourceMappingURL=${sourceMapURL}\n` : "");
  return { source: wrapped + directives, sourceMapURL };
}

interface FinalizedClassicSource {
  source: string | null;
  sourceMapURL: string;
}

function finalizeIfPresent(
  body: string,
  bundleUrl: string,
  segments: ClassicSegment[],
  cdpDebug: boolean,
  wrapperHeaderLines: number,
): FinalizedClassicSource {
  if (body.length === 0) return { source: null, sourceMapURL: "" };
  return finalizeClassicSource(body, bundleUrl, segments, cdpDebug, wrapperHeaderLines);
}

interface InsertedModules {
  modules: Record<string, string>;
  manifest: InsertedBakeEntry[];
}

interface InsertedBakeCandidate {
  source: string | undefined;
  url: string | undefined;
  digest: string | undefined;
}

interface ValidInsertedBake extends InsertedBakeCandidate {
  source: string;
  url: string;
  digest: string;
}

function insertedBakeEntry(
  descriptor: ParentScriptDescriptor,
  digests: ReadonlyMap<string, string> | undefined,
): { source: string; url: string; digest: string } | null {
  const candidate: InsertedBakeCandidate = {
    source: descriptor.prefetchedSource,
    url: insertedDescriptorUrl(descriptor),
    digest: undefined,
  };
  candidate.digest = insertedSourceDigest(candidate.url, digests);
  if (!isValidInsertedBake(candidate)) return null;
  return candidate;
}

function insertedDescriptorUrl(descriptor: ParentScriptDescriptor): string | undefined {
  if (descriptor.resolvedSrc) return descriptor.resolvedSrc;
  return descriptor.src ?? undefined;
}

function insertedSourceDigest(
  url: string | undefined,
  digests: ReadonlyMap<string, string> | undefined,
): string | undefined {
  if (url === undefined) return undefined;
  return digests?.get(url);
}

function isValidInsertedBake(candidate: InsertedBakeCandidate): candidate is ValidInsertedBake {
  if (typeof candidate.source !== "string") return false;
  if (!candidate.source.trim()) return false;
  if (!candidate.url) return false;
  if (!candidate.digest) return false;
  return true;
}

function buildInsertedModules(options: BuildScriptBundleOptions): InsertedModules {
  const modules: Record<string, string> = {};
  const manifest: InsertedBakeEntry[] = [];
  for (const [index, descriptor] of (options.insertedBake ?? []).entries()) {
    const baked = insertedBakeEntry(descriptor, options.insertedDigests);
    if (!baked) continue;
    const module = `__ks_inserted_${index}.js`;
    modules[module] =
      productionWrapper(
        buildClassicSegment(descriptor, index, { currentScript: false }).source,
        hasUseStrictDirective(baked.source),
      ) + `\n//# sourceURL=${baked.url}\n`;
    manifest.push({ url: baked.url, module, digest: baked.digest });
  }
  return { modules, manifest };
}

function logScriptBuckets(buckets: ScriptBuckets): void {
  console.log(
    `[kitesurf-nav] bucketize: regularInline=${buckets.regularInline.length} ` +
      `regularDeferred=${buckets.regularDeferred.length} ` +
      `async=${buckets.async.length} modules=${buckets.modules.length}`,
  );
}

export function buildScriptBundle(
  descriptors: ParentScriptDescriptor[],
  options: BuildScriptBundleOptions = {},
): ScriptBundle {
  const cdpDebug = options.cdpDebug === true;
  const buckets = bucketScripts(descriptors);
  if (cdpDebug) logScriptBuckets(buckets);

  const regularAccumulator: ClassicAccumulator = { parts: [], lines: 0 };
  const asyncAccumulator: ClassicAccumulator = { parts: [], lines: 0 };
  const regularMetadata: ClassicSegment[] = [];
  const asyncMetadata: ClassicSegment[] = [];
  const regularIndex = appendClassicSegments(
    buckets.regularInline,
    0,
    regularAccumulator,
    regularMetadata,
    cdpDebug,
    "regularInline",
  );
  appendClassicSegments(
    buckets.regularDeferred,
    regularIndex,
    regularAccumulator,
    regularMetadata,
    cdpDebug,
    "regularDeferred",
  );
  appendClassicSegments(buckets.async, 0, asyncAccumulator, asyncMetadata, cdpDebug);

  const moduleAccumulator: ModuleAccumulator = {
    scriptUrls: [],
    additionalModules: { ...(options.additionalModules ?? {}) },
    walkerSupplied: options.additionalModules != null,
  };
  appendModuleDescriptors(buckets.modules, moduleAccumulator);

  const regularBody = regularAccumulator.parts.join("");
  const asyncBody = asyncAccumulator.parts.join("");
  const wrapperLines = wrapperHeaderLineCount(cdpDebug);
  const regular = finalizeIfPresent(
    regularBody,
    "/__ks_user_classic_regular.js",
    regularMetadata,
    cdpDebug,
    wrapperLines,
  );
  const async = finalizeIfPresent(
    asyncBody,
    "/__ks_user_classic_async.js",
    asyncMetadata,
    cdpDebug,
    wrapperLines,
  );
  const inserted = buildInsertedModules(options);

  return {
    insertedModules: inserted.modules,
    insertedManifest: inserted.manifest,
    classicRegularSource: regular.source,
    classicAsyncSource: async.source,
    moduleScriptUrls: moduleAccumulator.scriptUrls,
    additionalModules: moduleAccumulator.additionalModules,
    importMapModuleSource: options.importMapModuleSource ?? FALLBACK_MODULE_RESOLVER_SOURCE,
    classicRegularSourceMapURL: regular.sourceMapURL,
    classicAsyncSourceMapURL: async.sourceMapURL,
  };
}
