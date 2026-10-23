// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Builds document script policy and gates import maps and scripts before fetch.

import {
  buildScriptGateContext,
  checkScriptBeforeFetch,
  scriptGateIsNoop,
  type ScriptGateContext,
} from "@kitesurf/script-gate";
import type { DocScan, ParentScriptDescriptor } from "../wasm.ts";

export type { ScriptGateContext };

export interface DocumentPolicySources {
  csp?: string | null;
  cspReportOnly?: string | null;
  scan?: DocScan | null;
}

export function documentGateContext(
  documentUrl: string,
  sources: DocumentPolicySources,
): ScriptGateContext {
  return buildScriptGateContext(documentUrl, {
    cspHeaders: [sources.csp],
    cspReportOnlyHeaders: [sources.cspReportOnly],
    metaCsp: sources.scan?.metaCsp ?? [],
  });
}

export function documentBaseUrl(pageUrl: string, baseHref: string | null | undefined): string {
  if (!baseHref) return pageUrl;
  try {
    return new URL(baseHref, pageUrl || undefined).toString();
  } catch {
    return pageUrl;
  }
}

export function resolveScriptUrl(src: string, baseUrl: string): string | null {
  if (!src) return null;
  try {
    return baseUrl ? new URL(src, baseUrl).toString() : new URL(src).toString();
  } catch {
    return null;
  }
}

export interface GatedImportMap {
  source: string;
  baseUrl: string;
  scriptDomIndex: number;
}

function warnBlockedImportMap(reason: string | undefined, message: string | undefined): void {
  console.warn(
    `[kitesurf-csp] blocked (${reason ?? "csp"}) import map: ` + (message ?? "blocked by policy"),
  );
}

async function gateImportMap(
  map: DocScan["importMaps"][number],
  gate: ScriptGateContext,
  pageUrl: string,
): Promise<GatedImportMap | null> {
  if (!scriptGateIsNoop(gate)) {
    const decision = await checkScriptBeforeFetch(gate, {
      url: null,
      nonce: map.nonce,
      body: map.body,
      runtimeInserted: false,
      module: false,
    });
    if (decision.reportOnly) {
      console.warn(`[kitesurf-csp] ${decision.reportOnly}`);
    }
    if (!decision.allowed) {
      warnBlockedImportMap(decision.reason, decision.message);
      return null;
    }
  }
  return {
    source: map.body,
    baseUrl: documentBaseUrl(pageUrl, map.baseHref),
    scriptDomIndex: map.scriptDomIndex,
  };
}

export async function applyImportMapGate(
  importMaps: readonly DocScan["importMaps"][number][],
  gate: ScriptGateContext,
  pageUrl: string,
): Promise<GatedImportMap[]> {
  const out: GatedImportMap[] = [];
  for (const map of importMaps) {
    const gated = await gateImportMap(map, gate, pageUrl);
    if (gated !== null) out.push(gated);
  }
  return out;
}

function scriptUrlForGate(
  descriptor: ParentScriptDescriptor,
  baseUrl: string,
): { kind: "skip" } | { kind: "check"; url: string | null } {
  if (!descriptor.src) return { kind: "check", url: null };
  const url = resolveScriptUrl(descriptor.src, baseUrl);
  if (url === null) return { kind: "skip" };
  return { kind: "check", url };
}

function scriptGateInput(
  descriptor: ParentScriptDescriptor,
  url: string | null,
): Parameters<typeof checkScriptBeforeFetch>[1] {
  return {
    url,
    integrity: descriptor.integrity ?? null,
    nonce: descriptor.nonce ?? null,
    body: descriptor.src ? "" : (descriptor.body ?? ""),
    runtimeInserted: false,
    module: descriptor.kind === "module",
  };
}

function warnReportOnly(reportOnly: string | undefined): void {
  console.warn(`[kitesurf-csp] ${reportOnly}`);
}

function applyScriptGateDecision(
  descriptor: ParentScriptDescriptor,
  decision: Awaited<ReturnType<typeof checkScriptBeforeFetch>>,
): void {
  if (!decision.allowed) {
    descriptor.blocked = {
      reason: decision.reason ?? "csp",
      message: decision.message ?? "blocked by policy",
    };
    return;
  }
  if (decision.upgradeTo) descriptor.resolvedSrc = decision.upgradeTo;
}

async function gateScriptDescriptor(
  descriptor: ParentScriptDescriptor,
  gate: ScriptGateContext,
  baseUrl: string,
): Promise<void> {
  if (descriptor.injected === true) return;
  const url = scriptUrlForGate(descriptor, baseUrl);
  if (url.kind === "skip") return;
  const decision = await checkScriptBeforeFetch(gate, scriptGateInput(descriptor, url.url));
  if (decision.reportOnly) warnReportOnly(decision.reportOnly);
  applyScriptGateDecision(descriptor, decision);
}

export async function applyPreFetchScriptGate(
  descriptors: readonly ParentScriptDescriptor[],
  gate: ScriptGateContext,
  baseUrl: string,
): Promise<ParentScriptDescriptor[]> {
  const out = descriptors.map((d) => ({ ...d }));
  if (scriptGateIsNoop(gate)) return out;

  await Promise.all(out.map((descriptor) => gateScriptDescriptor(descriptor, gate, baseUrl)));
  return out;
}
