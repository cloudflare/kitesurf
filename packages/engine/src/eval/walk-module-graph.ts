// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Resolves and fetches module graphs using import maps and shared script-gate checks.

import { parse as lexerParse } from "es-module-lexer/js";
import {
  checkScriptBeforeFetch,
  checkScriptResponse,
  type ModuleType,
  type ScriptGateContext,
} from "@kitesurf/script-gate";
import { KITESURF_NOSNIFF_HEADER } from "@kitesurf/script-gate/gateway-headers";
import type { ParentScriptDescriptor } from "../wasm.ts";
import type { SandboxOutboundOverride } from "./outbound.ts";
import { localTraceParentProps } from "../tracing-local.ts";
import { walkRedirects } from "./redirect-walk.ts";

function inlineModuleUrl(pageUrl: string, index: number): string {
  if (!pageUrl) return `https://kitesurf-inline.invalid/${index}.js`;
  try {
    return new URL(`__kitesurf_inline_${index}.js`, pageUrl).toString();
  } catch {
    return `https://kitesurf-inline.invalid/${index}.js`;
  }
}

function pageOriginFromUrl(pageUrl: string): string {
  try {
    const u = new URL(pageUrl);
    return u.protocol + "//" + u.host;
  } catch {
    return "";
  }
}

function resolveAgainstImporter(specifier: string, importer: string): string | null {
  try {
    return new URL(specifier, importer).toString();
  } catch {
    return null;
  }
}

function isUrlLikeSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("/") ||
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    /^[A-Za-z][A-Za-z\d+.-]*:/.test(specifier)
  );
}

export interface ParsedImportMap {
  imports: Map<string, string | null>;
  scopes: Map<string, Map<string, string | null>>;
}

type ImportMapScope = readonly [string, Map<string, string | null>];
const sortedScopesByMap = new WeakMap<ParsedImportMap, readonly ImportMapScope[]>();

const SPECIAL_SCHEMES = new Set(["ftp:", "file:", "http:", "https:", "ws:", "wss:"]);

