// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Applies shared CSP, mixed-content, MIME, and SRI rules. The engine prefetchers, module walker,
// inserted scripts and boa's module fallback all call it, so a refusal cannot be refetched.

import { cspAllowsScript, inlineHashAlgorithms, parseCspPolicies, type CspPolicy } from "./csp.ts";
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
  if (url.protocol === "https:" || url.protocol === "wss:") return true;
  if (url.protocol === "file:" || url.protocol === "data:") return true;
  if (url.protocol === "blob:") {
    const origin = parseOrNull(url.origin);
    return origin !== null && isPotentiallyTrustworthy(origin);
  }
  const host = url.hostname.toLowerCase();
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

/** Checks CSP and mixed content before fetching a script; a null URL means inline code.
 * Report-only violations return `allowed: true` with a `reportOnly` message.
 */
export async function checkScriptBeforeFetch(
  ctx: ScriptGateContext,
  request: ScriptGateRequest,
): Promise<ScriptGateDecision> {
  let url = request.url;
  let upgradedTo: string | null = null;

  if (url !== null) {
    const documentUrl = parseOrNull(ctx.documentUrl);
    const target = parseOrNull(url);
    if (
      documentUrl &&
      target &&
      documentUrl.protocol === "https:" &&
      !isPotentiallyTrustworthy(target)
    ) {
      if (ctx.upgradeInsecureRequests && target.protocol === "http:") {
        target.protocol = "https:";
        url = target.toString();
        upgradedTo = url;
      } else {
        return {
          allowed: false,
          reason: "mixed-content",
          message:
            `Mixed Content: the page at ${ctx.documentUrl} was loaded over ` +
            `HTTPS, but requested an insecure script ${request.url}. ` +
            `This request has been blocked; the content must be served over HTTPS.`,
        };
      }
    }
  }

  if (ctx.policies.length === 0 && ctx.reportOnlyPolicies.length === 0) {
    return upgradedTo === null ? ALLOWED : { allowed: true, upgradeTo: upgradedTo };
  }

  const enforcedHashAlgorithms =
    url === null && request.body ? inlineHashAlgorithms(ctx.policies) : [];
  let inlineHashes: string[] = [];
  if (url === null && request.body) {
    inlineHashes = await inlineBodyHashes(request.body, enforcedHashAlgorithms);
  }

  const verdict = cspAllowsScript(
    ctx.policies,
    {
      url,
      documentUrl: ctx.documentUrl,
      nonce: request.nonce ?? null,
      runtimeInserted: request.runtimeInserted === true,
    },
    inlineHashes,
  );
  const scriptDescription = url === null ? "inline script" : `script from '${url}'`;
  if (!verdict.allowed) {
    return {
      allowed: false,
      reason: "csp",
      message:
        `Refused to execute ${scriptDescription} because it violates the following ` +
        `Content Security Policy directive: "${verdict.directive}". ` +
        (url === null
          ? "Either the 'unsafe-inline' keyword, a hash, or a nonce is required to enable inline execution."
          : ""),
    };
  }

  if (ctx.reportOnlyPolicies.length > 0) {
    let reportOnlyHashes = inlineHashes;
    if (url === null && request.body) {
      const reportOnlyAlgorithms = inlineHashAlgorithms(ctx.reportOnlyPolicies);
      const algorithmsToCompute =
        inlineHashes.length > 0
          ? reportOnlyAlgorithms.filter((algorithm) => !enforcedHashAlgorithms.includes(algorithm))
          : reportOnlyAlgorithms;
      const additionalHashes = await inlineBodyHashes(request.body, algorithmsToCompute);
      if (additionalHashes.length > 0) {
        reportOnlyHashes = [...inlineHashes, ...additionalHashes];
      }
    }
    const reportOnlyVerdict = cspAllowsScript(
      ctx.reportOnlyPolicies,
      {
        url,
        documentUrl: ctx.documentUrl,
        nonce: request.nonce ?? null,
        runtimeInserted: request.runtimeInserted === true,
      },
      reportOnlyHashes,
    );
    if (!reportOnlyVerdict.allowed) {
      return {
        allowed: true,
        reportOnly:
          `[Report Only] Refused to execute ${scriptDescription} because it violates ` +
          `the following Content Security Policy directive: ` +
          `"${reportOnlyVerdict.directive}".`,
        ...(upgradedTo === null ? {} : { upgradeTo: upgradedTo }),
      };
    }
  }

  return upgradedTo === null ? ALLOWED : { allowed: true, upgradeTo: upgradedTo };
}

