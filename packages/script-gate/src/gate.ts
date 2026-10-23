// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Applies shared CSP, mixed-content, MIME, and SRI rules. The engine prefetchers, module walker,
// inserted scripts and boa's module fallback all call it, so a refusal cannot be refetched.

import {
  cspAllowsScript,
  inlineHashAlgorithms,
  parseCspPolicies,
  type CspPolicy,
  type CspScriptRequest,
} from "./csp.ts";
import { blockedByNosniff, isModuleMime, mimeEssence, type ModuleType } from "./mime.ts";
import { digestBase64, integrityMatches, parseIntegrity, type SriAlgorithm } from "./sri.ts";

export type ScriptBlockReason =
  | "csp"
  | "mime"
  | "mixed-content"
  | "nosniff"
  | "sri-mismatch"
  | "sri-opaque"
  | "sri-no-bytes";

/** Carries allow/block status plus optional report-only text, URL upgrades, or module type. */
export interface ScriptGateDecision {
  allowed: boolean;
  reason?: ScriptBlockReason;
  message?: string;
  upgradeTo?: string;
  reportOnly?: string;
  moduleType?: ModuleType;
}

const ALLOWED: ScriptGateDecision = { allowed: true };

export interface ScriptGateContext {
  documentUrl: string;
  policies: CspPolicy[];
  reportOnlyPolicies: CspPolicy[];
  upgradeInsecureRequests: boolean;
}

export interface ScriptGateSources {
  cspHeaders?: readonly (string | null | undefined)[];
  cspReportOnlyHeaders?: readonly (string | null | undefined)[];
  metaCsp?: readonly (string | null | undefined)[];
}

/** Builds enforced and report-only policies; meta CSP entries are not comma-split. */
export function buildScriptGateContext(
  documentUrl: string,
  sources: ScriptGateSources = {},
): ScriptGateContext {
  // Meta CSP is one policy per tag; its commas must not be split into extra policies.
  const policies = [
    ...parseCspPolicies(sources.cspHeaders ?? []),
    ...parseCspPolicies(sources.metaCsp ?? [], false),
  ];
  const reportOnlyPolicies = parseCspPolicies(sources.cspReportOnlyHeaders ?? []);
  const upgradeInsecureRequests = policies.some((policy) =>
    policy.directives.has("upgrade-insecure-requests"),
  );
  return {
    documentUrl,
    policies,
    reportOnlyPolicies,
    upgradeInsecureRequests,
  };
}

export function scriptGateIsNoop(ctx: ScriptGateContext): boolean {
  return (
    ctx.policies.length === 0 &&
    ctx.reportOnlyPolicies.length === 0 &&
    !ctx.documentUrl.startsWith("https:")
  );
}

/** Shared facts for both checks; null URLs mean inline code.
 * `runtimeInserted` selects the CSP strict-dynamic behavior.
 */
export interface ScriptGateRequest {
  url: string | null;
  integrity?: string | null;
  nonce?: string | null;
  body?: string;
  runtimeInserted?: boolean;
  module?: boolean;
}

function isPotentiallyTrustworthy(url: URL): boolean {
  if (TRUSTWORTHY_SCHEMES.has(url.protocol)) return true;
  if (url.protocol === "blob:") {
    const origin = parseOrNull(url.origin);
    return origin !== null && isPotentiallyTrustworthy(origin);
  }
  return isLocalHost(url.hostname.toLowerCase());
}

const TRUSTWORTHY_SCHEMES = new Set(["https:", "wss:", "file:", "data:"]);

function isLocalHost(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1"
  );
}

