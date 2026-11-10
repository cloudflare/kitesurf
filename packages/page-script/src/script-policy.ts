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
import { startupCsp, startupMetaCsp } from "./startup-probe.ts";
import { state } from "./state.ts";

let cached: ScriptGateContext | null = null;
let cachedUrl = "";

function gateContext(): ScriptGateContext {
  const documentUrl = state.documentUrl || state.pageUrl || "";
  if (cached && cachedUrl === documentUrl) return cached;
  cachedUrl = documentUrl;
  cached = buildScriptGateContext(documentUrl, {
    cspHeaders: Array.isArray(startupCsp) ? startupCsp : [],
    metaCsp: Array.isArray(startupMetaCsp) ? startupMetaCsp : [],
  });
  return cached;
}

export interface InsertedScriptMetadata {
  url: string | null;
  integrity?: string | null;
  nonce?: string | null;
  body?: string;
  module?: boolean;
}

export async function insertedScriptAllowed(
  meta: InsertedScriptMetadata,
): Promise<ScriptGateDecision> {
  const ctx = gateContext();
  if (scriptGateIsNoop(ctx)) return { allowed: true };
  return checkScriptBeforeFetch(ctx, {
    url: meta.url,
    integrity: meta.integrity ?? null,
    nonce: meta.nonce ?? null,
    runtimeInserted: true,
    ...(meta.body === undefined ? {} : { body: meta.body }),
  });
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
export function insertedRedirectGate(meta: InsertedScriptMetadata): InsertedRedirectGate {
  const ctx = gateContext();
  const gate: InsertedRedirectGate = { check: undefined, refusal: null };
  if (!meta.url || scriptGateIsNoop(ctx)) return gate;
  // The insert was allowed before the fetch, so the redirect check must see it as
  // runtime-inserted: under 'strict-dynamic' that is the only thing that admits it.
  const request = {
    url: meta.url,
    integrity: meta.integrity ?? null,
    nonce: meta.nonce ?? null,
    runtimeInserted: true,
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

function stripFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

export async function insertedResponseAllowed(
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
  const ctx = gateContext();
  // insertedRedirectGate checked each hop; this covers a redirect the fetch shim hands to
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
        runtimeInserted: true,
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
