// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Runtime inserts use the shared gate before fetch and after response metadata arrives.

import {
  buildScriptGateContext,
  checkScriptBeforeFetch,
  checkScriptRedirect,
  checkScriptResponse,
  cspAllowsInlineHandler,
  cspAllowsScript,
  scriptGateIsNoop,
  inlineHashAlgorithms,
  type ScriptGateContext,
  type ScriptGateDecision,
} from "@kitesurf/script-gate";
import type { NavigateOptions } from "@kitesurf/jsrpc-types/page-script";
import { startupCsp, startupMetaCsp } from "./startup-probe.ts";
import { state } from "./state.ts";

let cached: ScriptGateContext | null = null;
let cachedUrl = "";
// The navigating document's terminal policy, when the engine supplies one. Frame isolates and
// failed bakes have no startup policy, so the legacy plan would otherwise gate on nothing.
let navigationPolicy: NavigateOptions["scriptPolicy"] | undefined;

export function setNavigationScriptPolicy(policy: NavigateOptions["scriptPolicy"]): void {
  navigationPolicy = policy;
  cached = null;
  cachedUrl = "";
}

function gateContext(): ScriptGateContext {
  const documentUrl = state.documentUrl || state.pageUrl || "";
  if (cached && cachedUrl === documentUrl) return cached;
  cachedUrl = documentUrl;
  cached = buildScriptGateContext(
    documentUrl,
    navigationPolicy ?? {
      cspHeaders: Array.isArray(startupCsp) ? startupCsp : [],
      metaCsp: Array.isArray(startupMetaCsp) ? startupMetaCsp : [],
    },
  );
  return cached;
}

export interface InsertedScriptMetadata {
  url: string | null;
  integrity?: string | null;
  nonce?: string | null;
  body?: string;
  module?: boolean;
}

async function scriptAllowed(
  meta: InsertedScriptMetadata,
  runtimeInserted: boolean,
): Promise<ScriptGateDecision> {
  const ctx = gateContext();
  if (scriptGateIsNoop(ctx)) return { allowed: true };
  return checkScriptBeforeFetch(ctx, {
    url: meta.url,
    integrity: meta.integrity ?? null,
    nonce: meta.nonce ?? null,
    runtimeInserted,
    ...(meta.body === undefined ? {} : { body: meta.body }),
  });
}

export function insertedScriptAllowed(meta: InsertedScriptMetadata): Promise<ScriptGateDecision> {
  return scriptAllowed(meta, true);
}

/** A parser-inserted script: 'strict-dynamic' does not admit it the way an insert does. */
export function parserScriptAllowed(meta: InsertedScriptMetadata): Promise<ScriptGateDecision> {
  return scriptAllowed(meta, false);
}

export function inlineInsertDecisionSync(meta: InsertedScriptMetadata): ScriptGateDecision | null {
  const ctx = gateContext();
  if (scriptGateIsNoop(ctx)) return { allowed: true };
  // Hash policies need async WebCrypto; null sends the caller to the deferred gate.
  if (inlineHashAlgorithms(ctx.policies).length > 0) return null;
  if (inlineHashAlgorithms(ctx.reportOnlyPolicies).length > 0) return null;
  const verdict = cspAllowsScript(ctx.policies, {
    url: null,
    documentUrl: ctx.documentUrl,
    nonce: meta.nonce ?? null,
    runtimeInserted: true,
  });
  if (verdict.allowed) {
    const ro = cspAllowsScript(ctx.reportOnlyPolicies, {
      url: null,
      documentUrl: ctx.documentUrl,
      nonce: meta.nonce ?? null,
      runtimeInserted: true,
    });
    return ro.allowed
      ? { allowed: true }
      : {
          allowed: true,
          reportOnly:
            `[Report Only] Refused to execute inline script because it ` +
            `violates the following Content Security Policy directive: ` +
            `"${ro.directive}".`,
        };
  }
  return {
    allowed: false,
    reason: "csp",
    message:
      `Refused to execute inline script because it violates the ` +
      `following Content Security Policy directive: ` +
      `"${verdict.directive}". Either the 'unsafe-inline' keyword, a ` +
      `hash, or a nonce is required to enable inline execution.`,
  };
}

/** workerd reports a response URL without its fragment, and an upgrade-insecure-requests
 *  fetch goes to the upgraded URL, so a redirect is only one when the targets differ. */
export interface InsertedRedirectGate {
  /** Passed to the fetch; undefined when no policy applies. */
  check: ((hopUrl: string) => string | null) | undefined;
  /** The refusal of the hop that `check` stopped, if any. */
  refusal: ScriptGateDecision | null;
}

/** Rechecks each redirect hop of an inserted script before it is requested, as the parser
 *  path does. HTTP-redirect fetch reruns main fetch for the new URL, and main fetch asks CSP
 *  whether the request should be blocked: https://fetch.spec.whatwg.org/#http-redirect-fetch
 *  and https://w3c.github.io/webappsec-csp/#should-block-request */
