// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Parses CSP policies and evaluates the directives that govern script execution.

import type { SriAlgorithm } from "./sri.ts";

export interface CspPolicy {
  directives: Map<string, string[]>;
  text: string;
}

function parseCspPolicy(raw: string): CspPolicy | null {
  const text = raw.trim();
  if (!text) return null;
  const directives = new Map<string, string[]>();
  for (const chunk of text.split(";")) {
    addDirectiveChunk(directives, chunk);
  }
  if (directives.size === 0) return null;
  return { directives, text };
}

function addDirectiveChunk(directives: Map<string, string[]>, chunk: string): void {
  const tokens = chunk.trim().split(/\s+/).filter(Boolean);
  const name = tokens[0]?.toLowerCase();
  if (name === undefined || directives.has(name)) return;
  directives.set(name, tokens.slice(1));
}

function addHeaderPolicies(value: string, splitOnComma: boolean, policies: CspPolicy[]): void {
  const rawPolicies = splitOnComma ? value.split(",") : [value];
  for (const raw of rawPolicies) {
    const policy = parseCspPolicy(raw);
    if (policy !== null) policies.push(policy);
  }
}

export function parseCspPolicies(
  values: readonly (string | null | undefined)[],
  splitOnComma = true,
): CspPolicy[] {
  const policies: CspPolicy[] = [];
  for (const value of values) {
    if (!value) continue;
    addHeaderPolicies(value, splitOnComma, policies);
  }
  return policies;
}

export function scriptSourceList(policy: CspPolicy): string[] | null {
  return (
    policy.directives.get("script-src-elem") ??
    policy.directives.get("script-src") ??
    policy.directives.get("default-src") ??
    null
  );
}

function effectiveDirectiveName(policy: CspPolicy): string {
  if (policy.directives.has("script-src-elem")) return "script-src-elem";
  if (policy.directives.has("script-src")) return "script-src";
  return "default-src";
}

function defaultPortForScheme(scheme: string): string {
  switch (scheme) {
    case "http:":
      return "80";
    case "https:":
      return "443";
    case "ws:":
      return "80";
    case "wss:":
      return "443";
    case "ftp:":
      return "21";
    default:
      return "";
  }
}

function portOf(url: URL): string {
  return url.port || defaultPortForScheme(url.protocol);
}

const SCHEME_UPGRADES: ReadonlyMap<string, readonly string[]> = new Map([
  ["http:", ["https:"]],
  ["ws:", ["wss:", "http:", "https:"]],
  ["wss:", ["https:"]],
]);

function schemeMatches(sourceScheme: string, urlScheme: string): boolean {
  return (
    sourceScheme === urlScheme || SCHEME_UPGRADES.get(sourceScheme)?.includes(urlScheme) === true
  );
}

function hostMatches(sourceHost: string, urlHost: string): boolean {
  const normalizedSourceHost = sourceHost.toLowerCase();
  const normalizedUrlHost = urlHost.toLowerCase();
  if (normalizedSourceHost === "*") return true;
  if (normalizedSourceHost.startsWith("*.")) {
    const suffix = normalizedSourceHost.slice(1);
    return normalizedUrlHost.endsWith(suffix) && normalizedUrlHost.length > suffix.length;
  }
  return normalizedSourceHost === normalizedUrlHost;
}

