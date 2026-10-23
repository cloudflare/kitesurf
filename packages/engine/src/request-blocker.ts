// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Host-supplied request blocking applied before egress and before OOPIF spawn.

import type { ResourceType } from "./cdp/network-events.ts";
import { siteKey } from "./public-suffix.ts";

/** Request facts the engine computes before asking a host blocker. */
export interface BlockableRequest {
  readonly url: URL;
  /** Lowercase hostname of the embedding document; empty for opaque origins. */
  readonly pageHost: string;
  /** True when the request and page hosts have different registrable domains. */
  readonly thirdParty: boolean;
  /** CDP resource type; child frames are "Document". Top-level navigations are never classified. */
  readonly resourceType: ResourceType;
}

export interface RequestBlockVerdict {
  /** List entry that matched, reported in the 451 response and CDP log. */
  readonly matched: string;
  /** Human-readable reason, for example "request blocklist matched (example.com)". */
  readonly reason: string;
}

/** Synchronous, side-effect-free classifier shared by every connection of a Worker. */
export interface RequestBlocker {
  classify(request: BlockableRequest): RequestBlockVerdict | null;
}

const RESOURCE_TYPES: ReadonlySet<string> = new Set<ResourceType>([
  "Document",
  "Stylesheet",
  "Image",
  "Media",
  "Font",
  "Script",
  "TextTrack",
  "XHR",
  "Fetch",
  "Prefetch",
  "EventSource",
  "WebSocket",
  "Manifest",
  "SignedExchange",
  "Ping",
  "CSPViolationReport",
  "Preflight",
  "FedCM",
  "Other",
]);

/** Parses an internal resource-type header; unknown or missing values are "Other". */
export function parseResourceType(value: string | null): ResourceType {
  return value !== null && isResourceType(value) ? value : "Other";
}

function isResourceType(value: string): value is ResourceType {
  return RESOURCE_TYPES.has(value);
}

const registry = new Map<string, RequestBlocker>();

export function registerRequestBlocker(connectionId: string, blocker: RequestBlocker): void {
  registry.set(connectionId, blocker);
}

export function unregisterRequestBlocker(connectionId: string): void {
  registry.delete(connectionId);
}

export function getRequestBlocker(connectionId: string): RequestBlocker | undefined {
  return registry.get(connectionId);
}

function normalizeHost(host: string): string {
  const h = host.toLowerCase();
  return h.endsWith(".") ? h.slice(0, -1) : h;
}

function parseHttpUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Classifies an http(s) URL against a host blocker. Other schemes, unparseable
 * URLs and an absent blocker are never blocked.
 */
export function classifyRequest(
  blocker: RequestBlocker | undefined,
  url: string,
  pageHost: string,
  resourceType: ResourceType,
): RequestBlockVerdict | null {
  if (!blocker) return null;
  const parsed = parseHttpUrl(url);
  if (!parsed) return null;
  const host = normalizeHost(parsed.hostname);
  if (!host) return null;
  const page = normalizeHost(pageHost);
  return blocker.classify({
    url: parsed,
    pageHost: page,
    thirdParty: page === "" || siteKey(host) !== siteKey(page),
    resourceType,
  });
}