function parseUrlLikeSpecifier(specifier: string, baseUrl: string): URL | null {
  const baseRelative =
    specifier.startsWith("/") || specifier.startsWith("./") || specifier.startsWith("../");
  try {
    return baseRelative ? new URL(specifier, baseUrl) : new URL(specifier);
  } catch {
    return null;
  }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSpecifierMapKey(rawKey: string, baseUrl: string): string {
  return parseUrlLikeSpecifier(rawKey, baseUrl)?.href ?? rawKey;
}

function parseSpecifierMapAddress(rawValue: unknown, baseUrl: string): string | null {
  if (typeof rawValue !== "string") return null;
  return parseUrlLikeSpecifier(rawValue, baseUrl)?.href ?? null;
}

function validSpecifierMapAddress(key: string, address: string | null): string | null {
  if (address === null) return null;
  if (key.endsWith("/") && !address.endsWith("/")) return null;
  return address;
}

function parseSpecifierMapEntry(
  out: Map<string, string | null>,
  rawKey: string,
  rawValue: unknown,
  baseUrl: string,
): void {
  if (rawKey === "") return;
  const key = parseSpecifierMapKey(rawKey, baseUrl);
  const address = parseSpecifierMapAddress(rawValue, baseUrl);
  out.set(key, validSpecifierMapAddress(key, address));
}

function parseSpecifierMap(value: unknown, baseUrl: string): Map<string, string | null> | null {
  if (!isRecordValue(value)) return null;
  const out = new Map<string, string | null>();
  for (const [rawKey, rawValue] of Object.entries(value)) {
    parseSpecifierMapEntry(out, rawKey, rawValue, baseUrl);
  }
  return out;
}

type ParsedScopeEntry = { ok: true; entry: ImportMapScope | null } | { ok: false };

function parseScopeEntry(rawScope: string, mappings: unknown, baseUrl: string): ParsedScopeEntry {
  const specifierMap = parseSpecifierMap(mappings, baseUrl);
  if (specifierMap === null) return { ok: false };
  try {
    return { ok: true, entry: [new URL(rawScope, baseUrl).href, specifierMap] };
  } catch {
    return { ok: true, entry: null };
  }
}

function parseImportMapScopes(
  value: unknown,
  baseUrl: string,
): Map<string, Map<string, string | null>> | null {
  if (value === undefined) return new Map();
  if (!isRecordValue(value)) return null;
  const scopes = new Map<string, Map<string, string | null>>();
  for (const [rawScope, mappings] of Object.entries(value)) {
    if (!addImportMapScope(scopes, rawScope, mappings, baseUrl)) return null;
  }
  return scopes;
}

function addImportMapScope(
  scopes: Map<string, Map<string, string | null>>,
  rawScope: string,
  mappings: unknown,
  baseUrl: string,
): boolean {
  const parsed = parseScopeEntry(rawScope, mappings, baseUrl);
  if (!parsed.ok) return false;
  if (parsed.entry) scopes.set(...parsed.entry);
  return true;
}

function parseImportMapRecord(source: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  if (!isRecordValue(parsed)) return null;
  return parsed;
}

export function parseImportMap(source: string, baseUrl: string): ParsedImportMap | null {
  const record = parseImportMapRecord(source);
  if (!record) return null;
  const imports =
    record.imports === undefined ? new Map() : parseSpecifierMap(record.imports, baseUrl);
  if (imports === null) return null;
  const scopes = parseImportMapScopes(record.scopes, baseUrl);
  if (scopes === null) return null;
  return { imports, scopes };
}

export interface ResolvedModuleRecord {
  referrer: string;
  specifier: string;
  prefixMatchable: boolean;
}

export function resolvedModuleRecord(specifier: string, referrer: string): ResolvedModuleRecord {
  const asUrl = parseUrlLikeSpecifier(specifier, referrer);
  return {
    referrer,
    specifier: asUrl?.href ?? specifier,
    prefixMatchable: asUrl === null || SPECIAL_SCHEMES.has(asUrl.protocol),
  };
}

function scopeMatches(scopePrefix: string, referrer: string): boolean {
  return (
    scopePrefix === referrer || (scopePrefix.endsWith("/") && referrer.startsWith(scopePrefix))
  );
}

function scopesBySpecificity(importMap: ParsedImportMap): readonly ImportMapScope[] {
  const cached = sortedScopesByMap.get(importMap);
  if (cached) return cached;
  const sorted = [...importMap.scopes.entries()].sort(([a], [b]) => b.length - a.length);
  sortedScopesByMap.set(importMap, sorted);
  return sorted;
}

function ruleMatchesRecord(key: string, record: ResolvedModuleRecord): boolean {
  return (
    key === record.specifier ||
    (record.prefixMatchable && key.endsWith("/") && record.specifier.startsWith(key))
  );
}

export function mergeImportMap(
  target: ParsedImportMap,
  incoming: ParsedImportMap,
  resolved: readonly ResolvedModuleRecord[] = [],
): void {
  sortedScopesByMap.delete(target);
  mergeScopedImportMappings(target.scopes, incoming.scopes, resolved);
  mergeGlobalImportMappings(target.imports, incoming.imports, resolved);
}

function mappingAlreadyResolved(
  scopePrefix: string,
  key: string,
  resolved: readonly ResolvedModuleRecord[],
): boolean {
  return resolved.some(
    (record) => scopeMatches(scopePrefix, record.referrer) && ruleMatchesRecord(key, record),
  );
}

function unresolvedScopedMappings(
  scopePrefix: string,
  mappings: ReadonlyMap<string, string | null>,
  resolved: readonly ResolvedModuleRecord[],
): Map<string, string | null> {
  const kept = new Map<string, string | null>();
  for (const [key, address] of mappings) {
    if (!mappingAlreadyResolved(scopePrefix, key, resolved)) kept.set(key, address);
  }
  return kept;
}

function mergeScopeEntry(
  target: Map<string, Map<string, string | null>>,
  scopePrefix: string,
  mappings: ReadonlyMap<string, string | null>,
  resolved: readonly ResolvedModuleRecord[],
): void {
  const kept = unresolvedScopedMappings(scopePrefix, mappings, resolved);
  const existing = target.get(scopePrefix);
  if (!existing) {
    target.set(scopePrefix, kept);
    return;
  }
  for (const [key, address] of kept) {
    if (!existing.has(key)) existing.set(key, address);
  }
}

function mergeScopedImportMappings(
  target: Map<string, Map<string, string | null>>,
  incoming: ReadonlyMap<string, Map<string, string | null>>,
  resolved: readonly ResolvedModuleRecord[],
): void {
  for (const [scopePrefix, mappings] of incoming) {
    mergeScopeEntry(target, scopePrefix, mappings, resolved);
  }
}

function globalMappingAlreadyResolved(
  key: string,
  resolved: readonly ResolvedModuleRecord[],
): boolean {
  return resolved.some((record) => ruleMatchesRecord(key, record));
}

function mergeGlobalImportMappings(
  target: Map<string, string | null>,
  incoming: ReadonlyMap<string, string | null>,
  resolved: readonly ResolvedModuleRecord[],
): void {
  for (const [key, address] of incoming) {
    if (globalMappingAlreadyResolved(key, resolved)) continue;
    if (!target.has(key)) target.set(key, address);
  }
}

export function parseImportMaps(
  sources: readonly (string | { source: string; baseUrl: string })[],
  baseUrl: string,
): ParsedImportMap {
  const result: ParsedImportMap = { imports: new Map(), scopes: new Map() };
  for (const input of sources) {
    const source = typeof input === "string" ? input : input.source;
    const sourceBaseUrl = typeof input === "string" ? baseUrl : input.baseUrl;
    const map = parseImportMap(source, sourceBaseUrl);
    if (map) mergeImportMap(result, map);
  }
  return result;
}

function resolveInSpecifierMap(
  normalized: string,
  asUrl: URL | null,
  mappings: ReadonlyMap<string, string | null>,
): string | null | undefined {
  if (mappings.has(normalized)) return mappings.get(normalized);
  if (asUrl !== null && !SPECIAL_SCHEMES.has(asUrl.protocol)) return undefined;
  return resolveLongestPrefix(normalized, mappings);
}

function isLongerPrefixMatch(key: string, normalized: string, bestKey: string): boolean {
  return key.endsWith("/") && normalized.startsWith(key) && key.length > bestKey.length;
}

function resolvePrefixAddress(
  normalized: string,
  key: string,
  address: string | null,
): string | null {
  if (address === null) return null;
  try {
    const resolved = new URL(normalized.slice(key.length), address).href;
    return resolved.startsWith(address) ? resolved : null;
  } catch {
    return null;
  }
}

function resolveLongestPrefix(
  normalized: string,
  mappings: ReadonlyMap<string, string | null>,
): string | null | undefined {
  let bestKey = "";
  let bestAddress: string | null | undefined;
  for (const [key, address] of mappings) {
    if (!isLongerPrefixMatch(key, normalized, bestKey)) continue;
    bestKey = key;
    bestAddress = resolvePrefixAddress(normalized, key, address);
  }
  return bestAddress;
}

export function importMapModuleSource(
  importMap: ParsedImportMap,
  registryNames: ReadonlyMap<string, string> = new Map(),
): string {
  const imports = JSON.stringify([...importMap.imports]);
  const scopes = JSON.stringify(
    scopesBySpecificity(importMap).map(([scope, mappings]) => [scope, [...mappings]]),
  );
  const registryAliases = JSON.stringify([...registryNames]);
  return `const imports=new Map(${imports});
 const scopes=${scopes}.map(([scope,mappings])=>[scope,new Map(mappings)]);
 const registryAliases=new Map(${registryAliases});
 const special=new Set(["ftp:","file:","http:","https:","ws:","wss:"]);
 function asUrl(s,base){try{return s.startsWith("/")||s.startsWith("./")||s.startsWith("../")?new URL(s,base):new URL(s)}catch{return null}}
 function inMap(normalized,url,mappings){if(mappings.has(normalized))return mappings.get(normalized);if(url!==null&&!special.has(url.protocol))return undefined;let best="",answer;for(const [key,address] of mappings){if(!key.endsWith("/")||!normalized.startsWith(key)||key.length<=best.length)continue;best=key;if(address===null){answer=null;continue}try{const resolved=new URL(normalized.slice(key.length),address).href;answer=resolved.startsWith(address)?resolved:null}catch{answer=null}}return answer}
 export function resolveImportMap(specifier,importer){specifier=String(specifier);const url=asUrl(specifier,importer);const normalized=url?url.href:specifier;for(const [scope,mappings] of scopes){if(scope!==importer&&(!scope.endsWith("/")||!importer.startsWith(scope)))continue;const resolved=inMap(normalized,url,mappings);if(resolved===undefined)continue;if(resolved===null)throw new TypeError("Import map blocked module specifier: "+specifier);return resolved}const mapped=inMap(normalized,url,imports);if(mapped!==undefined){if(mapped===null)throw new TypeError("Import map blocked module specifier: "+specifier);return mapped}if(url===null)throw new TypeError("Bare module specifier requires an import map: "+specifier);return normalized}
 export function resolveModuleRegistryUrl(url){url=String(url);return registryAliases.get(url)??url}
 `;
}

export const FALLBACK_MODULE_RESOLVER_SOURCE = importMapModuleSource({
  imports: new Map(),
  scopes: new Map(),
});

export function resolveImportMapSpecifier(
  specifier: string,
  importer: string,
  importMap: ParsedImportMap,
): string | null {
  const { asUrl, normalized } = normalizeModuleSpecifier(specifier, importer);
  const scoped = resolveInScopes(normalized, asUrl, importer, importMap);
  if (scoped !== undefined) return scoped;
  const mapped = resolveInSpecifierMap(normalized, asUrl, importMap.imports);
  if (mapped !== undefined) return mapped;
  return unresolvedModuleSpecifier(asUrl);
}

function normalizeModuleSpecifier(
  specifier: string,
  importer: string,
): {
  asUrl: URL | null;
  normalized: string;
} {
  const asUrl = parseUrlLikeSpecifier(specifier, importer);
  return { asUrl, normalized: asUrl?.href ?? specifier };
}

function unresolvedModuleSpecifier(asUrl: URL | null): string | null {
  return asUrl === null ? null : asUrl.href;
}

function resolveInScopes(
  normalized: string,
  asUrl: URL | null,
  importer: string,
  importMap: ParsedImportMap,
): string | null | undefined {
  for (const [scope, mappings] of scopesBySpecificity(importMap)) {
    if (!scopeMatches(scope, importer)) continue;
    const resolved = resolveInSpecifierMap(normalized, asUrl, mappings);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

type LexedImport = ReturnType<typeof lexerParse>[0][number];

function dynamicImportExpression(body: string, imp: LexedImport): string {
  if (imp.a < 0) return body.slice(imp.d + 1, imp.se - 1);
  const withSeparator = body.slice(imp.d + 1, imp.a);
  return withSeparator.slice(0, withSeparator.lastIndexOf(","));
}

function nativelyResolvesTo(specifier: string, importer: string, target: string): boolean {
  return resolveAgainstImporter(specifier, importer) === target;
}

function isSpecifierQuote(quote: string | undefined): boolean {
  return quote === '"' || quote === "'" || quote === "`";
}

function hasDynamicSpecifierContent(value: string, quote: string | undefined): boolean {
  return value.includes("${") || value.includes("\\") || value.includes(quote ?? "");
}

function constSpecifier(raw: string): string | null {
  const source = raw.trim();
  if (source.length < 2) return null;
  const quote = source[0];
  if (!isSpecifierQuote(quote) || source[source.length - 1] !== quote) return null;
  const inner = source.slice(1, -1);
  if (hasDynamicSpecifierContent(inner, quote)) return null;
  return inner;
}

function importMetaResolveEnd(
  source: string,
  imp: ReturnType<typeof lexerParse>[0][number],
): number | null {
  const match = /^(?:\s*\.\s*resolve\b|\s*\[\s*(["'])resolve\1\s*\])/.exec(source.slice(imp.se));
  return match ? imp.se + match[0].length : null;
}

export function rewriteImportMetaResolve(
  expression: string,
  importer: string,
  syntheticImportMeta?: string,
): string {
  const imports = tryParseImports(expression);
  if (imports === null) return expression;
  return applyRewritesReverse(
    expression,
    collectImportMetaRewrites(expression, importer, syntheticImportMeta, imports),
  );
}

function tryParseImports(source: string): ReturnType<typeof lexerParse>[0] | null {
  try {
    return lexerParse(source)[0];
  } catch {
    return null;
  }
}

interface SourceRewrite {
  start: number;
  end: number;
  text: string;
}

function importMetaRewrite(
  expression: string,
  importer: string,
  syntheticImportMeta: string | undefined,
  imp: ReturnType<typeof lexerParse>[0][number],
): SourceRewrite | null {
  if (imp.t !== 3) return null;
  if (syntheticImportMeta) {
    return { start: imp.ss, end: imp.se, text: syntheticImportMeta };
  }
  const end = importMetaResolveEnd(expression, imp);
  if (end === null) return null;
  const text = `((specifier) => globalThis.__ks_resolve_import_map(specifier, ${JSON.stringify(importer)}))`;
  return { start: imp.ss, end, text };
}

function collectImportMetaRewrites(
  expression: string,
  importer: string,
  syntheticImportMeta: string | undefined,
  imports: ReturnType<typeof lexerParse>[0],
): SourceRewrite[] {
  const rewrites: SourceRewrite[] = [];
  for (const imp of imports) {
    const rewrite = importMetaRewrite(expression, importer, syntheticImportMeta, imp);
    if (rewrite !== null) rewrites.push(rewrite);
  }
  return rewrites;
}

function applyRewritesReverse(source: string, rewrites: SourceRewrite[]): string {
  let rewritten = source;
  for (const rewrite of rewrites.reverse()) {
    rewritten = rewritten.slice(0, rewrite.start) + rewrite.text + rewritten.slice(rewrite.end);
  }
  return rewritten;
}

function registryIdentity(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.search = "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

function addRegistryUrl(groups: Map<string, string[]>, url: string): void {
  const identity = registryIdentity(url);
  if (identity === null) return;
  const group = groups.get(identity) ?? [];
  group.push(url);
  groups.set(identity, group);
}

function registryUrlGroups(urls: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const url of urls) addRegistryUrl(groups, url);
  return groups;
}

function registryNameParts(identity: string): {
  base: URL;
  stem: string;
  extension: string;
} {
  const base = new URL(identity);
  const match = /^(.*?)(\.[^./]+)$/.exec(base.pathname);
  return {
    base,
    stem: match?.[1] ?? base.pathname,
    extension: match?.[2] ?? ".js",
  };
}

function availableRegistryName(
  base: URL,
  stem: string,
  extension: string,
  index: number,
  occupied: Set<string>,
): string {
  let candidate: string;
  let suffix = index;
  do {
    base.pathname = `${stem}.__ks_query_${suffix}${extension}`;
    candidate = base.href;
    suffix++;
  } while (occupied.has(candidate));
  return candidate;
}

export function assignModuleRegistryNames(urls: Iterable<string>): Map<string, string> {
  const allUrls = [...urls];
  const groups = registryUrlGroups(allUrls);
  const names = new Map<string, string>();
  const occupied = new Set(allUrls);
  for (const [identity, group] of groups) {
    if (group.length < 2) continue;
    const { base, stem, extension } = registryNameParts(identity);
    for (const [index, url] of group.entries()) {
      const candidate = availableRegistryName(base, stem, extension, index, occupied);
      occupied.add(candidate);
      names.set(url, candidate);
    }
  }
  return names;
}

function addAstroIslandModuleUrl(
  urls: Set<string>,
  raw: string | undefined,
  baseUrl: string,
): void {
  if (!raw) return;
  const url = resolveAgainstImporter(raw.replace(/&amp;/g, "&"), baseUrl);
  if (url && /^https?:\/\//.test(url)) urls.add(url);
}

export function astroIslandModuleUrls(html: string, baseUrl: string): string[] {
  const urls = new Set<string>();
  for (const [tag] of html.matchAll(/<astro-island\b[^>]*>/gi)) {
    for (const [, raw] of tag.matchAll(/\s(?:component|renderer)-url="([^"]+)"/gi)) {
      addAstroIslandModuleUrl(urls, raw, baseUrl);
    }
  }
  return [...urls];
}

export interface ModulePreloadSeed {
  url: string;
  nonce: string | null;
}

function tagAttribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "").replace(/&amp;/g, "&") : null;
}

function hasModulePreloadRel(tag: string): boolean {
  const rel = tagAttribute(tag, "rel")?.toLowerCase().split(/\s+/) ?? [];
  if (!rel.includes("modulepreload")) return false;
  return tagAttribute(tag, "integrity") === null;
}

function supportsModulePreloadDestination(tag: string): boolean {
  const destination = tagAttribute(tag, "as")?.toLowerCase();
  return !destination || destination === "script";
}

function resolveModulePreloadUrl(tag: string, baseUrl: string): string | null {
  const href = tagAttribute(tag, "href");
  if (href === null) return null;
  return resolveAgainstImporter(href, baseUrl);
}

function modulePreloadSeed(tag: string, baseUrl: string): ModulePreloadSeed | null {
  if (!hasModulePreloadRel(tag)) return null;
  if (!supportsModulePreloadDestination(tag)) return null;
  const url = resolveModulePreloadUrl(tag, baseUrl);
  if (url === null || !/^https?:\/\//.test(url)) return null;
  return { url, nonce: tagAttribute(tag, "nonce") };
}

export function modulePreloadSeeds(html: string, baseUrl: string): ModulePreloadSeed[] {
  const seeds = new Map<string, string | null>();
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const seed = modulePreloadSeed(tag, baseUrl);
    if (seed && !seeds.has(seed.url)) seeds.set(seed.url, seed.nonce);
  }
  return [...seeds].map(([url, nonce]) => ({ url, nonce }));
}

export function extractClassicDynamicSeeds(
  body: string,
  baseUrl: string,
  resolveSpecifier: (specifier: string, importer: string) => string | null = (
    specifier,
    importer,
  ) => (isUrlLikeSpecifier(specifier) ? resolveAgainstImporter(specifier, importer) : null),
): { rewritten: string; seeds: string[] } {
  if (!/import\s*\(/.test(body)) return { rewritten: body, seeds: [] };
  const imports = parseClassicImports(body, baseUrl);
  if (imports === null) return { rewritten: body, seeds: [] };
  const dynamics = imports.filter((imp) => imp.t === 2);
  if (dynamics.length === 0) return { rewritten: body, seeds: [] };
  return rewriteClassicDynamicImports(body, baseUrl, dynamics, resolveSpecifier);
}

interface ClassicDynamicRewrite {
  rewrite: SourceRewrite;
  seed?: string;
}

function parseClassicImports(
  body: string,
  baseUrl: string,
): ReturnType<typeof lexerParse>[0] | null {
  try {
    return lexerParse(body, baseUrl)[0];
  } catch {
    return null;
  }
}

function wrapUnresolvedDynamicImport(
  specifier: string,
  referrer: string,
  imp: LexedImport,
): ClassicDynamicRewrite {
  return {
    rewrite: {
      start: imp.ss,
      end: imp.se,
      text: `__ks_import(${JSON.stringify(specifier)}, ${referrer})`,
    },
  };
}

function wrapComputedDynamicImport(
  body: string,
  referrer: string,
  imp: LexedImport,
): ClassicDynamicRewrite | null {
  if (imp.d < 0) return null;
  const expression = dynamicImportExpression(body, imp);
  return {
    rewrite: {
      start: imp.ss,
      end: imp.se,
      text: `__ks_import(${expression}, ${referrer})`,
    },
  };
}

function isSupportedDynamicImportUrl(url: string): boolean {
  return /^https?:\/\//.test(url) || url.startsWith("data:");
}

function resolvedClassicDynamicRewrite(
  specifier: string,
  resolved: string | null,
  referrer: string,
  imp: LexedImport,
): ClassicDynamicRewrite | null {
  if (!resolved) return wrapUnresolvedDynamicImport(specifier, referrer, imp);
  if (!isSupportedDynamicImportUrl(resolved)) return null;
  return {
    rewrite: { start: imp.s, end: imp.e, text: JSON.stringify(resolved) },
    ...(/^https?:\/\//.test(resolved) ? { seed: resolved } : {}),
  };
}

function classicDynamicRewrite(
  body: string,
  baseUrl: string,
  referrer: string,
  imp: LexedImport,
  resolveSpecifier: (specifier: string, importer: string) => string | null,
): ClassicDynamicRewrite | null {
  const specifier = imp.n ?? constSpecifier(body.slice(imp.s, imp.e));
  if (!specifier) return wrapComputedDynamicImport(body, referrer, imp);
  const resolved = resolveSpecifier(specifier, baseUrl);
  return resolvedClassicDynamicRewrite(specifier, resolved, referrer, imp);
}

function rewriteClassicDynamicImports(
  body: string,
  baseUrl: string,
  dynamics: LexedImport[],
  resolveSpecifier: (specifier: string, importer: string) => string | null,
): { rewritten: string; seeds: string[] } {
  const seeds: string[] = [];
  let rewritten = body;
  const referrer = JSON.stringify(baseUrl);
  for (const imp of dynamics.sort((left, right) => right.ss - left.ss)) {
    const result = classicDynamicRewrite(body, baseUrl, referrer, imp, resolveSpecifier);
    if (result === null) continue;
    if (result.seed !== undefined) seeds.push(result.seed);
    const { start, end, text } = result.rewrite;
    rewritten = rewritten.slice(0, start) + text + rewritten.slice(end);
  }
  return { rewritten, seeds };
}

function parseModuleSource(body: string, url: string): ReturnType<typeof lexerParse> | null {
  try {
    return lexerParse(body, url);
  } catch {
    return null;
  }
}

function wrapInlineModuleBody(body: string): string {
  return ";(async () => {\n" + body + "\n})();\n";
}

function wrapInlineModuleWithImports(
  body: string,
  imports: ReturnType<typeof lexerParse>[0],
): string {
  const importStmts: string[] = [];
  let remainder = "";
  let cursor = 0;
  for (const imp of imports) {
    if (imp.t !== 1) continue;
    remainder += body.slice(cursor, imp.ss);
    importStmts.push(body.slice(imp.ss, imp.se));
    cursor = imp.se;
    if (body[cursor] === ";") cursor++;
  }
  remainder += body.slice(cursor);

  return importStmts.join(";\n") + ";\n;(async () => {\n" + remainder + "\n})();\n";
}

function maybeWrapInlineModule(body: string, url: string): string {
  if (!/\bawait\b/.test(body)) return body;
  const parsed = parseModuleSource(body, url);
  if (parsed === null) return body;
  const [imports, exports] = parsed;
  if (exports.length > 0) return body;
  if (imports.length === 0) return wrapInlineModuleBody(body);
  return wrapInlineModuleWithImports(body, imports);
}

function isAssetExtension(url: string): boolean {
  let path = url;
  const q = path.indexOf("?");
  if (q >= 0) path = path.slice(0, q);
  const h = path.indexOf("#");
  if (h >= 0) path = path.slice(0, h);
  return /\.(css|svg|png|jpe?g|gif|webp|woff2?|ttf|eot|ico|avif)$/i.test(path);
}

export type BakedModule = string | { json: unknown };

const MAX_MODULES = 1000;

const BAKE_BUDGET_BYTES = 40 * 1024 * 1024;

const MAX_DYNAMIC_MODULE_BYTES = 4 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 10_000;
const MODULE_FETCH_RETRY_BASE_DELAY_MS = 150;
const MODULE_FETCH_RETRY_JITTER_RATIO = 0.5;
const BYTES_PER_MIB = 1_048_576;

const WALK_CONCURRENCY = 8;

const WALK_DEADLINE_MS = 1_000;

const FANOUT_REGISTRY_THRESHOLD = 8;

const MODULE_FETCH_ATTEMPTS = 3;

const MAX_WEBPACK_CHUNKS = 300;

const MAX_WEBPACK_COMPOSER_SCAN_CHARS = 120_000;

function urlPathname(url: string): string | null {
  try {
    return new URL(url).pathname.split("/").pop() ?? "";
  } catch {
    return null;
  }
}

function isGeneratedChunkHash(hash: string): boolean {
  return /\d/.test(hash) || (/[a-z]/.test(hash) && /[A-Z]/.test(hash.slice(1)));
}

function withoutGeneratedChunkHash(stem: string): string {
  const match = /^(.+)[-.]([A-Za-z0-9_-]{8}|[a-f0-9]{9,32})$/.exec(stem);
  if (!match) return stem;
  const [name, hash] = [match[1], match[2] ?? ""];
  return isGeneratedChunkHash(hash) && name ? name : stem;
}

function validChunkBaseName(name: string): boolean {
  return name.length >= 4 && /[A-Za-z]/.test(name);
}

export function chunkBaseName(url: string): string | null {
  const file = urlPathname(url);
  if (file === null) return null;
  const stem = file.replace(/(?:\.chunk)?\.m?js$/i, "");
  const name = withoutGeneratedChunkHash(stem);
  return validChunkBaseName(name) ? name : null;
}

const MAX_TOKENIZED_HTML = 4 * 1024 * 1024;

export function documentTokens(html: string): Set<string> {
  const tokens = new Set<string>();
  if (html.length > MAX_TOKENIZED_HTML) return tokens;
  for (const m of html.matchAll(/[A-Za-z_$][\w$-]{3,}/g)) tokens.add(m[0]);
  return tokens;
}

export interface WalkResult {
  descriptors: ParentScriptDescriptor[];
  additionalModules: Record<string, BakedModule>;
  importMapModuleSource: string;
}

interface WalkModuleGraphInput {
  descriptors: ParentScriptDescriptor[];
  pageUrl: string;
  connectionId: string;
  mainFrameId?: string;
  mainLoaderId?: string;
  extraHeaders?: Record<string, string>;
  cookieKey?: string;
  options?: {
    baseUrl?: string;
    gate?: ScriptGateContext;
    importMaps?: readonly { source: string; baseUrl: string; scriptDomIndex: number }[];
    moduleSeeds?: readonly string[];
    preloadSeeds?: readonly ModulePreloadSeed[];
    documentHtml?: string;
  };
  sandboxOutbound: SandboxOutboundOverride;
}

type WalkGraphOptions = NonNullable<WalkModuleGraphInput["options"]>;

interface WalkQueueItem {
  url: string;
  importer: string | null;
  isDynamic: boolean;
  depth: number;
  importerDynFanout: number;
  viaRegistry: boolean;
  preload?: true;
}

type ModuleFetchResult =
  | { ok: true; body: string; moduleType: ModuleType }
  | { ok: false; error: string };

type NextWalkQueueItem = (WalkQueueItem & { sizeCapped: boolean }) | "wait" | "done";

type DocumentItem =
  | { index: number; kind: "map"; map: ParsedImportMap }
  | { index: number; kind: "script"; script: ParentScriptDescriptor };

interface ModuleGraphState {
  input: WalkModuleGraphInput;
  options: WalkGraphOptions;
  descriptors: ParentScriptDescriptor[];
  moduleEntries: ParentScriptDescriptor[];
  pageUrl: string;
  pageOrigin: string;
  entryBaseUrl: string;
  connectionId: string;
  mainFrameId: string;
  mainLoaderId: string;
  extraHeaders: Record<string, string>;
  cookieKey: string;
  sandboxOutbound: SandboxOutboundOverride;
  gate: ScriptGateContext | null;
  importMap: ParsedImportMap;
  integrityByUrl: Map<string, string>;
  nonceByUrl: Map<string, string>;
  viaTrustedImporter: Set<string>;
  classicSeeds: Set<string>;
  resolvedModules: ResolvedModuleRecord[];
  moduleEntryIndex: Map<ParentScriptDescriptor, number>;
  outbound: Fetcher | null;
  modules: Map<string, string>;
  failed: Map<string, string>;
  queue: WalkQueueItem[];
  depthOf: Map<string, number>;
  totalFetches: number;
  bakedBytes: number;
  oversizedDynamicSkipped: number;
  sizeSkipped: Set<string>;
  viaDyn: Map<string, boolean>;
  viaReg: Map<string, boolean>;
  dynamicRoots: Set<string>;
  webpackChunkUrls: Set<string>;
  jsonModules: Map<string, unknown>;
  lexed: Set<string>;
  lexCache: Map<string, ReturnType<typeof lexerParse>[0]>;
  docTokens: Set<string> | null;
  walkStartedAt: number;
  deadlineHit: boolean;
  deadlineSkipped: number;
  inflight: number;
  inflightUrls: Set<string>;
  waiters: Array<() => void>;
  evictedCount: number;
  prunedCount: number;
  deferredCount: number;
}

function isModuleEntry(descriptor: ParentScriptDescriptor): boolean {
  return descriptor.kind === "module" && !descriptor.blocked;
}

function copyScriptDescriptors(descriptors: ParentScriptDescriptor[]): ParentScriptDescriptor[] {
  return descriptors.map((descriptor) => ({ ...descriptor }));
}

function graphEntryBaseUrl(pageUrl: string, options: WalkGraphOptions): string {
  return options.baseUrl || pageUrl;
}

function moduleEntryIndices(
  entries: ParentScriptDescriptor[],
): Map<ParentScriptDescriptor, number> {
  return new Map(entries.map((descriptor, index) => [descriptor, index] as const));
}

function graphPageDetails(input: WalkModuleGraphInput, options: WalkGraphOptions) {
  return {
    pageUrl: input.pageUrl,
    pageOrigin: pageOriginFromUrl(input.pageUrl),
    entryBaseUrl: graphEntryBaseUrl(input.pageUrl, options),
  };
}

function graphSessionDetails(input: WalkModuleGraphInput) {
  return {
    connectionId: input.connectionId,
    mainFrameId: input.mainFrameId ?? "",
    mainLoaderId: input.mainLoaderId ?? "",
    extraHeaders: input.extraHeaders ?? {},
    cookieKey: input.cookieKey ?? "",
    sandboxOutbound: input.sandboxOutbound,
  };
}

function createModuleGraphState(input: WalkModuleGraphInput): ModuleGraphState {
  const options = input.options ?? {};
  const descriptors = copyScriptDescriptors(input.descriptors);
  const moduleEntries = descriptors.filter(isModuleEntry);
  return {
    input,
    options,
    descriptors,
    moduleEntries,
    ...graphPageDetails(input, options),
    ...graphSessionDetails(input),
    gate: options.gate ?? null,
    importMap: { imports: new Map(), scopes: new Map() },
    integrityByUrl: new Map(),
    nonceByUrl: new Map(),
    viaTrustedImporter: new Set(),
    classicSeeds: new Set(options.moduleSeeds),
    resolvedModules: [],
    moduleEntryIndex: moduleEntryIndices(moduleEntries),
    outbound: null,
    modules: new Map(),
    failed: new Map(),
    queue: [],
    depthOf: new Map(),
    totalFetches: 0,
    bakedBytes: 0,
    oversizedDynamicSkipped: 0,
    sizeSkipped: new Set(),
    viaDyn: new Map(),
    viaReg: new Map(),
    dynamicRoots: new Set(),
    webpackChunkUrls: new Set(),
    jsonModules: new Map(),
    lexed: new Set(),
    lexCache: new Map(),
    docTokens: null,
    walkStartedAt: 0,
    deadlineHit: false,
    deadlineSkipped: 0,
    inflight: 0,
    inflightUrls: new Set(),
    waiters: [],
    evictedCount: 0,
    prunedCount: 0,
    deferredCount: 0,
  };
}

function resolveGraphModule(
  state: ModuleGraphState,
  specifier: string,
  importer: string,
): string | null {
  return resolveImportMapSpecifier(specifier, importer, state.importMap);
}

function resolveAndRecordModule(
  state: ModuleGraphState,
  specifier: string,
  importer: string,
): string | null {
  state.resolvedModules.push(resolvedModuleRecord(specifier, importer));
  return resolveGraphModule(state, specifier, importer);
}

function createGraphOutbound(state: ModuleGraphState): Fetcher {
  return state.sandboxOutbound.parent({
    ...localTraceParentProps(),
    pageOrigin: state.pageOrigin,
    mainFrameId: state.mainFrameId,
    mainLoaderId: state.mainLoaderId,
    extraHeaders: state.extraHeaders,
    connectionId: state.connectionId,
    cookieKey: state.cookieKey,
  });
}

function getGraphOutbound(state: ModuleGraphState): Fetcher {
  if (state.outbound === null) throw new Error("module graph outbound fetcher is not initialized");
  return state.outbound;
}

function isGraphWalkEmpty(state: ModuleGraphState): boolean {
  return state.moduleEntries.length === 0 && state.classicSeeds.size === 0;
}

function emptyGraphResult(state: ModuleGraphState): WalkResult {
  return {
    descriptors: state.descriptors,
    additionalModules: {},
    importMapModuleSource: importMapModuleSource(state.importMap),
  };
}

function isEligibleClassicSeed(descriptor: ParentScriptDescriptor): boolean {
  return descriptor.kind === "classic" && !descriptor.prefetchError && !descriptor.blocked;
}

function classicExternalBase(
  descriptor: ParentScriptDescriptor,
  entryBaseUrl: string,
  src: string,
): string | null {
  if (descriptor.resolvedSrc) return descriptor.resolvedSrc;
  return resolveAgainstImporter(src, entryBaseUrl);
}

function classicSeedSource(descriptor: ParentScriptDescriptor, external: boolean): string {
  return external ? (descriptor.prefetchedSource ?? "") : (descriptor.body ?? "");
}

function classicSeedBase(
  descriptor: ParentScriptDescriptor,
  entryBaseUrl: string,
  external: boolean,
): string | null {
  if (!external) return entryBaseUrl;
  return classicExternalBase(descriptor, entryBaseUrl, descriptor.src ?? "");
}

function classicSeedInput(
  descriptor: ParentScriptDescriptor,
  entryBaseUrl: string,
): { source: string; baseUrl: string; external: boolean } | null {
  if (!isEligibleClassicSeed(descriptor)) return null;
  const external = Boolean(descriptor.src);
  const source = classicSeedSource(descriptor, external);
  if (!source) return null;
  const baseUrl = classicSeedBase(descriptor, entryBaseUrl, external);
  if (!baseUrl) return null;
  return { source, baseUrl, external };
}

function classicSeedResolver(
  state: ModuleGraphState,
  recordResolved: boolean,
  specifier: string,
  importer: string,
): string | null {
  return recordResolved
    ? resolveAndRecordModule(state, specifier, importer)
    : resolveGraphModule(state, specifier, importer);
}

function addClassicSeedUrls(
  state: ModuleGraphState,
  descriptor: ParentScriptDescriptor,
  seeds: string[],
): void {
  for (const url of seeds) {
    state.classicSeeds.add(url);
    if (descriptor.nonce && !state.nonceByUrl.has(url)) {
      state.nonceByUrl.set(url, descriptor.nonce);
    }
  }
}

function seedClassicDescriptor(
  state: ModuleGraphState,
  descriptor: ParentScriptDescriptor,
  recordResolved: boolean,
): void {
  const input = classicSeedInput(descriptor, state.entryBaseUrl);
  if (input === null) return;
  const resolver = (specifier: string, importer: string) =>
    classicSeedResolver(state, recordResolved, specifier, importer);
  const result = extractClassicDynamicSeeds(input.source, input.baseUrl, resolver);
  if (result.rewritten === input.source) return;
  if (input.external) descriptor.prefetchedSource = result.rewritten;
  else descriptor.body = result.rewritten;
  addClassicSeedUrls(state, descriptor, result.seeds);
}

function inlineModuleEntryUrl(state: ModuleGraphState, descriptor: ParentScriptDescriptor): string {
  return inlineModuleUrl(state.entryBaseUrl, state.moduleEntryIndex.get(descriptor) ?? 0);
}

function recordInlineModuleStatics(
  state: ModuleGraphState,
  descriptor: ParentScriptDescriptor,
): void {
  const body = descriptor.body ?? "";
  const entryUrl = inlineModuleEntryUrl(state, descriptor);
  const imports = parseClassicImports(body, entryUrl);
  if (imports === null) return;
  for (const imp of imports) recordInlineModuleStatic(state, entryUrl, imp);
}

function recordInlineModuleStatic(
  state: ModuleGraphState,
  entryUrl: string,
  imp: LexedImport,
): void {
  if (imp.t === 1 && imp.n) resolveAndRecordModule(state, imp.n, entryUrl);
}

function importMapDocumentItems(state: ModuleGraphState): DocumentItem[] {
  const items: DocumentItem[] = [];
  for (const mapInput of state.options.importMaps ?? []) {
    const map = parseImportMap(mapInput.source, mapInput.baseUrl);
    if (map) items.push({ index: mapInput.scriptDomIndex, kind: "map", map });
  }
  return items;
}

function scriptDocumentItems(state: ModuleGraphState): DocumentItem[] {
  const items: DocumentItem[] = [];
  for (const descriptor of state.descriptors) {
    items.push({
      index: descriptor.scriptDomIndex ?? -1,
      kind: "script",
      script: descriptor,
    });
  }
  return items;
}

function moduleDocumentItems(state: ModuleGraphState): DocumentItem[] {
  return [...importMapDocumentItems(state), ...scriptDocumentItems(state)].sort(
    (left, right) => left.index - right.index,
  );
}

function isLateClassicScript(descriptor: ParentScriptDescriptor): boolean {
  return Boolean(descriptor.src) && (descriptor.async || descriptor.defer);
}

function applyClassicDocumentItem(
  state: ModuleGraphState,
  descriptor: ParentScriptDescriptor,
  lateClassics: ParentScriptDescriptor[],
): void {
  if (isLateClassicScript(descriptor)) lateClassics.push(descriptor);
  else seedClassicDescriptor(state, descriptor, true);
}

function applyDocumentItem(
  state: ModuleGraphState,
  item: DocumentItem,
  lateClassics: ParentScriptDescriptor[],
): void {
  if (item.kind === "map") {
    mergeImportMap(state.importMap, item.map, state.resolvedModules);
    return;
  }
  const descriptor = item.script;
  if (descriptor.blocked) return;
  if (descriptor.kind === "classic") {
    applyClassicDocumentItem(state, descriptor, lateClassics);
    return;
  }
  if (!descriptor.src) recordInlineModuleStatics(state, descriptor);
}

function prepareModuleDocument(state: ModuleGraphState): void {
  const lateClassics: ParentScriptDescriptor[] = [];
  for (const item of moduleDocumentItems(state)) {
    applyDocumentItem(state, item, lateClassics);
  }
  for (const descriptor of lateClassics) seedClassicDescriptor(state, descriptor, false);
}

function namedByDocument(state: ModuleGraphState, url: string): boolean {
  const name = chunkBaseName(url);
  return name !== null && state.docTokens?.has(name) === true;
}

function isDocumentNamedDynamicImport(
  state: ModuleGraphState,
  isDynamic: boolean,
  url: string,
): boolean {
  if (!isDynamic || state.docTokens === null) return false;
  return namedByDocument(state, url);
}

function dynamicImportFanout(imports: ReturnType<typeof lexerParse>[0]): number {
  let fanout = 0;
  for (const imp of imports) {
    if (imp.t === 2) fanout++;
  }
  return fanout;
}

function prepareDocumentTokens(state: ModuleGraphState, fanout: number): void {
  if (
    fanout > FANOUT_REGISTRY_THRESHOLD &&
    state.options.documentHtml &&
    state.docTokens === null
  ) {
    state.docTokens = documentTokens(state.options.documentHtml);
  }
}

function lexGraphModule(
  state: ModuleGraphState,
  fromUrl: string,
  body: string,
): ReturnType<typeof lexerParse>[0] | null {
  try {
    return lexerParse(body, fromUrl)[0];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.failed.set(fromUrl, `lex failed for ${fromUrl}: ${message}`);
    state.modules.delete(fromUrl);
    return null;
  }
}

function isGraphImport(imp: LexedImport): boolean {
  return imp.t === 1 || imp.t === 2;
}

function importSpecifierForGraph(
  body: string,
  imp: LexedImport,
): { isDynamic: boolean; specifier: string } | null {
  if (!isGraphImport(imp)) return null;
  const isDynamic = imp.t === 2;
  const specifier = imp.n ?? (isDynamic ? constSpecifier(body.slice(imp.s, imp.e)) : undefined);
  if (!specifier) return null;
  return { isDynamic, specifier };
}

function recordUnresolvedGraphImport(
  state: ModuleGraphState,
  fromUrl: string,
  specifier: string,
  isDynamic: boolean,
): boolean {
  if (isDynamic) return true;
  state.failed.set(
    fromUrl,
    `Failed to resolve module specifier "${specifier}" ` +
      `(imported from ${fromUrl}): the document's import map ` +
      `does not remap it to a URL, or blocks it.`,
  );
  state.modules.delete(fromUrl);
  return false;
}

function isUnsupportedWasmModule(url: string): boolean {
  return /\.wasm$/i.test(new URL(url).pathname);
}

function recordUnsupportedWasmModule(state: ModuleGraphState, url: string): void {
  state.failed.set(
    url,
    "wasm modules in the ES-module graph are not supported " +
      "(kitesurf bakes page wasm for the WebAssembly.* APIs, " +
      "not ESM-integration)",
  );
}

function shouldIgnoreResolvedModule(state: ModuleGraphState, url: string): boolean {
  return url.startsWith("data:") || state.modules.has(url) || state.failed.has(url);
}

function updateDynamicPath(state: ModuleGraphState, url: string, isDynamic: boolean): void {
  const previous = state.viaDyn.get(url);
  state.viaDyn.set(url, previous === undefined ? isDynamic : previous && isDynamic);
}

function updateRegistryPath(state: ModuleGraphState, url: string, viaRegistry: boolean): void {
  const previous = state.viaReg.get(url);
  state.viaReg.set(url, previous === undefined ? viaRegistry : previous && viaRegistry);
}

function inheritImporterNonce(state: ModuleGraphState, fromUrl: string, url: string): void {
  const nonce = state.nonceByUrl.get(fromUrl);
  if (nonce && !state.nonceByUrl.has(url)) state.nonceByUrl.set(url, nonce);
}

function graphImportContext(state: ModuleGraphState, fromUrl: string): GraphImportContext {
  return {
    fromUrl,
    viaDynamic: state.viaDyn.get(fromUrl) ?? false,
    viaRegistry: state.viaReg.get(fromUrl) ?? false,
    depth: state.depthOf.get(fromUrl) ?? 0,
  };
}

interface GraphImportContext {
  fromUrl: string;
  viaDynamic: boolean;
  viaRegistry: boolean;
  depth: number;
}

function graphImportViaRegistry(
  state: ModuleGraphState,
  context: GraphImportContext,
  url: string,
  isDynamic: boolean,
  fanout: number,
): boolean {
  if (context.viaRegistry) return true;
  if (!isDynamic || fanout <= FANOUT_REGISTRY_THRESHOLD) return false;
  return !isDocumentNamedDynamicImport(state, isDynamic, url);
}

function graphImporterFanout(isDynamic: boolean, named: boolean, fanout: number): number {
  return isDynamic && !named ? fanout : 0;
}

function recordDynamicGraphRoot(state: ModuleGraphState, url: string, isDynamic: boolean): void {
  if (isDynamic) state.dynamicRoots.add(url);
}

function recordGraphDepth(state: ModuleGraphState, url: string, depth: number): void {
  if (!state.depthOf.has(url)) state.depthOf.set(url, depth);
}

function enqueueResolvedGraphImport(
  state: ModuleGraphState,
  context: GraphImportContext,
  url: string,
  isDynamic: boolean,
  fanout: number,
): void {
  const viaDynamic = context.viaDynamic || isDynamic;
  updateDynamicPath(state, url, viaDynamic);
  const named = isDocumentNamedDynamicImport(state, isDynamic, url);
  const viaRegistry = graphImportViaRegistry(state, context, url, isDynamic, fanout);
  updateRegistryPath(state, url, viaRegistry);
  state.viaTrustedImporter.add(url);
  inheritImporterNonce(state, context.fromUrl, url);
  recordDynamicGraphRoot(state, url, isDynamic);
  recordGraphDepth(state, url, context.depth + 1);
  state.queue.push({
    url,
    importer: context.fromUrl,
    isDynamic,
    depth: context.depth + 1,
    importerDynFanout: graphImporterFanout(isDynamic, named, fanout),
    viaRegistry,
  });
}

function queueGraphImport(
  state: ModuleGraphState,
  context: GraphImportContext,
  body: string,
  imp: LexedImport,
  fanout: number,
): boolean {
  const target = importSpecifierForGraph(body, imp);
  if (target === null) return true;
  const url = resolveGraphModule(state, target.specifier, context.fromUrl);
  if (!url) {
    return recordUnresolvedGraphImport(state, context.fromUrl, target.specifier, target.isDynamic);
  }
  if (shouldIgnoreResolvedModule(state, url)) return true;
  if (isUnsupportedWasmModule(url)) {
    recordUnsupportedWasmModule(state, url);
    return true;
  }
  enqueueResolvedGraphImport(state, context, url, target.isDynamic, fanout);
  return true;
}

function crawlModuleImports(state: ModuleGraphState, fromUrl: string, body: string): void {
  const imports = lexGraphModule(state, fromUrl, body);
  if (imports === null) return;
  state.lexCache.set(fromUrl, imports);
  const fanout = dynamicImportFanout(imports);
  prepareDocumentTokens(state, fanout);
  const context = graphImportContext(state, fromUrl);
  for (const imp of imports) {
    if (!queueGraphImport(state, context, body, imp, fanout)) return;
  }
}

function queueGraphRoot(state: ModuleGraphState, url: string, preload = false): void {
  if (state.modules.has(url) || state.failed.has(url)) return;
  state.viaDyn.set(url, false);
  state.depthOf.set(url, 0);
  state.queue.push({
    url,
    importer: null,
    isDynamic: false,
    depth: 0,
    importerDynFanout: 0,
    viaRegistry: false,
    ...(preload ? { preload: true as const } : {}),
  });
}

function queueClassicModuleSeeds(state: ModuleGraphState): void {
  for (const url of state.classicSeeds) queueGraphRoot(state, url);
}

function resolvedExternalModuleEntryUrl(
  state: ModuleGraphState,
  descriptor: ParentScriptDescriptor,
): string | null {
  return descriptor.resolvedSrc ?? resolveAgainstImporter(descriptor.src ?? "", state.entryBaseUrl);
}

function queueExternalModuleEntry(
  state: ModuleGraphState,
  descriptor: ParentScriptDescriptor,
): void {
  const resolved = resolvedExternalModuleEntryUrl(state, descriptor);
  if (!resolved) {
    descriptor.prefetchError = "could not resolve module src against page URL: " + descriptor.src;
    return;
  }
  descriptor.resolvedSrc = resolved;
  if (descriptor.integrity) state.integrityByUrl.set(resolved, descriptor.integrity);
  if (descriptor.nonce) state.nonceByUrl.set(resolved, descriptor.nonce);
  queueGraphRoot(state, resolved);
}

function queueInlineModuleEntry(
  state: ModuleGraphState,
  descriptor: ParentScriptDescriptor,
  index: number,
): void {
  const url = inlineModuleUrl(state.entryBaseUrl, index);
  descriptor.resolvedSrc = url;
  if (descriptor.nonce) state.nonceByUrl.set(url, descriptor.nonce);
  state.viaDyn.set(url, false);
  state.depthOf.set(url, 0);
  const source = descriptor.body ?? "";
  const body = maybeWrapInlineModule(source, url);
  state.modules.set(url, body);
  state.bakedBytes += body.length;
  descriptor.prefetchedSource = body;
  state.lexed.add(url);
  crawlModuleImports(state, url, body);
}

function queueModuleEntry(
  state: ModuleGraphState,
  descriptor: ParentScriptDescriptor,
  index: number,
): void {
  if (descriptor.src) queueExternalModuleEntry(state, descriptor);
  else queueInlineModuleEntry(state, descriptor, index);
}

function shouldSkipPreloadSeed(state: ModuleGraphState, url: string): boolean {
  return state.modules.has(url) || state.failed.has(url) || state.depthOf.has(url);
}

function queuePreloadSeed(state: ModuleGraphState, url: string, nonce: string | null): void {
  if (shouldSkipPreloadSeed(state, url)) return;
  if (nonce && !state.nonceByUrl.has(url)) state.nonceByUrl.set(url, nonce);
  queueGraphRoot(state, url, true);
}

function queuePreloadSeeds(state: ModuleGraphState): void {
  for (const seed of state.options.preloadSeeds ?? []) {
    queuePreloadSeed(state, seed.url, seed.nonce);
  }
}

function initializeGraphQueue(state: ModuleGraphState): void {
  queueClassicModuleSeeds(state);
  for (const [index, descriptor] of state.moduleEntries.entries()) {
    queueModuleEntry(state, descriptor, index);
  }
  queuePreloadSeeds(state);
}

function moduleFetchGateFailure(
  state: ModuleGraphState,
  url: string,
): Promise<ModuleFetchResult | null> {
  if (state.gate === null) return Promise.resolve(null);
  return checkScriptBeforeFetch(state.gate, {
    url,
    integrity: state.integrityByUrl.get(url) ?? null,
    nonce: state.nonceByUrl.get(url) ?? null,
    runtimeInserted: state.viaTrustedImporter.has(url),
    module: true,
  }).then((pre) => {
    if (pre.reportOnly) console.warn(`[kitesurf-csp] ${pre.reportOnly}`);
    if (pre.allowed) return null;
    return { ok: false, error: pre.message ?? `module blocked: ${url}` };
  });
}

function moduleFetchHeaders(state: ModuleGraphState): Record<string, string> {
  const headers: Record<string, string> = {
    "x-kitesurf-resource-type": "Script",
    "x-kitesurf-script-cors": "cors",
    "x-kitesurf-initiator": "module-graph",
    "x-kitesurf-page-origin": state.pageOrigin,
  };
  if (state.connectionId) headers["x-kitesurf-connection-id"] = state.connectionId;
  if (state.mainFrameId) headers["x-kitesurf-frame-id"] = state.mainFrameId;
  if (state.pageOrigin) headers.origin = state.pageOrigin;
  return headers;
}

function moduleFetchError(url: string, error: unknown): ModuleFetchResult {
  return {
    ok: false,
    error:
      `module fetch threw for ${url}: ` + (error instanceof Error ? error.message : String(error)),
  };
}

function moduleResponseFailure(url: string, response: Response): ModuleFetchResult | null {
  const blocked = response.headers.get("x-kitesurf-blocked");
  if (response.status === 403 && blocked) {
    return { ok: false, error: `module fetch blocked (${blocked}) for ${url}` };
  }
  if (!response.ok) {
    return { ok: false, error: `module fetch returned HTTP ${response.status} for ${url}` };
  }
  return null;
}

async function readModuleResponseBody(
  response: Response,
  integrity: string | null,
): Promise<{ bytes: Uint8Array | null; body: string }> {
  const bytes = integrity ? new Uint8Array(await response.arrayBuffer()) : null;
  const body = bytes
    ? new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes)
    : await response.text();
  return { bytes, body };
}

async function moduleResponseBody(
  state: ModuleGraphState,
  url: string,
  response: Response,
): Promise<ModuleFetchResult> {
  const integrity = state.integrityByUrl.get(url) ?? null;
  const { bytes, body } = await readModuleResponseBody(response, integrity);
  const verdict = await checkScriptResponse(
    { url, integrity, module: true },
    {
      contentType: response.headers.get("content-type"),
      contentTypeOptions: response.headers.get(KITESURF_NOSNIFF_HEADER),
      bytes,
      opaque: false,
    },
  );
  if (!verdict.allowed) {
    return { ok: false, error: verdict.message ?? `module blocked by policy: ${url}` };
  }
  return { ok: true, body, moduleType: verdict.moduleType ?? "javascript" };
}

async function validateModuleResponse(
  state: ModuleGraphState,
  url: string,
  response: Response,
): Promise<ModuleFetchResult> {
  const failure = moduleResponseFailure(url, response);
  if (failure !== null) return failure;
  return moduleResponseBody(state, url, response);
}

async function fetchRedirectedModule(
  state: ModuleGraphState,
  url: string,
  signal: AbortSignal,
): Promise<ModuleFetchResult> {
  const walk = await walkRedirects({
    url,
    signal,
    headers: moduleFetchHeaders(state),
    taintOriginFrom: state.pageOrigin || undefined,
    fetchHop: (request) => getGraphOutbound(state).fetch(request),
  });
  if (!walk.ok) return { ok: false, error: `module fetch too many redirects for ${url}` };
  return validateModuleResponse(state, url, walk.response);
}

async function attemptFetchModuleBody(
  state: ModuleGraphState,
  url: string,
): Promise<ModuleFetchResult> {
  const gateFailure = await moduleFetchGateFailure(state, url);
  if (gateFailure !== null) return gateFailure;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchRedirectedModule(state, url, controller.signal);
  } catch (error) {
    return moduleFetchError(url, error);
  } finally {
    clearTimeout(timer);
  }
}

function isTransientFetchError(error: string): boolean {
  return /aborted|abort|connection|network connection lost|reset|HTTP 5\d\d|timed out|timeout/i.test(
    error,
  );
}

async function waitBeforeModuleRetry(attempt: number): Promise<void> {
  const base = MODULE_FETCH_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  const delay = base + Math.random() * base * MODULE_FETCH_RETRY_JITTER_RATIO;
  await new Promise((resolve) => setTimeout(resolve, delay));
}

async function fetchModuleBody(state: ModuleGraphState, url: string): Promise<ModuleFetchResult> {
  let last: ModuleFetchResult = {
    ok: false,
    error: `module fetch not attempted for ${url}`,
  };
  for (let attempt = 1; attempt <= MODULE_FETCH_ATTEMPTS; attempt++) {
    last = await attemptFetchModuleBody(state, url);
    if (last.ok || !isTransientFetchError(last.error)) return last;
    if (attempt < MODULE_FETCH_ATTEMPTS) await waitBeforeModuleRetry(attempt);
  }
  return last;
}

function storeJsonModule(state: ModuleGraphState, url: string, body: string): boolean {
  try {
    state.jsonModules.set(url, JSON.parse(body));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.failed.set(url, `JSON module ${url} did not parse: ${message}`);
    return false;
  }
  state.modules.set(url, body);
  state.bakedBytes += body.length;
  state.lexed.add(url);
  return true;
}

function storeJavaScriptModule(state: ModuleGraphState, url: string, body: string): boolean {
  state.modules.set(url, body);
  state.bakedBytes += body.length;
  if (!state.lexed.has(url)) {
    state.lexed.add(url);
    crawlModuleImports(state, url, body);
  }
  return true;
}

function storeFetchedModule(
  state: ModuleGraphState,
  url: string,
  fetched: { body: string; moduleType: ModuleType },
): boolean {
  if (fetched.moduleType === "json") return storeJsonModule(state, url, fetched.body);
  return storeJavaScriptModule(state, url, fetched.body);
}

function pastGraphDeadline(state: ModuleGraphState): boolean {
  if (!state.deadlineHit && Date.now() - state.walkStartedAt >= WALK_DEADLINE_MS) {
    state.deadlineHit = true;
  }
  return state.deadlineHit;
}

function notifyGraphWaiters(state: ModuleGraphState): void {
  const waiters = state.waiters;
  state.waiters = [];
  for (const wake of waiters) wake();
}

function waitForGraphWork(state: ModuleGraphState): Promise<void> {
  return new Promise((resolve) => state.waiters.push(resolve));
}

type QueueItemDisposition = "skip" | "inflight" | "candidate";

function lexAlreadyFetchedModule(state: ModuleGraphState, url: string): void {
  if (state.lexed.has(url)) return;
  const body = state.modules.get(url);
  if (body === undefined) return;
  state.lexed.add(url);
  crawlModuleImports(state, url, body);
}

function isDynamicGraphItemOverBudget(state: ModuleGraphState, item: WalkQueueItem): boolean {
  return item.isDynamic && state.bakedBytes >= BAKE_BUDGET_BYTES;
}

function isRegistryGraphItemPastDeadline(state: ModuleGraphState, item: WalkQueueItem): boolean {
  if (!item.viaRegistry) return false;
  if (!pastGraphDeadline(state)) return false;
  state.deadlineSkipped++;
  return true;
}

function classifyMissingQueueItem(
  state: ModuleGraphState,
  item: WalkQueueItem,
): QueueItemDisposition {
  if (isDynamicGraphItemOverBudget(state, item)) return "skip";
  if (isRegistryGraphItemPastDeadline(state, item)) {
    return "skip";
  }
  if (isAssetExtension(item.url)) {
    state.modules.set(
      item.url,
      `/* kitesurf: asset-import side-effect stub for ${item.url} */\nexport {};\n`,
    );
    return "skip";
  }
  return "candidate";
}

function classifyQueueItem(state: ModuleGraphState, item: WalkQueueItem): QueueItemDisposition {
  if (state.failed.has(item.url)) return "skip";
  if (state.inflightUrls.has(item.url)) return "inflight";
  if (state.modules.has(item.url)) {
    lexAlreadyFetchedModule(state, item.url);
    return "skip";
  }
  return classifyMissingQueueItem(state, item);
}

function queueItemClass(item: WalkQueueItem): number {
  if (!item.isDynamic) return 0;
  return item.importerDynFanout > FANOUT_REGISTRY_THRESHOLD ? 2 : 1;
}

interface QueueSelection {
  keep: WalkQueueItem[];
  best: WalkQueueItem | null;
  bestClass: number;
}

function isBetterQueueCandidate(item: WalkQueueItem, selection: QueueSelection): boolean {
  const itemClass = queueItemClass(item);
  return (
    selection.best === null ||
    itemClass < selection.bestClass ||
    (itemClass === selection.bestClass && item.depth < selection.best.depth)
  );
}

function considerQueueItem(
  selection: QueueSelection,
  item: WalkQueueItem,
  disposition: QueueItemDisposition,
): void {
  if (disposition === "skip") return;
  selection.keep.push(item);
  if (disposition === "inflight") return;
  if (isBetterQueueCandidate(item, selection)) {
    selection.best = item;
    selection.bestClass = queueItemClass(item);
  }
}

function moduleLimitQueueResult(state: ModuleGraphState): NextWalkQueueItem | null {
  if (state.modules.size < MAX_MODULES) return null;
  state.queue.length = 0;
  return state.inflight > 0 ? "wait" : "done";
}

function selectedQueueItemOrStatus(
  state: ModuleGraphState,
  best: WalkQueueItem | null,
): NextWalkQueueItem {
  if (best === null) return state.inflight > 0 ? "wait" : "done";
  return {
    ...best,
    sizeCapped: best.isDynamic || (best.importer === null && state.classicSeeds.has(best.url)),
  };
}

function nextGraphQueueItem(state: ModuleGraphState): NextWalkQueueItem {
  const selection: QueueSelection = { keep: [], best: null, bestClass: 3 };
  for (const item of state.queue) {
    const limitResult = moduleLimitQueueResult(state);
    if (limitResult !== null) return limitResult;
    considerQueueItem(selection, item, classifyQueueItem(state, item));
  }
  state.queue.length = 0;
  for (const item of selection.keep) {
    if (item !== selection.best) state.queue.push(item);
  }
  return selectedQueueItemOrStatus(state, selection.best);
}

function clearInflightGraphItem(state: ModuleGraphState, url: string): void {
  state.inflightUrls.delete(url);
  state.inflight--;
  notifyGraphWaiters(state);
}

function recordFailedGraphFetch(state: ModuleGraphState, item: WalkQueueItem, error: string): void {
  if (!item.preload) state.failed.set(item.url, error);
}

function isOversizedCappedModule(
  item: WalkQueueItem & { sizeCapped: boolean },
  result: ModuleFetchResult,
): boolean {
  return result.ok && item.sizeCapped === true && result.body.length > MAX_DYNAMIC_MODULE_BYTES;
}

function shouldSkipDynamicForBudget(state: ModuleGraphState, item: WalkQueueItem): boolean {
  return item.isDynamic && state.bakedBytes >= BAKE_BUDGET_BYTES;
}

function storeQueueFetchResult(
  state: ModuleGraphState,
  item: WalkQueueItem & { sizeCapped: boolean },
  result: ModuleFetchResult,
): void {
  if (!result.ok) {
    recordFailedGraphFetch(state, item, result.error);
    return;
  }
  if (isOversizedCappedModule(item, result)) {
    state.oversizedDynamicSkipped++;
    state.sizeSkipped.add(item.url);
    return;
  }
  if (shouldSkipDynamicForBudget(state, item)) return;
  storeFetchedModule(state, item.url, result);
}

async function fetchQueuedGraphModule(
  state: ModuleGraphState,
  item: WalkQueueItem & { sizeCapped: boolean },
): Promise<void> {
  state.inflight++;
  state.inflightUrls.add(item.url);
  let result: ModuleFetchResult;
  try {
    result = await fetchModuleBody(state, item.url);
  } finally {
    clearInflightGraphItem(state, item.url);
  }
  state.totalFetches++;
  storeQueueFetchResult(state, item, result);
}

async function processGraphWorkerItem(
  state: ModuleGraphState,
  item: NextWalkQueueItem,
): Promise<boolean> {
  if (item === "done") {
    notifyGraphWaiters(state);
    return false;
  }
  if (item === "wait") {
    await waitForGraphWork(state);
    return true;
  }
  await fetchQueuedGraphModule(state, item);
  return true;
}

async function runGraphWorker(state: ModuleGraphState): Promise<void> {
  for (;;) {
    const keepRunning = await processGraphWorkerItem(state, nextGraphQueueItem(state));
    if (!keepRunning) return;
  }
}

async function runGraphWorkers(state: ModuleGraphState): Promise<void> {
  const workers = Array.from({ length: WALK_CONCURRENCY }, () => runGraphWorker(state));
  await Promise.all(workers);
}

interface WebpackComposer {
  url: string;
  nameMap: Record<string, string> | null;
  hashMap: Record<string, string>;
}

interface WebpackIdQueue {
  hashMap: Record<string, string>;
  seen: Set<string>;
  pending: string[];
}

interface WebpackChunkCandidate {
  id: string;
  url: string;
}

interface WebpackChunkCrawl {
  composer: WebpackComposer;
  ids: WebpackIdQueue;
  bakedChunks: number;
}

function parseWebpackMapObject(source: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of source.slice(1, -1).split(",")) {
    const colon = entry.indexOf(':"');
    if (colon < 0) continue;
    map[entry.slice(0, colon)] = entry.slice(colon + 2, -1);
  }
  return map;
}

function parseWebpackMaps(source: string): Record<string, string>[] {
  const maps: Record<string, string>[] = [];
  for (const match of source.matchAll(/\{(?:\d+:"[^"]*",?)+\}/g)) {
    maps.push(parseWebpackMapObject(match[0]));
  }
  return maps;
}

function webpackComposerFromMaps(
  url: string,
  maps: Record<string, string>[],
): WebpackComposer | null {
  if (maps.length === 0) return null;
  return {
    url,
    nameMap: maps.length >= 2 ? (maps[0] ?? null) : null,
    hashMap: maps[maps.length - 1] ?? {},
  };
}

function webpackComposerInBody(url: string, body: string): WebpackComposer | null {
  const assignment = body.search(/\.u\s*=/);
  if (assignment < 0) return null;
  const window = body.slice(assignment, assignment + MAX_WEBPACK_COMPOSER_SCAN_CHARS);
  const end = window.indexOf('".js"');
  if (end < 0) return null;
  const maps = parseWebpackMaps(window.slice(0, end + 5));
  return webpackComposerFromMaps(url, maps);
}

function findWebpackComposer(state: ModuleGraphState): WebpackComposer | null {
  for (const [url, body] of state.modules) {
    const composer = webpackComposerInBody(url, body);
    if (composer !== null) return composer;
  }
  return null;
}

function pushWebpackId(ids: WebpackIdQueue, id: string): void {
  if (ids.seen.has(id) || ids.hashMap[id] === undefined) return;
  ids.seen.add(id);
  ids.pending.push(id);
}

function scanWebpackArrayIds(ids: WebpackIdQueue, body: string): void {
  for (const match of body.matchAll(/\[(\d{1,6}(?:,\d{1,6})+)\]/g)) {
    const group = match[1];
    if (group === undefined) continue;
    const chunkIds = group.split(",");
    if (!chunkIds.every((id) => ids.hashMap[id] !== undefined)) continue;
    for (const id of chunkIds) pushWebpackId(ids, id);
  }
}

function scanWebpackIds(ids: WebpackIdQueue, body: string): void {
  for (const match of body.matchAll(/\.e\((\d+)\)/g)) {
    const id = match[1];
    if (id !== undefined) pushWebpackId(ids, id);
  }
  scanWebpackArrayIds(ids, body);
}

function createWebpackIdQueue(composer: WebpackComposer): WebpackIdQueue {
  return { hashMap: composer.hashMap, seen: new Set(), pending: [] };
}

function shouldSkipWebpackQueueItem(state: ModuleGraphState, item: WalkQueueItem): boolean {
  if (state.modules.has(item.url) || state.failed.has(item.url)) return true;
  return item.isDynamic && (state.bakedBytes >= BAKE_BUDGET_BYTES || pastGraphDeadline(state));
}

function takeWebpackQueueWave(state: ModuleGraphState): WalkQueueItem[] {
  const wave: WalkQueueItem[] = [];
  while (state.queue.length > 0 && wave.length < WALK_CONCURRENCY) {
    const item = state.queue.shift();
    if (item === undefined || shouldSkipWebpackQueueItem(state, item)) continue;
    wave.push(item);
  }
  return wave;
}

interface FetchedWebpackQueueItem {
  item: WalkQueueItem;
  result: ModuleFetchResult;
}

async function fetchWebpackQueueWave(
  state: ModuleGraphState,
  wave: WalkQueueItem[],
): Promise<FetchedWebpackQueueItem[]> {
  return Promise.all(
    wave.map(async (item) => {
      const result = await fetchModuleBody(state, item.url);
      state.totalFetches++;
      return { item, result };
    }),
  );
}

function storeWebpackQueueWave(
  state: ModuleGraphState,
  results: FetchedWebpackQueueItem[],
  scanIds: (body: string) => void,
): void {
  for (const { item, result } of results) {
    if (!result.ok) {
      state.failed.set(item.url, result.error);
      continue;
    }
    if (!storeFetchedModule(state, item.url, result)) continue;
    if (result.moduleType === "javascript") scanIds(result.body);
  }
}

async function drainWebpackQueue(
  state: ModuleGraphState,
  scanIds: (body: string) => void,
): Promise<void> {
  while (state.queue.length > 0) {
    const wave = takeWebpackQueueWave(state);
    if (wave.length === 0) continue;
    const results = await fetchWebpackQueueWave(state, wave);
    storeWebpackQueueWave(state, results, scanIds);
  }
}

function isNewWebpackChunkUrl(state: ModuleGraphState, url: string | null): url is string {
  return url !== null && !state.modules.has(url) && !state.failed.has(url);
}

function webpackChunkCandidate(
  state: ModuleGraphState,
  composer: WebpackComposer,
  id: string,
): WebpackChunkCandidate | null {
  const hash = composer.hashMap[id];
  if (hash === undefined) return null;
  const name = composer.nameMap?.[id] ?? id;
  const url = resolveAgainstImporter(`./${name}.${hash}.js`, composer.url);
  if (!isNewWebpackChunkUrl(state, url)) return null;
  return { id, url };
}

function nextWebpackChunkWave(
  state: ModuleGraphState,
  crawl: WebpackChunkCrawl,
): WebpackChunkCandidate[] {
  const ids = crawl.ids.pending.splice(0, WALK_CONCURRENCY);
  const wave: WebpackChunkCandidate[] = [];
  for (const id of ids) {
    const candidate = webpackChunkCandidate(state, crawl.composer, id);
    if (candidate !== null) wave.push(candidate);
  }
  return wave;
}

interface FetchedWebpackChunk {
  url: string;
  result: ModuleFetchResult;
}

async function fetchWebpackChunkWave(
  state: ModuleGraphState,
  wave: WebpackChunkCandidate[],
): Promise<FetchedWebpackChunk[]> {
  return Promise.all(
    wave.map(async ({ url }) => {
      const result = await fetchModuleBody(state, url);
      state.totalFetches++;
      return { url, result };
    }),
  );
}

function storeWebpackChunk(
  state: ModuleGraphState,
  crawl: WebpackChunkCrawl,
  fetched: FetchedWebpackChunk,
  scanIds: (body: string) => void,
): boolean {
  const { url, result } = fetched;
  if (!result.ok) {
    state.failed.set(url, result.error);
    return false;
  }
  if (state.bakedBytes >= BAKE_BUDGET_BYTES || !storeFetchedModule(state, url, result))
    return false;
  state.viaDyn.set(url, true);
  state.dynamicRoots.add(url);
  state.webpackChunkUrls.add(url);
  crawl.bakedChunks++;
  if (result.moduleType === "javascript") scanIds(result.body);
  return true;
}

function storeWebpackChunkWave(
  state: ModuleGraphState,
  crawl: WebpackChunkCrawl,
  results: FetchedWebpackChunk[],
  scanIds: (body: string) => void,
): void {
  for (const result of results) storeWebpackChunk(state, crawl, result, scanIds);
}

function canContinueWebpackChunkCrawl(state: ModuleGraphState, crawl: WebpackChunkCrawl): boolean {
  return (
    crawl.ids.pending.length > 0 &&
    crawl.bakedChunks < MAX_WEBPACK_CHUNKS &&
    !pastGraphDeadline(state)
  );
}

async function crawlWebpackChunks(
  state: ModuleGraphState,
  crawl: WebpackChunkCrawl,
  scanIds: (body: string) => void,
): Promise<void> {
  while (canContinueWebpackChunkCrawl(state, crawl)) {
    if (state.bakedBytes >= BAKE_BUDGET_BYTES) break;
    const wave = nextWebpackChunkWave(state, crawl);
    if (wave.length === 0) continue;
    const results = await fetchWebpackChunkWave(state, wave);
    storeWebpackChunkWave(state, crawl, results, scanIds);
    await drainWebpackQueue(state, scanIds);
  }
}

async function discoverWebpackChunks(state: ModuleGraphState): Promise<void> {
  const composer = findWebpackComposer(state);
  if (composer === null) return;
  const ids = createWebpackIdQueue(composer);
  const scanIds = (body: string) => scanWebpackIds(ids, body);
  for (const body of state.modules.values()) scanIds(body);
  const crawl: WebpackChunkCrawl = { composer, ids, bakedChunks: 0 };
  await crawlWebpackChunks(state, crawl, scanIds);
  if (crawl.bakedChunks > 0) {
    console.log(
      `[kitesurf-walk] webpack chunk crawl: ${crawl.bakedChunks} chunk(s) baked from ${composer.url}`,
    );
  }
}

function staticDependencyIncomplete(
  state: ModuleGraphState,
  url: string,
  imp: LexedImport,
  completeness: Map<string, boolean>,
): boolean {
  if (imp.t !== 1 || !imp.n) return false;
  const resolved = resolveGraphModule(state, imp.n, url);
  if (!resolved) return false;
  return !state.modules.has(resolved) || !staticDependenciesComplete(state, resolved, completeness);
}

function staticDependenciesComplete(
  state: ModuleGraphState,
  url: string,
  completeness: Map<string, boolean>,
): boolean {
  const memo = completeness.get(url);
  if (memo !== undefined) return memo;
  completeness.set(url, true);
  for (const imp of state.lexCache.get(url) ?? []) {
    if (!staticDependencyIncomplete(state, url, imp, completeness)) continue;
    completeness.set(url, false);
    return false;
  }
  return true;
}

function shouldCheckDynamicRoot(state: ModuleGraphState, url: string): boolean {
  return state.modules.has(url) && state.viaDyn.get(url) !== false;
}

function evictIncompleteRootPass(state: ModuleGraphState): boolean {
  let changed = false;
  const completeness = new Map<string, boolean>();
  for (const root of state.dynamicRoots) {
    if (!shouldCheckDynamicRoot(state, root)) continue;
    if (staticDependenciesComplete(state, root, completeness)) continue;
    state.modules.delete(root);
    state.evictedCount++;
    changed = true;
  }
  return changed;
}

function evictIncompleteDynamicRoots(state: ModuleGraphState): void {
  while (evictIncompleteRootPass(state)) {}
}

function pushReachableRoot(
  state: ModuleGraphState,
  reachable: Set<string>,
  stack: string[],
  url: string | null | undefined,
): void {
  if (!url || !state.modules.has(url) || reachable.has(url)) return;
  reachable.add(url);
  stack.push(url);
}

function reachableImportSpecifier(body: string, imp: LexedImport): string | null | undefined {
  if (imp.t !== 1 && imp.t !== 2) return undefined;
  return imp.n ?? (imp.t === 2 ? constSpecifier(body.slice(imp.s, imp.e)) : undefined);
}

function pushReachableImport(
  state: ModuleGraphState,
  url: string,
  body: string,
  imp: LexedImport,
  reachable: Set<string>,
  stack: string[],
): void {
  const specifier = reachableImportSpecifier(body, imp);
  if (!specifier) return;
  const resolved = resolveGraphModule(state, specifier, url);
  pushReachableRoot(state, reachable, stack, resolved);
}

function visitReachableDependencies(
  state: ModuleGraphState,
  url: string,
  reachable: Set<string>,
  stack: string[],
): void {
  const body = state.modules.get(url);
  if (body === undefined) return;
  for (const imp of state.lexCache.get(url) ?? []) {
    pushReachableImport(state, url, body, imp, reachable, stack);
  }
}

function collectDeadlineReachableModules(state: ModuleGraphState): Set<string> {
  const reachable = new Set<string>();
  const stack: string[] = [];
  for (const descriptor of state.moduleEntries) {
    pushReachableRoot(state, reachable, stack, descriptor.resolvedSrc);
  }
  for (const url of state.classicSeeds) pushReachableRoot(state, reachable, stack, url);
  for (const url of state.webpackChunkUrls) pushReachableRoot(state, reachable, stack, url);
  while (stack.length > 0) visitNextReachableModule(state, stack, reachable);
  return reachable;
}

function visitNextReachableModule(
  state: ModuleGraphState,
  stack: string[],
  reachable: Set<string>,
): void {
  const url = stack.pop();
  if (url !== undefined) visitReachableDependencies(state, url, reachable, stack);
}

function pruneUnreachableDynamicModules(state: ModuleGraphState, reachable: Set<string>): void {
  for (const url of [...state.modules.keys()]) {
    if (reachable.has(url) || state.viaDyn.get(url) !== true) continue;
    state.modules.delete(url);
    state.prunedCount++;
  }
}

function pruneAfterWalkDeadline(state: ModuleGraphState): void {
  if (!state.deadlineHit) return;
  evictIncompleteDynamicRoots(state);
  const reachable = collectDeadlineReachableModules(state);
  pruneUnreachableDynamicModules(state, reachable);
}

function classicDynamicSpecifier(source: string, imp: LexedImport): string | null {
  if (imp.t !== 2) return null;
  return imp.n ?? constSpecifier(source.slice(imp.s, imp.e));
}

function sizeSkippedClassicRewrite(
  state: ModuleGraphState,
  url: string,
  baseUrl: string,
  imp: LexedImport,
): SourceRewrite | null {
  if (!state.sizeSkipped.has(url)) return null;
  return {
    start: imp.ss,
    end: imp.se,
    text: `__ks_import(${JSON.stringify(url)}, ${JSON.stringify(baseUrl)})`,
  };
}

function registeredClassicRewrite(
  url: string,
  imp: LexedImport,
  registryNames: ReadonlyMap<string, string>,
): SourceRewrite | null {
  const name = registryNames.get(url);
  if (!name) return null;
  return { start: imp.s, end: imp.e, text: JSON.stringify(name) };
}

function classicDynamicRegistryRewrite(
  state: ModuleGraphState,
  source: string,
  baseUrl: string,
  imp: LexedImport,
  registryNames: ReadonlyMap<string, string>,
): SourceRewrite | null {
  const specifier = classicDynamicSpecifier(source, imp);
  if (!specifier) return null;
  const absolute = resolveAgainstImporter(specifier, baseUrl);
  if (absolute === null) return null;
  return (
    sizeSkippedClassicRewrite(state, absolute, baseUrl, imp) ??
    registeredClassicRewrite(absolute, imp, registryNames)
  );
}

function classicDynamicRegistryRewrites(
  state: ModuleGraphState,
  source: string,
  baseUrl: string,
  registryNames: ReadonlyMap<string, string>,
): SourceRewrite[] {
  const imports = tryParseImports(source);
  if (imports === null) return [];
  const rewrites: SourceRewrite[] = [];
  for (const imp of imports) {
    const rewrite = classicDynamicRegistryRewrite(state, source, baseUrl, imp, registryNames);
    if (rewrite !== null) rewrites.push(rewrite);
  }
  return rewrites;
}

interface ClassicDescriptorSource {
  field: "prefetchedSource" | "body";
  source: string;
  baseUrl: string;
}

function classicDescriptorField(descriptor: ParentScriptDescriptor): "prefetchedSource" | "body" {
  return descriptor.src ? "prefetchedSource" : "body";
}

function hasClassicDynamicImport(source: string | undefined): source is string {
  return source !== undefined && source !== "" && /import\s*\(/.test(source);
}

function classicDescriptorBaseUrl(
  state: ModuleGraphState,
  descriptor: ParentScriptDescriptor,
): string | null {
  if (!descriptor.src) return state.entryBaseUrl;
  return descriptor.resolvedSrc || resolveAgainstImporter(descriptor.src, state.entryBaseUrl);
}

function classicDescriptorSource(
  state: ModuleGraphState,
  descriptor: ParentScriptDescriptor,
): ClassicDescriptorSource | null {
  if (descriptor.kind === "module") return null;
  const field = classicDescriptorField(descriptor);
  const source = descriptor[field];
  if (!hasClassicDynamicImport(source)) return null;
  const baseUrl = classicDescriptorBaseUrl(state, descriptor);
  if (!baseUrl) return null;
  return { field, source, baseUrl };
}

function rewriteClassicDescriptor(
  state: ModuleGraphState,
  descriptor: ParentScriptDescriptor,
  registryNames: ReadonlyMap<string, string>,
): void {
  const input = classicDescriptorSource(state, descriptor);
  if (input === null) return;
  const rewrites = classicDynamicRegistryRewrites(
    state,
    input.source,
    input.baseUrl,
    registryNames,
  );
  if (rewrites.length > 0) descriptor[input.field] = applyRewritesReverse(input.source, rewrites);
}

function rewriteClassicDescriptors(
  state: ModuleGraphState,
  registryNames: ReadonlyMap<string, string>,
): void {
  if (registryNames.size === 0 && state.sizeSkipped.size === 0) return;
  for (const descriptor of state.descriptors) {
    rewriteClassicDescriptor(state, descriptor, registryNames);
  }
}

function removeRecoveredSizeSkips(state: ModuleGraphState): void {
  for (const url of [...state.sizeSkipped]) {
    if (state.modules.has(url)) state.sizeSkipped.delete(url);
  }
}

function moduleRegistryName(url: string, registryNames: ReadonlyMap<string, string>): string {
  return registryNames.get(url) ?? url;
}

function literalImportRange(imp: LexedImport): { start: number; end: number } {
  return imp.t === 1 ? { start: imp.s - 1, end: imp.e + 1 } : { start: imp.s, end: imp.e };
}

function dynamicImportRanges(imports: ReturnType<typeof lexerParse>[0]): {
  start: number;
  end: number;
}[] {
  return imports.filter((imp) => imp.t === 2).map((imp) => ({ start: imp.ss, end: imp.se }));
}

function isInsideDynamicImport(
  imp: LexedImport,
  ranges: readonly { start: number; end: number }[],
): boolean {
  return ranges.some(({ start, end }) => imp.ss >= start && imp.se <= end);
}

function dynamicModuleSpecifier(body: string, imp: LexedImport): string | null {
  return imp.n ?? constSpecifier(body.slice(imp.s, imp.e));
}

function computedDynamicModuleRewrite(
  body: string,
  fromUrl: string,
  imp: LexedImport,
  syntheticImportMeta: string | undefined,
): SourceRewrite | null {
  if (imp.d < 0) return null;
  const expression = rewriteImportMetaResolve(
    dynamicImportExpression(body, imp),
    fromUrl,
    syntheticImportMeta,
  );
  return {
    start: imp.ss,
    end: imp.se,
    text: `__ks_import(${expression}, ${JSON.stringify(fromUrl)})`,
  };
}

function bakedDynamicRegistryName(
  state: ModuleGraphState,
  specifier: string,
  fromUrl: string,
  registryNames: ReadonlyMap<string, string>,
): string | null {
  const resolved = resolveGraphModule(state, specifier, fromUrl);
  if (!resolved || !state.modules.has(resolved)) return null;
  return moduleRegistryName(resolved, registryNames);
}

function mappedDynamicModuleRewrite(
  specifier: string,
  fromUrl: string,
  imp: LexedImport,
  mapped: string,
): SourceRewrite | null {
  if (nativelyResolvesTo(specifier, fromUrl, mapped)) return null;
  return { ...literalImportRange(imp), text: JSON.stringify(mapped) };
}

function deferredDynamicModuleRewrite(
  state: ModuleGraphState,
  specifier: string,
  fromUrl: string,
  imp: LexedImport,
): SourceRewrite {
  state.deferredCount++;
  return {
    start: imp.ss,
    end: imp.se,
    text: `__ks_import(${JSON.stringify(specifier)}, ${JSON.stringify(fromUrl)})`,
  };
}

function rewriteDynamicModuleImport(
  state: ModuleGraphState,
  body: string,
  fromUrl: string,
  imp: LexedImport,
  syntheticImportMeta: string | undefined,
  registryNames: ReadonlyMap<string, string>,
): SourceRewrite | null {
  const specifier = dynamicModuleSpecifier(body, imp);
  if (!specifier) return computedDynamicModuleRewrite(body, fromUrl, imp, syntheticImportMeta);
  const mapped = bakedDynamicRegistryName(state, specifier, fromUrl, registryNames);
  if (mapped !== null) return mappedDynamicModuleRewrite(specifier, fromUrl, imp, mapped);
  return deferredDynamicModuleRewrite(state, specifier, fromUrl, imp);
}

function rewriteImportMetaModuleReference(
  body: string,
  importer: string,
  imp: LexedImport,
  syntheticImportMeta: string | undefined,
  dynamicRanges: readonly { start: number; end: number }[],
): SourceRewrite | null {
  if (isInsideDynamicImport(imp, dynamicRanges)) return null;
  return importMetaRewrite(body, importer, syntheticImportMeta, imp);
}

function rewriteStaticModuleImport(
  state: ModuleGraphState,
  importer: string,
  imp: LexedImport,
  registryNames: ReadonlyMap<string, string>,
): SourceRewrite | null {
  if (imp.t !== 1 || !imp.n) return null;
  const resolved = resolveGraphModule(state, imp.n, importer);
  if (!resolved) return null;
  const mapped = moduleRegistryName(resolved, registryNames);
  if (nativelyResolvesTo(imp.n, importer, mapped)) return null;
  return { ...literalImportRange(imp), text: JSON.stringify(mapped) };
}

function moduleImportRewrite(
  state: ModuleGraphState,
  body: string,
  importer: string,
  imp: LexedImport,
  syntheticImportMeta: string | undefined,
  dynamicRanges: readonly { start: number; end: number }[],
  registryNames: ReadonlyMap<string, string>,
): SourceRewrite | null {
  if (imp.t === 2) {
    return rewriteDynamicModuleImport(
      state,
      body,
      importer,
      imp,
      syntheticImportMeta,
      registryNames,
    );
  }
  if (imp.t === 3) {
    return rewriteImportMetaModuleReference(
      body,
      importer,
      imp,
      syntheticImportMeta,
      dynamicRanges,
    );
  }
  return rewriteStaticModuleImport(state, importer, imp, registryNames);
}

function moduleSourceRewrites(
  state: ModuleGraphState,
  body: string,
  importer: string,
  imports: ReturnType<typeof lexerParse>[0],
  syntheticImportMeta: string | undefined,
  registryNames: ReadonlyMap<string, string>,
): SourceRewrite[] {
  const ranges = dynamicImportRanges(imports);
  const rewrites: SourceRewrite[] = [];
  for (const imp of imports) {
    const rewrite = moduleImportRewrite(
      state,
      body,
      importer,
      imp,
      syntheticImportMeta,
      ranges,
      registryNames,
    );
    if (rewrite !== null) rewrites.push(rewrite);
  }
  return rewrites;
}

function uniqueSyntheticImportMeta(
  body: string,
  importer: string,
  registryNames: ReadonlyMap<string, string>,
): string | undefined {
  if (moduleRegistryName(importer, registryNames) === importer) return undefined;
  let name = "__ks_import_meta";
  while (body.includes(name)) name += "_";
  return name;
}

function parseCachedModuleImports(
  state: ModuleGraphState,
  importer: string,
  body: string,
): ReturnType<typeof lexerParse>[0] | null {
  const cached = state.lexCache.get(importer);
  if (cached !== undefined) return cached;
  return parseModuleSource(body, importer)?.[0] ?? null;
}

function rewrittenModuleSource(
  body: string,
  rewrites: SourceRewrite[],
  importer: string,
  syntheticImportMeta: string | undefined,
): string {
  const rewritten = applyRewritesReverse(body, rewrites);
  if (syntheticImportMeta === undefined) return rewritten;
  const referrer = JSON.stringify(importer);
  return (
    `const ${syntheticImportMeta}=Object.assign(Object.create(null),` +
    `{url:${referrer},resolve:(specifier)=>globalThis.__ks_resolve_import_map(specifier,${referrer})});\n` +
    rewritten
  );
}

function hasModuleSourceRewrites(
  rewrites: SourceRewrite[],
  syntheticImportMeta: string | undefined,
): boolean {
  return rewrites.length > 0 || syntheticImportMeta !== undefined;
}

function rewriteOneModuleSource(
  state: ModuleGraphState,
  importer: string,
  body: string,
  registryNames: ReadonlyMap<string, string>,
): void {
  if (state.jsonModules.has(importer)) return;
  const imports = parseCachedModuleImports(state, importer, body);
  if (imports === null) return;
  const syntheticImportMeta = uniqueSyntheticImportMeta(body, importer, registryNames);
  const rewrites = moduleSourceRewrites(
    state,
    body,
    importer,
    imports,
    syntheticImportMeta,
    registryNames,
  );
  if (!hasModuleSourceRewrites(rewrites, syntheticImportMeta)) return;
  state.modules.set(importer, rewrittenModuleSource(body, rewrites, importer, syntheticImportMeta));
}

function rewriteModuleSources(
  state: ModuleGraphState,
  registryNames: ReadonlyMap<string, string>,
): void {
  for (const [url, body] of [...state.modules.entries()]) {
    rewriteOneModuleSource(state, url, body, registryNames);
  }
}

function applyModuleEntryResult(
  state: ModuleGraphState,
  descriptor: ParentScriptDescriptor,
  registryNames: ReadonlyMap<string, string>,
): void {
  if (descriptor.prefetchError) return;
  const url = descriptor.resolvedSrc;
  if (!url) return;
  const failure = state.failed.get(url);
  if (failure !== undefined) {
    descriptor.prefetchError = failure;
    return;
  }
  const body = state.modules.get(url);
  if (body == null) {
    descriptor.prefetchError = `module not in graph after walk: ${url}`;
    return;
  }
  descriptor.prefetchedSource = body;
  descriptor.resolvedSrc = moduleRegistryName(url, registryNames);
}

function applyModuleEntryResults(
  state: ModuleGraphState,
  registryNames: ReadonlyMap<string, string>,
): void {
  for (const descriptor of state.moduleEntries) {
    applyModuleEntryResult(state, descriptor, registryNames);
  }
}

function appendFailureStats(state: ModuleGraphState, parts: string[]): void {
  if (state.failed.size > 0) parts.push(`${state.failed.size} failed`);
  if (state.deferredCount > 0) parts.push(`${state.deferredCount} dyn deferred->boa`);
  if (state.oversizedDynamicSkipped > 0) {
    parts.push(`${state.oversizedDynamicSkipped} oversized dyn skipped`);
  }
}

function appendWalkLimitStats(state: ModuleGraphState, parts: string[]): void {
  if (state.modules.size >= MAX_MODULES) parts.push(`hit MAX_MODULES=${MAX_MODULES} cap`);
  if (state.deadlineHit) {
    parts.push(
      `hit ${WALK_DEADLINE_MS}ms deadline ` +
        `(${state.deadlineSkipped} skipped, ${state.evictedCount} evicted, ${state.prunedCount} pruned)`,
    );
  }
}

function graphWalkSummary(state: ModuleGraphState): string[] {
  const parts = [
    `${state.moduleEntries.length} module entr${state.moduleEntries.length === 1 ? "y" : "ies"}`,
    `${state.modules.size} modules baked`,
    `${state.totalFetches} fetches`,
  ];
  appendFailureStats(state, parts);
  parts.push(`${(state.bakedBytes / BYTES_PER_MIB).toFixed(1)}MiB baked`);
  appendWalkLimitStats(state, parts);
  parts.push(`${Date.now() - state.walkStartedAt}ms`);
  return parts;
}

function logGraphWalkSummary(state: ModuleGraphState): void {
  if (state.totalFetches === 0 && state.moduleEntries.length === 0) return;
  console.log(`[kitesurf-walk] ${graphWalkSummary(state).join(", ")}`);
}

function graphAdditionalModules(
  state: ModuleGraphState,
  registryNames: ReadonlyMap<string, string>,
): Record<string, BakedModule> {
  const additionalModules: Record<string, BakedModule> = {};
  for (const [url, body] of state.modules) {
    const name = moduleRegistryName(url, registryNames);
    additionalModules[name] = state.jsonModules.has(url)
      ? { json: state.jsonModules.get(url) }
      : body;
  }
  return additionalModules;
}

export async function walkModuleGraph(input: WalkModuleGraphInput): Promise<WalkResult> {
  const state = createModuleGraphState(input);
  prepareModuleDocument(state);
  if (isGraphWalkEmpty(state)) return emptyGraphResult(state);
  state.outbound = createGraphOutbound(state);
  initializeGraphQueue(state);
  state.walkStartedAt = Date.now();
  await runGraphWorkers(state);
  await discoverWebpackChunks(state);
  pruneAfterWalkDeadline(state);

  const registryNames = assignModuleRegistryNames(state.modules.keys());
  removeRecoveredSizeSkips(state);
  rewriteClassicDescriptors(state, registryNames);
  rewriteModuleSources(state, registryNames);
  applyModuleEntryResults(state, registryNames);
  logGraphWalkSummary(state);

  return {
    descriptors: state.descriptors,
    additionalModules: graphAdditionalModules(state, registryNames),
    importMapModuleSource: importMapModuleSource(state.importMap, registryNames),
  };
}
