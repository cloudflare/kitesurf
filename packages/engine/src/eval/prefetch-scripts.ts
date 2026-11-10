// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Fetches external classic scripts before navigation and checks their script policy.

import {
  checkScriptRedirect,
  checkScriptResponse,
  scriptGateIsNoop,
  type ScriptGateContext,
} from "@kitesurf/script-gate";
import {
  KITESURF_CORS_VERDICT_HEADER,
  KITESURF_NOSNIFF_HEADER,
  responseIsOpaque,
} from "@kitesurf/script-gate/gateway-headers";
import type { ParentScriptDescriptor } from "../wasm.ts";
import type { SandboxOutboundOverride } from "./outbound.ts";
import { localTraceParentProps } from "../tracing-local.ts";
import { scriptCredentialsMode } from "./cors.ts";
import { walkRedirects } from "./redirect-walk.ts";
import { MAX_DOCUMENT_BYTES, readCapped, readCappedText } from "../read-capped.ts";

const PREFETCH_TIMEOUT_MS = 10_000;

const MAX_BLOCKED_MESSAGE_BYTES = 4 * 1024;

function resolveScriptUrl(src: string, baseUrl: string): string | null {
  if (!src) return null;
  try {
    if (baseUrl) {
      return new URL(src, baseUrl).toString();
    }
    return new URL(src).toString();
  } catch {
    return null;
  }
}

function defaultPortForProtocol(protocol: string): string {
  switch (protocol) {
    case "http:":
      return "80";
    case "https:":
      return "443";
    case "ws:":
      return "80";
    case "wss:":
      return "443";
    case "ftp:":
      return "21";
    default:
      return "";
  }
}

function originKey(u: URL): string {
  let host = u.hostname.toLowerCase();
  if (host.endsWith(".") && host.length > 1) host = host.slice(0, -1);
  const port = u.port || defaultPortForProtocol(u.protocol);
  return `${u.protocol}//${host}:${port}`;
}

function classifyOrigin(target: URL, pageUrl: string): "synthetic" | "same" | "cross" | "invalid" {
  if (!pageUrl) return "invalid";
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return "invalid";
  }
  if (page.hostname === "kitesurf.local") return "synthetic";
  return originKey(target) === originKey(page) ? "same" : "cross";
}

function pageOriginFromUrl(pageUrl: string): string {
  try {
    const u = new URL(pageUrl);
    return u.protocol + "//" + u.host;
  } catch {
    return "";
  }
}

interface PrefetchExternalScriptsOptions {
  descriptors: ParentScriptDescriptor[];
  pageUrl: string;
  connectionId: string;
  mainFrameId?: string;
  mainLoaderId?: string;
  extraHeaders?: Record<string, string>;
  cookieKey?: string;
  baseUrl: string;
  sandboxOutbound: SandboxOutboundOverride;
  signal?: AbortSignal;
  // The document's script gate. Each descriptor's own url was checked before; it also applies to
  // every redirect target.
  gate?: ScriptGateContext | null;
  // A parser-inserted classic reports initiator type "parser"; a speculative insert reports
  // "script". The engine's outbound maps only "parser" to the parser initiator.
  initiator?: "parser" | "script";
}

