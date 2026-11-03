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

export async function applyImportMapGate(
  importMaps: readonly DocScan["importMaps"][number][],
  gate: ScriptGateContext,
  pageUrl: string,
): Promise<GatedImportMap[]> {
  const out: GatedImportMap[] = [];
  for (const map of importMaps) {
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
        console.warn(
          `[kitesurf-csp] blocked (${decision.reason ?? "csp"}) import map: ` +
            (decision.message ?? "blocked by policy"),
        );
        continue;
      }
    }
    out.push({
      source: map.body,
      baseUrl: documentBaseUrl(pageUrl, map.baseHref),
      scriptDomIndex: map.scriptDomIndex,
    });
  }
  return out;
}

// A learned script passes the gate again, with its element's nonce, when the page inserts it.
// Its prefetch has no nonce to show, so one is taken as given; hosts and 'none' still bind it.
export function learnedScriptGate(gate: ScriptGateContext): ScriptGateContext {
  return { ...gate, aheadOfInsertion: true };
}

export async function applyPreFetchScriptGate(
  descriptors: readonly ParentScriptDescriptor[],
  gate: ScriptGateContext,
  baseUrl: string,
): Promise<ParentScriptDescriptor[]> {
  const out = descriptors.map((d) => ({ ...d }));
  if (scriptGateIsNoop(gate)) return out;

  await Promise.all(
    out.map(async (d) => {
      if (d.injected === true) return;
      const url = d.src ? resolveScriptUrl(d.src, baseUrl) : null;
      if (d.src && url === null) return;
      const decision = await checkScriptBeforeFetch(gate, {
        url,
        integrity: d.integrity ?? null,
        nonce: d.nonce ?? null,
        body: d.src ? "" : (d.body ?? ""),
        runtimeInserted: false,
        module: d.kind === "module",
      });
      if (decision.reportOnly) {
        console.warn(`[kitesurf-csp] ${decision.reportOnly}`);
      }
      if (!decision.allowed) {
        d.blocked = {
          reason: decision.reason ?? "csp",
          message: decision.message ?? "blocked by policy",
        };
        return;
      }
      if (decision.upgradeTo) d.resolvedSrc = decision.upgradeTo;
    }),
  );
  return out;
}
