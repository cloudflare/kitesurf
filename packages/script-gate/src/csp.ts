// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Parses CSP policies and evaluates the directives that govern script execution.

import type { SriAlgorithm } from "./sri.ts";

export interface CspPolicy {
  directives: Map<string, string[]>;
  text: string;
}

export function parseCspPolicies(
  values: readonly (string | null | undefined)[],
  splitOnComma = true,
): CspPolicy[] {
  const policies: CspPolicy[] = [];
  for (const value of values) {
    if (!value) continue;
    for (const raw of splitOnComma ? value.split(",") : [value]) {
      const text = raw.trim();
      if (!text) continue;
      const directives = new Map<string, string[]>();
      for (const chunk of text.split(";")) {
        const tokens = chunk.trim().split(/\s+/).filter(Boolean);
        const name = tokens[0]?.toLowerCase();
        if (name === undefined) continue;
        if (directives.has(name)) continue;
        directives.set(name, tokens.slice(1));
      }
      if (directives.size > 0) policies.push({ directives, text });
    }
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

function schemeMatches(sourceScheme: string, urlScheme: string): boolean {
  if (sourceScheme === urlScheme) return true;
  if (sourceScheme === "http:" && urlScheme === "https:") return true;
  if (sourceScheme === "ws:" && urlScheme === "wss:") return true;
  if (sourceScheme === "ws:" && urlScheme === "http:") return true;
  if (sourceScheme === "ws:" && urlScheme === "https:") return true;
  if (sourceScheme === "wss:" && urlScheme === "https:") return true;
  return false;
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

function sourceExpressionMatches(source: string, url: URL): boolean {
  if (/^[a-z][a-z0-9+.-]*:$/i.test(source)) {
    return schemeMatches(source.toLowerCase(), url.protocol);
  }
  if (source === "*") {
    return (
      url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "ws:" ||
      url.protocol === "wss:" ||
      url.protocol === "ftp:"
    );
  }

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
  if (remainingSource.startsWith("[")) return false;
  let sourcePort = "";
  const portSeparator = remainingSource.lastIndexOf(":");
  if (portSeparator >= 0) {
    sourcePort = remainingSource.slice(portSeparator + 1);
    remainingSource = remainingSource.slice(0, portSeparator);
  }
  const sourceHost = remainingSource;
  if (!sourceHost) return false;

  if (sourceScheme) {
    if (!schemeMatches(sourceScheme, url.protocol)) return false;
  } else if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  if (!hostMatches(sourceHost, url.hostname)) return false;
  if (sourcePort === "*") return pathMatches(path, url.pathname);
  if (sourcePort) {
    if (sourcePort !== portOf(url)) return false;
  } else if (!sourceScheme) {
    if (portOf(url) !== defaultPortForScheme(url.protocol)) return false;
  } else if (portOf(url) !== defaultPortForScheme(sourceScheme)) {
    if (!(sourceScheme === "http:" && url.protocol === "https:" && portOf(url) === "443")) {
      return false;
    }
  }
  return pathMatches(path, url.pathname);
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

function sourceListAllows(
  sourceList: readonly string[],
  request: CspScriptRequest,
  inlineHashes: readonly string[],
): boolean {
  const lowercaseSources = sourceList.map((source) => source.toLowerCase());
  if (lowercaseSources.length === 1 && lowercaseSources[0] === "'none'") return false;

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

  const nonce = request.nonce ?? "";
  if (nonce && nonces.includes(nonce)) return true;

  if (request.url === null) {
    // CSP ignores unsafe-inline once a nonce or hash source is present.
    if (nonces.length === 0 && hashes.length === 0) {
      return lowercaseSources.includes("'unsafe-inline'");
    }
    for (const inlineHash of inlineHashes) {
      if (hashes.includes(inlineHash)) return true;
    }
    return false;
  }

  if (lowercaseSources.includes("'strict-dynamic'")) {
    return request.runtimeInserted === true;
  }

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  for (const source of sourceList) {
    const lowercaseSource = source.toLowerCase();
    if (lowercaseSource === "'self'") {
      let documentUrl: URL;
      try {
        documentUrl = new URL(request.documentUrl);
      } catch {
        continue;
      }
      if (
        url.hostname.toLowerCase() === documentUrl.hostname.toLowerCase() &&
        portOf(url) === portOf(documentUrl) &&
        schemeMatches(documentUrl.protocol, url.protocol)
      ) {
        return true;
      }
      continue;
    }
    if (lowercaseSource.startsWith("'")) continue;
    if (sourceExpressionMatches(source, url)) return true;
  }
  return false;
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

function handlerSourceList(policy: CspPolicy): { name: string; list: string[] } | null {
  for (const name of ["script-src-attr", "script-src", "default-src"]) {
    const list = policy.directives.get(name);
    if (list) return { name, list };
  }
  return null;
}

/** CSP3 inline check for an event handler attribute: a nonce never admits one. A hash needs
 *  'unsafe-hashes' and an async digest, but handlers compile synchronously, so it refuses. */
export function cspAllowsInlineHandler(policies: readonly CspPolicy[]): CspVerdict {
  for (const policy of policies) {
    const found = handlerSourceList(policy);
    if (found === null) continue;
    const sources = found.list.map((source) => source.toLowerCase());
    const hasNonceOrHash = sources.some(
      (source) => (source.startsWith(NONCE_PREFIX) && source.endsWith("'")) || HASH_RE.test(source),
    );
    if (!sources.includes("'unsafe-inline'") || hasNonceOrHash) {
      return {
        allowed: false,
        policyText: policy.text,
        directive: `${found.name} ${found.list.join(" ")}`.trim(),
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