/** Rechecks an external script's source list for a redirect target before it is fetched.
 *  Enforced policies only; report-only policies were already reported for the request. */
export function checkScriptRedirect(
  ctx: ScriptGateContext,
  request: ScriptGateRequest,
  redirectUrl: string,
): ScriptGateDecision {
  const documentUrl = parseOrNull(ctx.documentUrl);
  const target = parseOrNull(redirectUrl);
  if (documentUrl?.protocol === "https:" && target && !isPotentiallyTrustworthy(target)) {
    return {
      allowed: false,
      reason: "mixed-content",
      message:
        `Mixed Content: the page at ${ctx.documentUrl} was loaded over HTTPS, but a ` +
        `script redirected to the insecure ${redirectUrl}. This request has been blocked.`,
    };
  }
  const verdict = cspAllowsScript(ctx.policies, {
    url: redirectUrl,
    documentUrl: ctx.documentUrl,
    nonce: request.nonce ?? null,
    runtimeInserted: request.runtimeInserted === true,
    redirected: true,
  });
  if (verdict.allowed) return ALLOWED;
  return {
    allowed: false,
    reason: "csp",
    message:
      `Refused to load the script '${redirectUrl}' (a redirect of '${request.url ?? ""}') ` +
      `because it violates the following Content Security Policy directive: ` +
      `"${verdict.directive}".`,
  };
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
  const moduleType: ModuleType =
    request.module === true && isModuleMime("json", response.contentType) ? "json" : "javascript";

  if (
    moduleType === "javascript" &&
    blockedByNosniff(response.contentType, response.contentTypeOptions)
  ) {
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

  if (request.module === true && !isModuleMime(moduleType, response.contentType)) {
    return {
      allowed: false,
      reason: "mime",
      message:
        `Failed to load module script: expected a JavaScript-or-wasm ` +
        `module script but the server responded with a MIME type of ` +
        `"${mimeEssence(response.contentType)}" for '${url}'.`,
    };
  }

  const allowed: ScriptGateDecision =
    request.module === true ? { allowed: true, moduleType } : ALLOWED;

  const metadata = parseIntegrity(request.integrity);
  const strongest = metadata[0];
  if (!strongest) return allowed;

  if (response.opaque === true) {
    return {
      allowed: false,
      reason: "sri-opaque",
      message:
        `Failed to find a valid digest in the 'integrity' attribute for ` +
        `resource '${url}' with computed SHA-256 integrity '<opaque>'. ` +
        `The resource has been blocked: an integrity check requires a ` +
        `CORS-enabled fetch, so the element needs a 'crossorigin' attribute.`,
    };
  }

  const bytes = response.bytes;
  if (!bytes) {
    return {
      allowed: false,
      reason: "sri-no-bytes",
      message:
        `Refused to execute script from '${url}': its 'integrity' ` +
        `attribute could not be checked because the response body was ` +
        `not available for hashing.`,
    };
  }

  if (await integrityMatches(bytes, metadata)) return allowed;

  const actual = await digestBase64(bytes, strongest.algorithm);
  return {
    allowed: false,
    reason: "sri-mismatch",
    message:
      `Failed to find a valid digest in the 'integrity' attribute for ` +
      `resource '${url}' with computed integrity '${actual ?? "<unavailable>"}'. ` +
      `The resource has been blocked.`,
  };
}