function pathMatches(sourcePath: string, urlPath: string): boolean {
  if (sourcePath === "" || sourcePath === "/") return true;
  const decodedSource = safeDecode(sourcePath);
  const decodedUrl = safeDecode(urlPath);
  if (decodedSource.endsWith("/")) return decodedUrl.startsWith(decodedSource);
  return decodedUrl === decodedSource;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

interface HostSource {
  scheme: string;
  host: string;
  port: string;
  path: string;
}

function parseSourceHostAndPort(remainingSource: string): { host: string; port: string } | null {
  if (remainingSource.startsWith("[")) return null;
  let sourcePort = "";
  const portSeparator = remainingSource.lastIndexOf(":");
  if (portSeparator >= 0) {
    sourcePort = remainingSource.slice(portSeparator + 1);
    remainingSource = remainingSource.slice(0, portSeparator);
  }
  if (!remainingSource) return null;
  return { host: remainingSource, port: sourcePort };
}

function parseHostSource(source: string): HostSource | null {
  let remainingSource = source;
  let sourceScheme = "";
  const schemeSeparator = remainingSource.indexOf("://");
  if (schemeSeparator >= 0) {
    sourceScheme = remainingSource.slice(0, schemeSeparator + 1).toLowerCase();
    remainingSource = remainingSource.slice(schemeSeparator + 3);
  }
  let path = "";
  const pathStart = remainingSource.indexOf("/");
  if (pathStart >= 0) {
    path = remainingSource.slice(pathStart);
    remainingSource = remainingSource.slice(0, pathStart);
  }
  const hostAndPort = parseSourceHostAndPort(remainingSource);
  if (hostAndPort === null) return null;
  return { scheme: sourceScheme, ...hostAndPort, path };
}

function schemePortMatches(sourceScheme: string, url: URL): boolean {
  if (portOf(url) === defaultPortForScheme(sourceScheme)) return true;
  return sourceScheme === "http:" && url.protocol === "https:" && portOf(url) === "443";
}

function sourcePortMatches(sourcePort: string, sourceScheme: string, url: URL): boolean {
  if (sourcePort === "*") return true;
  if (sourcePort) return sourcePort === portOf(url);
  if (!sourceScheme) return portOf(url) === defaultPortForScheme(url.protocol);
  return schemePortMatches(sourceScheme, url);
}

function sourceSchemeMatches(sourceScheme: string, url: URL): boolean {
  if (sourceScheme) return schemeMatches(sourceScheme, url.protocol);
  return url.protocol === "http:" || url.protocol === "https:";
}

function hostSourceMatches(source: HostSource, url: URL): boolean {
  if (!sourceSchemeMatches(source.scheme, url)) return false;
  if (!hostMatches(source.host, url.hostname)) return false;
  if (!sourcePortMatches(source.port, source.scheme, url)) return false;
  return pathMatches(source.path, url.pathname);
}

function isWebScheme(url: URL): boolean {
  return (
    url.protocol === "http:" ||
    url.protocol === "https:" ||
    url.protocol === "ws:" ||
    url.protocol === "wss:" ||
    url.protocol === "ftp:"
  );
}

function sourceExpressionMatches(source: string, url: URL): boolean {
  if (/^[a-z][a-z0-9+.-]*:$/i.test(source)) {
    return schemeMatches(source.toLowerCase(), url.protocol);
  }
  if (source === "*") return isWebScheme(url);
  const hostSource = parseHostSource(source);
  return hostSource !== null && hostSourceMatches(hostSource, url);
}

export interface CspScriptRequest {
  url: string | null;
  documentUrl: string;
  nonce?: string | null;
  runtimeInserted?: boolean;
}

export interface CspVerdict {
  allowed: boolean;
  policyText?: string;
  directive?: string;
}

const NONCE_PREFIX = "'nonce-";
const HASH_RE = /^'(sha256|sha384|sha512)-([A-Za-z0-9+/\-_=]+)'$/;

interface NonceAndHashSources {
  nonces: string[];
  hashes: string[];
}

function nonceAndHashSources(sourceList: readonly string[]): NonceAndHashSources {
  const nonces: string[] = [];
  const hashes: string[] = [];
  for (const source of sourceList) {
    const lowercaseSource = source.toLowerCase();
    if (lowercaseSource.startsWith(NONCE_PREFIX) && source.endsWith("'")) {
      nonces.push(source.slice(NONCE_PREFIX.length, -1));
    } else if (HASH_RE.test(source)) {
      hashes.push(source.slice(1, -1));
    }
  }
  return { nonces, hashes };
}

function inlineSourceListAllows(
  lowercaseSources: readonly string[],
  nonces: readonly string[],
  hashes: readonly string[],
  inlineHashes: readonly string[],
): boolean {
  if (nonces.length === 0 && hashes.length === 0) {
    return lowercaseSources.includes("'unsafe-inline'");
  }
  for (const inlineHash of inlineHashes) {
    if (hashes.includes(inlineHash)) return true;
  }
  return false;
}

function isSoleNoneSource(lowercaseSources: readonly string[]): boolean {
  return lowercaseSources.length === 1 && lowercaseSources[0] === "'none'";
}

function nonceMatches(request: CspScriptRequest, nonces: readonly string[]): boolean {
  const nonce = request.nonce ?? "";
  return nonce !== "" && nonces.includes(nonce);
}

function parseCspUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function selfSourceMatches(url: URL, documentUrl: string): boolean {
  const document = parseCspUrl(documentUrl);
  return (
    document !== null &&
    url.hostname.toLowerCase() === document.hostname.toLowerCase() &&
    portOf(url) === portOf(document) &&
    schemeMatches(document.protocol, url.protocol)
  );
}

function externalSourceAllows(source: string, documentUrl: string, url: URL): boolean {
  const lowercaseSource = source.toLowerCase();
  if (lowercaseSource === "'self'") return selfSourceMatches(url, documentUrl);
  if (lowercaseSource.startsWith("'")) return false;
  return sourceExpressionMatches(source, url);
}

function externalSourceListAllows(
  sourceList: readonly string[],
  documentUrl: string,
  url: URL,
): boolean {
  for (const source of sourceList) {
    if (externalSourceAllows(source, documentUrl, url)) return true;
  }
  return false;
}

function requestSourceListAllows(
  lowercaseSources: readonly string[],
  sourceList: readonly string[],
  request: CspScriptRequest,
  nonces: readonly string[],
  hashes: readonly string[],
  inlineHashes: readonly string[],
): boolean {
  if (request.url === null) {
    // CSP ignores unsafe-inline once a nonce or hash source is present.
    return inlineSourceListAllows(lowercaseSources, nonces, hashes, inlineHashes);
  }
  if (lowercaseSources.includes("'strict-dynamic'")) {
    return request.runtimeInserted === true;
  }
  const url = parseCspUrl(request.url);
  if (url === null) return false;
  return externalSourceListAllows(sourceList, request.documentUrl, url);
}

function sourceListAllows(
  sourceList: readonly string[],
  request: CspScriptRequest,
  inlineHashes: readonly string[],
): boolean {
  const lowercaseSources = sourceList.map((source) => source.toLowerCase());
  if (isSoleNoneSource(lowercaseSources)) return false;
  const { nonces, hashes } = nonceAndHashSources(sourceList);
  if (nonceMatches(request, nonces)) return true;
  return requestSourceListAllows(
    lowercaseSources,
    sourceList,
    request,
    nonces,
    hashes,
    inlineHashes,
  );
}

export function cspAllowsScript(
  policies: readonly CspPolicy[],
  request: CspScriptRequest,
  inlineHashes: readonly string[] = [],
): CspVerdict {
  for (const policy of policies) {
    const sourceList = scriptSourceList(policy);
    if (sourceList === null) continue;
    if (!sourceListAllows(sourceList, request, inlineHashes)) {
      return {
        allowed: false,
        policyText: policy.text,
        directive: `${effectiveDirectiveName(policy)} ${sourceList.join(" ")}`.trim(),
      };
    }
  }
  return { allowed: true };
}

export function inlineHashAlgorithms(policies: readonly CspPolicy[]): SriAlgorithm[] {
  const algorithms = new Set<SriAlgorithm>();
  for (const policy of policies) {
    const sourceList = scriptSourceList(policy);
    if (!sourceList) continue;
    for (const source of sourceList) {
      const hashMatch = HASH_RE.exec(source);
      if (hashMatch) algorithms.add(hashMatch[1] as SriAlgorithm);
    }
  }
  return [...algorithms];
}