function parseOrNull(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

interface PreparedScriptUrl {
  url: string | null;
  upgradedTo: string | null;
  blocked: ScriptGateDecision | null;
}

function needsMixedContentBlock(documentUrl: URL | null, target: URL | null): boolean {
  return (
    documentUrl !== null &&
    target !== null &&
    documentUrl.protocol === "https:" &&
    !isPotentiallyTrustworthy(target)
  );
}

function mixedContentDecision(
  ctx: ScriptGateContext,
  request: ScriptGateRequest,
): ScriptGateDecision {
  return {
    allowed: false,
    reason: "mixed-content",
    message:
      `Mixed Content: the page at ${ctx.documentUrl} was loaded over ` +
      `HTTPS, but requested an insecure script ${request.url}. ` +
      `This request has been blocked; the content must be served over HTTPS.`,
  };
}

function upgradedScriptUrl(ctx: ScriptGateContext, target: URL): PreparedScriptUrl | null {
  if (!ctx.upgradeInsecureRequests || target.protocol !== "http:") return null;
  target.protocol = "https:";
  const upgradedTo = target.toString();
  return { url: upgradedTo, upgradedTo, blocked: null };
}

function prepareScriptUrl(ctx: ScriptGateContext, request: ScriptGateRequest): PreparedScriptUrl {
  if (request.url === null) return { url: null, upgradedTo: null, blocked: null };
  const documentUrl = parseOrNull(ctx.documentUrl);
  const target = parseOrNull(request.url);
  if (target === null || !needsMixedContentBlock(documentUrl, target)) {
    return { url: request.url, upgradedTo: null, blocked: null };
  }
  const upgraded = upgradedScriptUrl(ctx, target);
  if (upgraded !== null) return upgraded;
  return { url: request.url, upgradedTo: null, blocked: mixedContentDecision(ctx, request) };
}

function hasNoCspPolicies(ctx: ScriptGateContext): boolean {
  return ctx.policies.length === 0 && ctx.reportOnlyPolicies.length === 0;
}

function cspRequest(
  ctx: ScriptGateContext,
  request: ScriptGateRequest,
  url: string | null,
): CspScriptRequest {
  return {
    url,
    documentUrl: ctx.documentUrl,
    nonce: request.nonce ?? null,
    runtimeInserted: request.runtimeInserted === true,
  };
}

function scriptDescription(url: string | null): string {
  return url === null ? "inline script" : `script from '${url}'`;
}

function enforcedCspDecision(
  description: string,
  directive: string | undefined,
  url: string | null,
): ScriptGateDecision {
  return {
    allowed: false,
    reason: "csp",
    message:
      `Refused to execute ${description} because it violates the following ` +
      `Content Security Policy directive: "${directive}". ` +
      (url === null
        ? "Either the 'unsafe-inline' keyword, a hash, or a nonce is required to enable inline execution."
        : ""),
  };
}

async function reportOnlyHashes(
  ctx: ScriptGateContext,
  request: ScriptGateRequest,
  url: string | null,
  enforcedHashAlgorithms: readonly SriAlgorithm[],
  inlineHashes: string[],
): Promise<string[]> {
  if (url !== null || !request.body) return inlineHashes;
  const reportOnlyAlgorithms = inlineHashAlgorithms(ctx.reportOnlyPolicies);
  const algorithmsToCompute =
    inlineHashes.length > 0
      ? reportOnlyAlgorithms.filter((algorithm) => !enforcedHashAlgorithms.includes(algorithm))
      : reportOnlyAlgorithms;
  const additionalHashes = await inlineBodyHashes(request.body, algorithmsToCompute);
  if (additionalHashes.length > 0) return [...inlineHashes, ...additionalHashes];
  return inlineHashes;
}

async function reportOnlyViolation(
  ctx: ScriptGateContext,
  request: ScriptGateRequest,
  url: string | null,
  enforcedHashAlgorithms: readonly SriAlgorithm[],
  inlineHashes: string[],
): Promise<string | null> {
  if (ctx.reportOnlyPolicies.length === 0) return null;
  const hashes = await reportOnlyHashes(ctx, request, url, enforcedHashAlgorithms, inlineHashes);
  const verdict = cspAllowsScript(ctx.reportOnlyPolicies, cspRequest(ctx, request, url), hashes);
  if (verdict.allowed) return null;
  return (
    `[Report Only] Refused to execute ${scriptDescription(url)} because it violates ` +
    `the following Content Security Policy directive: ` +
    `"${verdict.directive}".`
  );
}

function upgradedDecision(upgradedTo: string | null): ScriptGateDecision {
  return upgradedTo === null ? ALLOWED : { allowed: true, upgradeTo: upgradedTo };
}

function reportOnlyDecision(upgradedTo: string | null, reportOnly: string): ScriptGateDecision {
  return {
    allowed: true,
    reportOnly,
    ...(upgradedTo === null ? {} : { upgradeTo: upgradedTo }),
  };
}

interface EnforcedCspResult {
  algorithms: SriAlgorithm[];
  hashes: string[];
  verdict: ReturnType<typeof cspAllowsScript>;
}

async function enforcedCspResult(
  ctx: ScriptGateContext,
  request: ScriptGateRequest,
  url: string | null,
): Promise<EnforcedCspResult> {
  const algorithms = url === null && request.body ? inlineHashAlgorithms(ctx.policies) : [];
  const hashes =
    url === null && request.body ? await inlineBodyHashes(request.body, algorithms) : [];
  const verdict = cspAllowsScript(ctx.policies, cspRequest(ctx, request, url), hashes);
  return { algorithms, hashes, verdict };
}

/** Checks CSP and mixed content before fetching a script; a null URL means inline code.
 * Report-only violations return `allowed: true` with a `reportOnly` message.
 */
export async function checkScriptBeforeFetch(
  ctx: ScriptGateContext,
  request: ScriptGateRequest,
): Promise<ScriptGateDecision> {
  const prepared = prepareScriptUrl(ctx, request);
  if (prepared.blocked !== null) return prepared.blocked;
  if (hasNoCspPolicies(ctx)) return upgradedDecision(prepared.upgradedTo);

  const enforced = await enforcedCspResult(ctx, request, prepared.url);
  const description = scriptDescription(prepared.url);
  if (!enforced.verdict.allowed) {
    return enforcedCspDecision(description, enforced.verdict.directive, prepared.url);
  }

  const reportOnly = await reportOnlyViolation(
    ctx,
    request,
    prepared.url,
    enforced.algorithms,
    enforced.hashes,
  );
  if (reportOnly !== null) return reportOnlyDecision(prepared.upgradedTo, reportOnly);
  return upgradedDecision(prepared.upgradedTo);
}

async function inlineBodyHashes(
  body: string,
  algorithms: readonly SriAlgorithm[],
): Promise<string[]> {
  if (algorithms.length === 0) return [];
  const bytes = new TextEncoder().encode(body);
  const digests = await Promise.all(algorithms.map((algorithm) => digestBase64(bytes, algorithm)));
  return digests.filter((digest): digest is string => digest !== null);
}

export interface ScriptResponseFacts {
  contentType?: string | null;
  contentTypeOptions?: string | null;
  bytes?: Uint8Array | null;
  opaque?: boolean;
}

/** Checks response MIME, nosniff, and SRI after fetch.
 * Opaque or unavailable bytes block execution when integrity metadata is present.
 * Successful module checks include the selected `moduleType`.
 */
export async function checkScriptResponse(
  request: ScriptGateRequest,
  response: ScriptResponseFacts,
): Promise<ScriptGateDecision> {
  const url = request.url ?? "";
  const moduleType = responseModuleType(request, response);
  const mimeFailure = responseMimeFailure(url, request, response, moduleType);
  if (mimeFailure !== null) return mimeFailure;
  const allowed: ScriptGateDecision =
    request.module === true ? { allowed: true, moduleType } : ALLOWED;
  return checkIntegrity(request, response, url, allowed);
}

function responseModuleType(request: ScriptGateRequest, response: ScriptResponseFacts): ModuleType {
  return request.module === true && isModuleMime("json", response.contentType)
    ? "json"
    : "javascript";
}

function responseMimeFailure(
  url: string,
  request: ScriptGateRequest,
  response: ScriptResponseFacts,
  moduleType: ModuleType,
): ScriptGateDecision | null {
  if (isNosniffJavascriptFailure(moduleType, response)) {
    const essence = mimeEssence(response.contentType);
    return {
      allowed: false,
      reason: "nosniff",
      message:
        `Refused to execute script from '${url}' because its MIME type ` +
        `('${essence}') is not executable, and strict MIME type checking ` +
        `is enabled.`,
    };
  }
  if (isModuleMimeFailure(request, response, moduleType)) {
    return {
      allowed: false,
      reason: "mime",
      message:
        `Failed to load module script: expected a JavaScript-or-wasm ` +
        `module script but the server responded with a MIME type of ` +
        `"${mimeEssence(response.contentType)}" for '${url}'.`,
    };
  }
  return null;
}

function isNosniffJavascriptFailure(
  moduleType: ModuleType,
  response: ScriptResponseFacts,
): boolean {
  return (
    moduleType === "javascript" &&
    blockedByNosniff(response.contentType, response.contentTypeOptions)
  );
}

function isModuleMimeFailure(
  request: ScriptGateRequest,
  response: ScriptResponseFacts,
  moduleType: ModuleType,
): boolean {
  return request.module === true && !isModuleMime(moduleType, response.contentType);
}

type IntegrityInput = { failure: ScriptGateDecision } | { bytes: Uint8Array };

function integrityInput(url: string, response: ScriptResponseFacts): IntegrityInput {
  if (response.opaque === true) {
    return {
      failure: {
        allowed: false,
        reason: "sri-opaque",
        message:
          `Failed to find a valid digest in the 'integrity' attribute for ` +
          `resource '${url}' with computed SHA-256 integrity '<opaque>'. ` +
          `The resource has been blocked: an integrity check requires a ` +
          `CORS-enabled fetch, so the element needs a 'crossorigin' attribute.`,
      },
    };
  }
  const bytes = response.bytes;
  if (!bytes) {
    return {
      failure: {
        allowed: false,
        reason: "sri-no-bytes",
        message:
          `Refused to execute script from '${url}': its 'integrity' ` +
          `attribute could not be checked because the response body was ` +
          `not available for hashing.`,
      },
    };
  }
  return { bytes };
}

function sriMismatchDecision(url: string, actual: string | null): ScriptGateDecision {
  return {
    allowed: false,
    reason: "sri-mismatch",
    message:
      `Failed to find a valid digest in the 'integrity' attribute for ` +
      `resource '${url}' with computed integrity '${actual ?? "<unavailable>"}'. ` +
      `The resource has been blocked.`,
  };
}

async function checkIntegrity(
  request: ScriptGateRequest,
  response: ScriptResponseFacts,
  url: string,
  allowed: ScriptGateDecision,
): Promise<ScriptGateDecision> {
  const metadata = parseIntegrity(request.integrity);
  const strongest = metadata[0];
  if (!strongest) return allowed;
  const input = integrityInput(url, response);
  if ("failure" in input) return input.failure;
  const bytes = input.bytes;
  if (await integrityMatches(bytes, metadata)) return allowed;
  const actual = await digestBase64(bytes, strongest.algorithm);
  return sriMismatchDecision(url, actual);
}
