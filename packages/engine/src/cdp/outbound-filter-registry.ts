// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Stores per-connection URL and resource-type filters used by page egress.

export type OutboundResourceType =
  | "Document"
  | "Stylesheet"
  | "Image"
  | "Media"
  | "Font"
  | "Script"
  | "TextTrack"
  | "XHR"
  | "Fetch"
  | "Prefetch"
  | "EventSource"
  | "WebSocket"
  | "Manifest"
  | "SignedExchange"
  | "Ping"
  | "CSPViolationReport"
  | "Preflight"
  | "Other";

export interface OutboundFilters {
  allowPatterns?: RegExp[];
  rejectPatterns?: RegExp[];
  allowResourceTypes?: Set<string>;
  rejectResourceTypes?: Set<string>;
}

const registry = new Map<string, OutboundFilters>();

export function registerOutboundFilters(connectionId: string, filters: OutboundFilters): void {
  registry.set(connectionId, filters);
}

export function unregisterOutboundFilters(connectionId: string): void {
  registry.delete(connectionId);
}

export function getOutboundFilters(connectionId: string): OutboundFilters | undefined {
  return registry.get(connectionId);
}

export function shouldBlock(
  filters: OutboundFilters,
  url: string,
  resourceType: string,
): { blocked: true; reason: string } | { blocked: false } {
  if (filters.rejectPatterns && filters.rejectPatterns.length > 0) {
    for (const re of filters.rejectPatterns) {
      if (re.test(url)) {
        return {
          blocked: true,
          reason: `rejectRequestPattern matched (${re.source})`,
        };
      }
    }
  }
  if (
    filters.rejectResourceTypes &&
    filters.rejectResourceTypes.size > 0 &&
    filters.rejectResourceTypes.has(resourceType.toLowerCase())
  ) {
    return {
      blocked: true,
      reason: `rejectResourceTypes matched (${resourceType})`,
    };
  }
  if (filters.allowPatterns && filters.allowPatterns.length > 0) {
    let ok = false;
    for (const re of filters.allowPatterns) {
      if (re.test(url)) {
        ok = true;
        break;
      }
    }
    if (!ok) {
      return { blocked: true, reason: "allowRequestPattern did not match" };
    }
  }
  if (filters.allowResourceTypes && filters.allowResourceTypes.size > 0) {
    if (!filters.allowResourceTypes.has(resourceType.toLowerCase())) {
      return {
        blocked: true,
        reason: `allowResourceTypes did not match (${resourceType})`,
      };
    }
  }
  return { blocked: false };
}

const MAX_PATTERN_LEN = 500;
const MAX_PATTERNS_PER_SIDE = 32;

export function compileOutboundFilters(input: {
  allowRequestPattern?: string[];
  rejectRequestPattern?: string[];
  allowResourceTypes?: string[];
  rejectResourceTypes?: string[];
}): { ok: true; filters: OutboundFilters } | { ok: false; error: string } {
  const filters: OutboundFilters = {};
  for (const [name, arr] of [
    ["allowRequestPattern", input.allowRequestPattern],
    ["rejectRequestPattern", input.rejectRequestPattern],
  ] as const) {
    if (!arr) continue;
    if (arr.length > MAX_PATTERNS_PER_SIDE) {
      return {
        ok: false,
        error: `too many ${name} entries (${arr.length} > ${MAX_PATTERNS_PER_SIDE})`,
      };
    }
    for (const s of arr) {
      if (s.length > MAX_PATTERN_LEN) {
        return {
          ok: false,
          error: `${name} regex too long (${s.length} > ${MAX_PATTERN_LEN} chars)`,
        };
      }
    }
  }
  try {
    if (input.allowRequestPattern && input.allowRequestPattern.length > 0) {
      filters.allowPatterns = input.allowRequestPattern.map((s) => new RegExp(s));
    }
    if (input.rejectRequestPattern && input.rejectRequestPattern.length > 0) {
      filters.rejectPatterns = input.rejectRequestPattern.map((s) => new RegExp(s));
    }
  } catch (err) {
    return {
      ok: false,
      error: `invalid regex: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (input.allowResourceTypes && input.allowResourceTypes.length > 0) {
    filters.allowResourceTypes = new Set(input.allowResourceTypes.map((s) => s.toLowerCase()));
  }
  if (input.rejectResourceTypes && input.rejectResourceTypes.length > 0) {
    filters.rejectResourceTypes = new Set(input.rejectResourceTypes.map((s) => s.toLowerCase()));
  }
  return { ok: true, filters };
}