function redirectGate(
  meta: InsertedScriptMetadata,
  runtimeInserted: boolean,
): InsertedRedirectGate {
  const ctx = gateContext();
  const gate: InsertedRedirectGate = { check: undefined, refusal: null };
  if (!meta.url || scriptGateIsNoop(ctx)) return gate;
  // The insert was allowed before the fetch, so the redirect check must see it as
  // runtime-inserted: under 'strict-dynamic' that is the only thing that admits it.
  const request = {
    url: meta.url,
    integrity: meta.integrity ?? null,
    nonce: meta.nonce ?? null,
    runtimeInserted,
    module: meta.module === true,
  };
  gate.check = (hopUrl) => {
    const hop = checkScriptRedirect(ctx, request, hopUrl);
    if (hop.allowed) return hop.upgradeTo ?? hopUrl;
    gate.refusal = hop;
    return null;
  };
  return gate;
}

export function insertedRedirectGate(meta: InsertedScriptMetadata): InsertedRedirectGate {
  return redirectGate(meta, true);
}

export function parserRedirectGate(meta: InsertedScriptMetadata): InsertedRedirectGate {
  return redirectGate(meta, false);
}

function stripFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

async function responseAllowed(
  meta: InsertedScriptMetadata,
  response: {
    contentType: string | null;
    contentTypeOptions: string | null;
    bytes: Uint8Array | null;
    opaque: boolean;
    finalUrl?: string;
  },
  fetchedUrl: string | undefined,
  runtimeInserted: boolean,
): Promise<ScriptGateDecision> {
  const ctx = gateContext();
  // The redirect gate checked each hop; this covers a redirect the fetch shim hands to
  // the native fetch (a Location it cannot parse), where only the final URL is known.
  const fetched = fetchedUrl ?? meta.url;
  if (
    fetched &&
    response.finalUrl &&
    !scriptGateIsNoop(ctx) &&
    stripFragment(response.finalUrl) !== stripFragment(fetched)
  ) {
    const redirect = checkScriptRedirect(
      ctx,
      {
        url: meta.url,
        integrity: meta.integrity ?? null,
        nonce: meta.nonce ?? null,
        runtimeInserted,
        module: meta.module === true,
      },
      response.finalUrl,
    );
    if (!redirect.allowed) return redirect;
  }
  return checkScriptResponse(
    {
      url: meta.url,
      integrity: meta.integrity ?? null,
      nonce: meta.nonce ?? null,
      module: meta.module === true,
    },
    response,
  );
}

export function insertedResponseAllowed(
  meta: InsertedScriptMetadata,
  response: {
    contentType: string | null;
    contentTypeOptions: string | null;
    bytes: Uint8Array | null;
    opaque: boolean;
    finalUrl?: string;
  },
  fetchedUrl?: string,
): Promise<ScriptGateDecision> {
  return responseAllowed(meta, response, fetchedUrl, true);
}

export function parserResponseAllowed(
  meta: InsertedScriptMetadata,
  response: {
    contentType: string | null;
    contentTypeOptions: string | null;
    bytes: Uint8Array | null;
    opaque: boolean;
    finalUrl?: string;
  },
  fetchedUrl?: string,
): Promise<ScriptGateDecision> {
  return responseAllowed(meta, response, fetchedUrl, false);
}

/** Whether the document's CSP lets an inline on* attribute compile; logs a refusal. */
export function inlineHandlerAllowed(attributeName: string): boolean {
  const ctx = gateContext();
  if (ctx.policies.length === 0) return true;
  const verdict = cspAllowsInlineHandler(ctx.policies);
  if (verdict.allowed) return true;
  try {
    console.error(
      `Refused to execute inline event handler ${attributeName} because it violates the ` +
        `following Content Security Policy directive: "${verdict.directive}". Either the ` +
        `'unsafe-inline' keyword, or a hash with 'unsafe-hashes', is required.`,
    );
  } catch {}
  return false;
}

export function reportBlocked(decision: ScriptGateDecision): void {
  try {
    console.error(decision.message ?? "Script blocked by policy.");
  } catch {}
}

export function reportOnly(decision: ScriptGateDecision): void {
  if (!decision.reportOnly) return;
  try {
    console.warn(decision.reportOnly);
  } catch {}
}

// Module URLs whose gated fetch failed or was blocked. A rejected import whose graph hit one
// names it in its reason (gated_module_source in core's boa_eval.rs: "module refused for <url>");
// a module that threw while evaluating names none, whatever its message says. So the lifecycle
// event follows this set, never the text alone.
const failedModuleUrls = new Set<string>();
const MODULE_REFUSED_PREFIX = "module refused for ";

export function markModuleFetchFailed(url: string): void {
  failedModuleUrls.add(url);
}

export function importHitFailedFetch(reason: string): boolean {
  if (!reason.includes(MODULE_REFUSED_PREFIX)) return false;
  for (const failed of failedModuleUrls) {
    if (reason.includes(MODULE_REFUSED_PREFIX + failed)) return true;
  }
  return false;
}