/** Prefetches classic scripts; per-script failures are stored on each descriptor. */
export async function prefetchExternalScripts({
  descriptors,
  pageUrl,
  connectionId,
  mainFrameId = "",
  mainLoaderId = "",
  extraHeaders = {},
  cookieKey = "",
  baseUrl,
  sandboxOutbound,
  signal,
  gate = null,
  initiator = "script",
}: PrefetchExternalScriptsOptions): Promise<ParentScriptDescriptor[]> {
  const resolveBase = baseUrl || pageUrl;

  const out = descriptors.map((d) => ({ ...d }));
  const fetches: Promise<void>[] = [];
  const pageOrigin = pageOriginFromUrl(pageUrl);
  const outbound = sandboxOutbound.parent({
    ...localTraceParentProps(),
    pageOrigin,
    mainFrameId,
    mainLoaderId,
    extraHeaders,
    connectionId,
    cookieKey,
  });

  for (const d of out) {
    if (!d.src) continue;
    if (d.blocked) continue;
    if (d.kind === "module") continue;
    const resolved = d.resolvedSrc ?? resolveScriptUrl(d.src, resolveBase);
    if (!resolved) {
      d.prefetchError = "could not resolve src against page URL";
      continue;
    }
    d.resolvedSrc = resolved;
    let target: URL;
    try {
      target = new URL(resolved);
    } catch {
      d.prefetchError = "invalid resolved URL: " + resolved;
      continue;
    }
    const originClass = classifyOrigin(target, pageUrl);
    if (originClass === "invalid") {
      d.prefetchError = "could not parse page origin: " + pageUrl;
      continue;
    }
    fetches.push(
      (async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), PREFETCH_TIMEOUT_MS);
        const onAbort = () => ctrl.abort();
        signal?.addEventListener("abort", onAbort);
        if (signal?.aborted) ctrl.abort();
        try {
          const scriptCorsMode = d.crossOrigin == null ? "no-cors" : "cors";
          const headers: Record<string, string> = {
            "x-kitesurf-resource-type": "Script",
            "x-kitesurf-initiator": initiator,
            "x-kitesurf-page-origin": pageOrigin,
            "x-kitesurf-allow-cross-origin": "1",
            "x-kitesurf-script-cors": scriptCorsMode,
            // A crossorigin classic script fetches with credentials mode "same-origin" unless it
            // asks for use-credentials; a plain no-CORS script keeps the browser's include.
            ...(d.crossOrigin == null
              ? {}
              : { "x-kitesurf-credentials": scriptCredentialsMode(d.crossOrigin) }),
          };
          if (connectionId) {
            headers["x-kitesurf-connection-id"] = connectionId;
          }
          if (mainFrameId) headers["x-kitesurf-frame-id"] = mainFrameId;
          if (originClass === "cross" && pageOrigin) {
            headers["origin"] = pageOrigin;
          }
          let redirectBlocked: ParentScriptDescriptor["blocked"];
          const checkRedirect =
            gate && d.injected !== true && !scriptGateIsNoop(gate)
              ? async (hopUrl: string): Promise<string | null> => {
                  const hop = checkScriptRedirect(
                    gate,
                    { url: resolved, nonce: d.nonce ?? null },
                    hopUrl,
                  );
                  if (!hop.allowed) {
                    redirectBlocked = {
                      reason: hop.reason ?? "csp",
                      message: hop.message ?? "blocked by policy",
                    };
                    return null;
                  }
                  return hop.upgradeTo ?? hopUrl;
                }
              : undefined;
          const walk = await walkRedirects({
            url: resolved,
            signal: ctrl.signal,
            headers,
            taintOriginFrom: pageOrigin || undefined,
            fetchHop: (hopReq) => outbound.fetch(hopReq),
            checkRedirect,
          });
          if (!walk.ok && walk.reason === "redirect-blocked") {
            d.blocked = redirectBlocked ?? { reason: "csp", message: "blocked by policy" };
            console.warn(
              `[kitesurf-csp] blocked (${d.blocked.reason}) ${walk.url}: ` + d.blocked.message,
            );
            return;
          }
          if (!walk.ok) {
            d.prefetchError = "<script src> too many redirects for " + resolved;
            return;
          }
          const res = walk.response;
          const blockedReason = res.headers.get("x-kitesurf-blocked");
          if (res.status === 403 && blockedReason) {
            const text = await readCappedText(res, MAX_BLOCKED_MESSAGE_BYTES, connectionId);
            d.prefetchError = text.ok ? text.text : "<script src> blocked for " + resolved;
            return;
          }
          if (!res.ok) {
            await res.body?.cancel().catch(() => {});
            d.prefetchError = "<script src> fetch returned HTTP " + res.status + " for " + resolved;
            return;
          }
          // Capped per body, not charged to the shared read budget: a budget refusal would
          // drop a script the page needs. Concurrent reads are bounded only per body.
          const capped = await readCapped(res.body, MAX_DOCUMENT_BYTES);
          if (capped.bytes === null) {
            await capped.rest.cancel().catch(() => {});
            d.prefetchError = "<script src> body " + capped.failure + " for " + resolved;
            return;
          }
          const bytes = capped.bytes;
          const opaque = responseIsOpaque(res.headers.get(KITESURF_CORS_VERDICT_HEADER));
          const verdict = await checkScriptResponse(
            {
              url: resolved,
              integrity: d.integrity ?? null,
              nonce: d.nonce ?? null,
            },
            {
              contentType: res.headers.get("content-type"),
              contentTypeOptions: res.headers.get(KITESURF_NOSNIFF_HEADER),
              bytes,
              opaque,
            },
          );
          if (!verdict.allowed) {
            d.blocked = {
              reason: verdict.reason ?? "blocked",
              message: verdict.message ?? "blocked by policy",
            };
            console.warn(
              `[kitesurf-csp] blocked (${d.blocked.reason}) ${resolved}: ` + d.blocked.message,
            );
            return;
          }
          d.prefetchedSource = new TextDecoder("utf-8", {
            fatal: false,
            ignoreBOM: false,
          }).decode(bytes);
        } catch (err) {
          d.prefetchError = err instanceof Error ? err.message : String(err);
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        }
      })(),
    );
  }

  await Promise.all(fetches);
  return out;
}
