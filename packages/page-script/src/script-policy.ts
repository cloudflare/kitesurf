// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Runtime inserts use the shared gate before fetch and after response metadata arrives.

import {
  buildScriptGateContext,
  checkScriptBeforeFetch,
  checkScriptResponse,
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

function cachedContextFor(documentUrl: string): ScriptGateContext | null {
  if (cached && cachedUrl === documentUrl) return cached;
  return null;
}

function gateContext(): ScriptGateContext {
  const documentUrl = state.pageUrl || "";
  const existing = cachedContextFor(documentUrl);
  if (existing) return existing;
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

function hasInlineHashPolicies(ctx: ScriptGateContext): boolean {
  return (
    inlineHashAlgorithms(ctx.policies).length > 0 ||
    inlineHashAlgorithms(ctx.reportOnlyPolicies).length > 0
  );
}

function inlineDecision(ctx: ScriptGateContext, meta: InsertedScriptMetadata): ScriptGateDecision {
  const verdict = cspAllowsScript(ctx.policies, {
    url: null,
    documentUrl: ctx.documentUrl,
    nonce: meta.nonce ?? null,
    runtimeInserted: true,
  });
  if (!verdict.allowed) {
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
  const reportOnlyVerdict = cspAllowsScript(ctx.reportOnlyPolicies, {
    url: null,
    documentUrl: ctx.documentUrl,
    nonce: meta.nonce ?? null,
    runtimeInserted: true,
  });
  if (reportOnlyVerdict.allowed) return { allowed: true };
  return {
    allowed: true,
    reportOnly:
      `[Report Only] Refused to execute inline script because it ` +
      `violates the following Content Security Policy directive: ` +
      `"${reportOnlyVerdict.directive}".`,
  };
}

export function inlineInsertDecisionSync(meta: InsertedScriptMetadata): ScriptGateDecision | null {
  const ctx = gateContext();
  if (scriptGateIsNoop(ctx)) return { allowed: true };
  // Hash policies need async WebCrypto; null sends the caller to the deferred gate.
  if (hasInlineHashPolicies(ctx)) return null;
  return inlineDecision(ctx, meta);
}

export async function insertedResponseAllowed(
  meta: InsertedScriptMetadata,
  response: {
    contentType: string | null;
    contentTypeOptions: string | null;
    bytes: Uint8Array | null;
    opaque: boolean;
  },
): Promise<ScriptGateDecision> {
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
