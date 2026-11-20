// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Evaluates the response policies that decide whether a frame may be embedded: CSP
// `frame-ancestors` and `X-Frame-Options`. The engine and the page-script isolate share this
// module, so both commit paths apply one grammar to one trusted ancestor chain.

import type { CommittedOrigin } from "@kitesurf/jsrpc-types/frame-origin";
import { defaultPortForScheme, parseCspPolicies, schemeMatches, type CspPolicy } from "./csp.ts";

export interface EmbeddingPolicyInput {
  /** Enforced CSP header values; report-only and meta policies are excluded. */
  cspHeaders: readonly (string | null | undefined)[];
  /** `X-Frame-Options` header values, one per header line. */
  xFrameOptions?: readonly (string | null | undefined)[];
  /** The terminal response URL origin used by CSP `'self'` and XFO `SAMEORIGIN`. */
  destinationOrigin: CommittedOrigin;
  /** The document's ancestor committed origins, nearest first. */
  ancestorOrigins: readonly CommittedOrigin[];
}

export type EmbeddingPolicyVerdict =
  | { allowed: true }
  | {
      allowed: false;
      reason: "frame-ancestors" | "x-frame-options";
      policyText?: string;
      directive?: string;
    };

/** The committed origin of a URL. A URL that serializes an opaque origin keeps a distinct id. */
export function committedOriginOfUrl(url: string, opaqueId: string): CommittedOrigin {
  try {
    const parsed = new URL(url);
    if (parsed.origin === "null") return { kind: "opaque", id: opaqueId };
    return { kind: "tuple", origin: parsed.origin };
  } catch {
    return { kind: "opaque", id: opaqueId };
  }
}

export function sameCommittedOrigin(a: CommittedOrigin, b: CommittedOrigin): boolean {
  if (a.kind === "opaque" || b.kind === "opaque") {
    return a.kind === "opaque" && b.kind === "opaque" && a.id === b.id;
  }
  return a.origin === b.origin;
}

function tupleUrl(origin: CommittedOrigin): URL | null {
  if (origin.kind !== "tuple") return null;
  try {
    return new URL(origin.origin);
  } catch {
    return null;
  }
}

function schemeOf(origin: CommittedOrigin): string | null {
  const url = tupleUrl(origin);
  return url ? url.protocol.slice(0, -1) : null;
}

function numericDefaultPort(scheme: string): number | null {
  const port = defaultPortForScheme(`${scheme}:`);
  return port === "" ? null : Number(port);
}

function portNumber(url: URL): number | null {
  return url.port === "" ? null : Number(url.port);
}

// CSP3 §6.7.2.9, expressed without the trailing colon.
function schemePartMatches(sourceScheme: string, urlScheme: string): boolean {
  return schemeMatches(`${sourceScheme.toLowerCase()}:`, `${urlScheme.toLowerCase()}:`);
}

// CSP3 §6.7.2.11. Chrome also treats a host-part "*" as matching every host, including an IP
// address; the literal CSP3 text refuses non-domain hosts before that check. Verified against
// Chrome for http://*:port on IPv4 and IPv6 origins.
function portPartMatches(sourcePort: string | undefined, url: URL): boolean {
  if (sourcePort === "*") return true;
  const urlPort = portNumber(url);
  const defaultPort = numericDefaultPort(url.protocol.slice(0, -1));
  if (sourcePort === undefined) return urlPort === null || urlPort === defaultPort;
  return urlPort === null ? Number(sourcePort) === defaultPort : Number(sourcePort) === urlPort;
}

