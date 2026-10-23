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
  const rejectPattern = rejectPatternReason(filters, url);
  if (rejectPattern) return { blocked: true, reason: rejectPattern };
  const rejectType = rejectResourceReason(filters, resourceType);
  if (rejectType) return { blocked: true, reason: rejectType };
  const allowPattern = allowPatternReason(filters, url);
  if (allowPattern) return { blocked: true, reason: allowPattern };
  const allowType = allowResourceReason(filters, resourceType);
  if (allowType) return { blocked: true, reason: allowType };
  return { blocked: false };
}

function rejectPatternReason(filters: OutboundFilters, url: string): string | null {
  const matched = matchingPattern(filters.rejectPatterns, url);
  return matched ? `rejectRequestPattern matched (${matched.source})` : null;
}

function rejectResourceReason(filters: OutboundFilters, resourceType: string): string | null {
  const rejected = filters.rejectResourceTypes;
  if (!rejected || rejected.size === 0 || !rejected.has(resourceType.toLowerCase())) return null;
  return `rejectResourceTypes matched (${resourceType})`;
}

function allowPatternReason(filters: OutboundFilters, url: string): string | null {
  const allowed = filters.allowPatterns;
  if (!allowed || allowed.length === 0 || matchingPattern(allowed, url)) return null;
  return "allowRequestPattern did not match";
}

function allowResourceReason(filters: OutboundFilters, resourceType: string): string | null {
  const allowed = filters.allowResourceTypes;
  if (!allowed || allowed.size === 0 || allowed.has(resourceType.toLowerCase())) return null;
  return `allowResourceTypes did not match (${resourceType})`;
}

function matchingPattern(patterns: RegExp[] | undefined, url: string): RegExp | null {
  if (!patterns) return null;
  for (const pattern of patterns) {
    if (pattern.test(url)) return pattern;
  }
  return null;
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
  const validationError = validatePatternInputs(input);
  if (validationError) return { ok: false, error: validationError };
  const regexError = compileRegexFilters(input, filters);
  if (regexError) return { ok: false, error: regexError };
  addResourceTypeFilters(input, filters);
  return { ok: true, filters };
}

function validatePatternInputs(input: {
  allowRequestPattern?: string[];
  rejectRequestPattern?: string[];
}): string | null {
  for (const [name, arr] of [
    ["allowRequestPattern", input.allowRequestPattern],
    ["rejectRequestPattern", input.rejectRequestPattern],
  ] as const) {
    const error = validatePatternInput(name, arr);
    if (error) return error;
  }
  return null;
}

function validatePatternInput(name: string, patterns: string[] | undefined): string | null {
  if (!patterns) return null;
  if (patterns.length > MAX_PATTERNS_PER_SIDE) {
    return `too many ${name} entries (${patterns.length} > ${MAX_PATTERNS_PER_SIDE})`;
  }
  for (const pattern of patterns) {
    if (pattern.length > MAX_PATTERN_LEN) {
      return `${name} regex too long (${pattern.length} > ${MAX_PATTERN_LEN} chars)`;
    }
  }
  return null;
}

function compileRegexFilters(
  input: { allowRequestPattern?: string[]; rejectRequestPattern?: string[] },
  filters: OutboundFilters,
): string | null {
  try {
    const allowPatterns = compilePatterns(input.allowRequestPattern);
    if (allowPatterns) filters.allowPatterns = allowPatterns;
    const rejectPatterns = compilePatterns(input.rejectRequestPattern);
    if (rejectPatterns) filters.rejectPatterns = rejectPatterns;
  } catch (err) {
    return `invalid regex: ${regexErrorMessage(err)}`;
  }
  return null;
}

function compilePatterns(patterns: string[] | undefined): RegExp[] | undefined {
  if (!patterns || patterns.length === 0) return undefined;
  return patterns.map((pattern) => new RegExp(pattern));
}

function regexErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function addResourceTypeFilters(
  input: { allowResourceTypes?: string[]; rejectResourceTypes?: string[] },
  filters: OutboundFilters,
): void {
  if (input.allowResourceTypes && input.allowResourceTypes.length > 0) {
    filters.allowResourceTypes = new Set(input.allowResourceTypes.map((s) => s.toLowerCase()));
  }
  if (input.rejectResourceTypes && input.rejectResourceTypes.length > 0) {
    filters.rejectResourceTypes = new Set(input.rejectResourceTypes.map((s) => s.toLowerCase()));
  }
}