function hostPartMatches(pattern: string, url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  if (pattern === "*") return true;
  const normalized = pattern.toLowerCase();
  if (normalized.startsWith("*.")) {
    const suffix = normalized.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return normalized === host;
}

function decodePathPiece(piece: string): string {
  try {
    return decodeURIComponent(piece);
  } catch {
    return piece;
  }
}

// CSP3 §6.7.2.12.
function pathPartMatches(sourcePath: string, urlPath: string): boolean {
  if (sourcePath === "") return true;
  if (sourcePath === "/" && urlPath === "") return true;
  const exact = !sourcePath.endsWith("/");
  const sourcePieces = sourcePath.split("/");
  const urlPieces = urlPath.split("/");
  if (sourcePieces.length > urlPieces.length) return false;
  if (exact && sourcePieces.length !== urlPieces.length) return false;
  if (!exact) sourcePieces.pop();
  for (let index = 0; index < sourcePieces.length; index++) {
    if (decodePathPiece(sourcePieces[index]!) !== decodePathPiece(urlPieces[index]!)) return false;
  }
  return true;
}

interface HostSource {
  scheme: string | null;
  host: string;
  port: string | undefined;
  path: string | undefined;
}

function hostSourceOf(expression: string): HostSource | null {
  let rest = expression;
  let scheme: string | null = null;
  const schemeSeparator = rest.indexOf("://");
  if (schemeSeparator >= 0) {
    const candidate = rest.slice(0, schemeSeparator);
    if (!/^[a-z][a-z0-9+.-]*$/i.test(candidate)) return null;
    scheme = candidate.toLowerCase();
    rest = rest.slice(schemeSeparator + 3);
  }
  let path: string | undefined;
  const pathStart = rest.indexOf("/");
  if (pathStart >= 0) {
    path = rest.slice(pathStart);
    rest = rest.slice(0, pathStart);
  }
  // host-char excludes ":" and "[", so an IPv6 literal is not a valid host-source and matches
  // nothing. A host with a port is split on its final colon.
  let port: string | undefined;
  const portSeparator = rest.lastIndexOf(":");
  if (portSeparator >= 0) {
    port = rest.slice(portSeparator + 1);
    rest = rest.slice(0, portSeparator);
    if (port !== "*" && !/^\d+$/.test(port)) return null;
  }
  if (rest === "") return null;
  const host = rest;
  if (host !== "*") {
    const body = host.startsWith("*.") ? host.slice(2) : host;
    if (body === "" || !body.split(".").every((label) => /^[a-z0-9-]+$/i.test(label))) {
      return null;
    }
  }
  return { scheme, host, port, path };
}

function selfMatches(ancestor: URL, destination: CommittedOrigin): boolean {
  if (ancestor.protocol === "blob:") return false;
  if (destination.kind !== "tuple") return false;
  const self = tupleUrl(destination);
  if (!self) return false;
  if (self.origin === ancestor.origin) return true;
  const selfPort = portNumber(self) ?? numericDefaultPort(self.protocol.slice(0, -1));
  const ancestorPort = portNumber(ancestor) ?? numericDefaultPort(ancestor.protocol.slice(0, -1));
  const portsCompatible =
    selfPort === ancestorPort ||
    (selfPort === numericDefaultPort(self.protocol.slice(0, -1)) &&
      ancestorPort === numericDefaultPort(ancestor.protocol.slice(0, -1)));
  if (self.hostname !== ancestor.hostname || !portsCompatible) return false;
  if (ancestor.protocol === "https:" || ancestor.protocol === "wss:") return true;
  if (self.protocol === "http:" && (ancestor.protocol === "http:" || ancestor.protocol === "ws:")) {
    return true;
  }
  return false;
}

function sourceExpressionMatches(
  expression: string,
  ancestor: URL,
  destination: CommittedOrigin,
): boolean {
  const lowercase = expression.toLowerCase();
  if (lowercase === "*") {
    if (ancestor.protocol === "http:" || ancestor.protocol === "https:") return true;
    const destinationScheme = schemeOf(destination);
    return destinationScheme !== null && destinationScheme === ancestor.protocol.slice(0, -1);
  }
  if (lowercase === "'self'") return selfMatches(ancestor, destination);
  if (lowercase.startsWith("'")) return false;
  if (/^[a-z][a-z0-9+.-]*:$/i.test(expression)) {
    return schemePartMatches(expression.slice(0, -1), ancestor.protocol.slice(0, -1));
  }
  const source = hostSourceOf(expression);
  if (!source) return false;
  const ancestorScheme = ancestor.protocol.slice(0, -1);
  if (source.scheme !== null) {
    if (!schemePartMatches(source.scheme, ancestorScheme)) return false;
  } else {
    const destinationScheme = schemeOf(destination);
    if (destinationScheme === null || !schemePartMatches(destinationScheme, ancestorScheme)) {
      return false;
    }
  }
  if (!hostPartMatches(source.host, ancestor)) return false;
  if (!portPartMatches(source.port, ancestor)) return false;
  if (source.path !== undefined && !pathPartMatches(source.path, ancestor.pathname)) return false;
  return true;
}

function sourceListAllowsAncestor(
  sourceList: readonly string[],
  ancestor: CommittedOrigin,
  destination: CommittedOrigin,
): boolean {
  const url = tupleUrl(ancestor);
  // An opaque ancestor has no URL to match; no source expression, including "*", admits it.
  if (!url) return false;
  return sourceList.some((expression) => sourceExpressionMatches(expression, url, destination));
}

function frameAncestorsAllows(sourceList: readonly string[], input: EmbeddingPolicyInput): boolean {
  if (input.ancestorOrigins.length === 0) return true;
  if (sourceList.length === 1 && sourceList[0]!.toLowerCase() === "'none'") return false;
  // An empty source list is equivalent to 'none'. "'none'" next to other expressions has no
  // effect, so those expressions are still evaluated.
  if (sourceList.length === 0) return false;
  return input.ancestorOrigins.every((ancestor) =>
    sourceListAllowsAncestor(sourceList, ancestor, input.destinationOrigin),
  );
}

function policyFrameAncestors(policy: CspPolicy): string[] | undefined {
  return policy.directives.get("frame-ancestors");
}

function xFrameOptionsAllows(input: EmbeddingPolicyInput): boolean {
  if (input.ancestorOrigins.length === 0) return true;
  const values = new Set<string>();
  for (const value of input.xFrameOptions ?? []) {
    if (value === null || value === undefined) continue;
    // Fetch "get, decode, and split" preserves empty comma elements, so "SAMEORIGIN," blocks.
    for (const part of value.split(",")) values.add(part.trim().toLowerCase());
  }
  if (values.size > 1) {
    // Any attempt to combine a valid value with another value blocks.
    return !(values.has("deny") || values.has("allowall") || values.has("sameorigin"));
  }
  const [only] = values;
  if (only === "deny") return false;
  if (only === "sameorigin") {
    return input.ancestorOrigins.every((ancestor) =>
      sameCommittedOrigin(ancestor, input.destinationOrigin),
    );
  }
  // A lone invalid value, including legacy ALLOWALL and ALLOW-FROM, is ignored.
  return true;
}

export function embeddingPolicyVerdict(input: EmbeddingPolicyInput): EmbeddingPolicyVerdict {
  const policies = parseCspPolicies(input.cspHeaders);
  let sawFrameAncestors = false;
  for (const policy of policies) {
    const sourceList = policyFrameAncestors(policy);
    if (sourceList === undefined) continue;
    sawFrameAncestors = true;
    if (!frameAncestorsAllows(sourceList, input)) {
      return {
        allowed: false,
        reason: "frame-ancestors",
        policyText: policy.text,
        directive: `frame-ancestors ${sourceList.join(" ")}`.trim(),
      };
    }
  }
  // An enforced frame-ancestors directive replaces X-Frame-Options even when it permits the chain.
  if (sawFrameAncestors) return { allowed: true };
  if (!xFrameOptionsAllows(input)) {
    return {
      allowed: false,
      reason: "x-frame-options",
      directive: "X-Frame-Options",
    };
  }
  return { allowed: true };
}
