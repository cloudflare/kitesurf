// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Fetches external classic scripts before navigation and checks their script policy.

import { checkScriptResponse } from "@kitesurf/script-gate";
import {
  KITESURF_CORS_VERDICT_HEADER,
  KITESURF_NOSNIFF_HEADER,
  responseIsOpaque,
} from "@kitesurf/script-gate/gateway-headers";
import type { ParentScriptDescriptor } from "../wasm.ts";
import type { SandboxOutboundOverride } from "./outbound.ts";
import { localTraceParentProps } from "../tracing-local.ts";
import { walkRedirects } from "./redirect-walk.ts";

const PREFETCH_TIMEOUT_MS = 10_000;

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
  const page = parsePageUrl(pageUrl);
  if (page === null) return "invalid";
  if (page.hostname === "kitesurf.local") return "synthetic";
  return originKey(target) === originKey(page) ? "same" : "cross";
}

function parsePageUrl(pageUrl: string): URL | null {
  try {
    return new URL(pageUrl);
  } catch {
    return null;
  }
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
}

interface NormalizedPrefetchExternalScriptsOptions {
  descriptors: ParentScriptDescriptor[];
  pageUrl: string;
  connectionId: string;
  mainFrameId: string;
  mainLoaderId: string;
  extraHeaders: Record<string, string>;
  cookieKey: string;
  baseUrl: string;
  sandboxOutbound: SandboxOutboundOverride;
  signal?: AbortSignal;
}

function normalizePrefetchExternalScriptsOptions({
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
}: PrefetchExternalScriptsOptions): NormalizedPrefetchExternalScriptsOptions {
  return {
    descriptors,
    pageUrl,
    connectionId,
    mainFrameId,
    mainLoaderId,
    extraHeaders,
    cookieKey,
    baseUrl,
    sandboxOutbound,
    signal,
  };
}

interface ScriptTarget {
  originClass: "synthetic" | "same" | "cross";
  resolved: string;
}

function isScriptPrefetchCandidate(
  descriptor: ParentScriptDescriptor,
): descriptor is ParentScriptDescriptor & { src: string } {
  return Boolean(descriptor.src && !descriptor.blocked && descriptor.kind !== "module");
}

function prepareScriptTarget(
  descriptor: ParentScriptDescriptor & { src: string },
  resolveBase: string,
  pageUrl: string,
): ScriptTarget | null {
  const resolved = descriptor.resolvedSrc ?? resolveScriptUrl(descriptor.src, resolveBase);
  if (!resolved) {
    descriptor.prefetchError = "could not resolve src against page URL";
    return null;
  }
  descriptor.resolvedSrc = resolved;
  let target: URL;
  try {
    target = new URL(resolved);
  } catch {
    descriptor.prefetchError = "invalid resolved URL: " + resolved;
    return null;
  }
  const originClass = classifyOrigin(target, pageUrl);
  if (originClass === "invalid") {
    descriptor.prefetchError = "could not parse page origin: " + pageUrl;
    return null;
  }
  return { originClass, resolved };
}

interface ScriptFetchContext {
  pageOrigin: string;
  connectionId: string;
  mainFrameId: string;
  outbound: ReturnType<SandboxOutboundOverride["parent"]>;
  signal?: AbortSignal;
}

interface ActiveScriptFetch {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  onAbort: () => void;
}

function startScriptFetch(signal: AbortSignal | undefined): ActiveScriptFetch {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREFETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  if (signal?.aborted) controller.abort();
  return { controller, timer, onAbort };
}

function stopScriptFetch(signal: AbortSignal | undefined, active: ActiveScriptFetch): void {
  clearTimeout(active.timer);
  signal?.removeEventListener("abort", active.onAbort);
}

function scriptRequestHeaders(
  descriptor: ParentScriptDescriptor,
  originClass: ScriptTarget["originClass"],
  context: ScriptFetchContext,
): Record<string, string> {
  const headers: Record<string, string> = {
    "x-kitesurf-resource-type": "Script",
    "x-kitesurf-initiator": "parser-prefetch",
    "x-kitesurf-page-origin": context.pageOrigin,
    "x-kitesurf-allow-cross-origin": "1",
    "x-kitesurf-script-cors": scriptCorsMode(descriptor),
  };
  if (context.connectionId) headers["x-kitesurf-connection-id"] = context.connectionId;
  if (context.mainFrameId) headers["x-kitesurf-frame-id"] = context.mainFrameId;
  if (originClass === "cross" && context.pageOrigin) headers.origin = context.pageOrigin;
  return headers;
}

function scriptCorsMode(descriptor: ParentScriptDescriptor): "no-cors" | "cors" {
  return descriptor.crossOrigin == null ? "no-cors" : "cors";
}

function scriptPolicyInput(
  descriptor: ParentScriptDescriptor,
  resolved: string,
): { url: string; integrity: string | null; nonce: string | null } {
  return {
    url: resolved,
    integrity: descriptor.integrity ?? null,
    nonce: descriptor.nonce ?? null,
  };
}

function blockedScriptPolicy(verdict: Awaited<ReturnType<typeof checkScriptResponse>>): {
  reason: string;
  message: string;
} {
  return {
    reason: verdict.reason ?? "blocked",
    message: verdict.message ?? "blocked by policy",
  };
}

async function fetchScriptResponse(
  descriptor: ParentScriptDescriptor,
  resolved: string,
  originClass: ScriptTarget["originClass"],
  context: ScriptFetchContext,
  signal: AbortSignal,
): Promise<Response | null> {
  const walk = await walkRedirects({
    url: resolved,
    signal,
    headers: scriptRequestHeaders(descriptor, originClass, context),
    taintOriginFrom: context.pageOrigin || undefined,
    fetchHop: (request) => context.outbound.fetch(request),
  });
  if (!walk.ok) {
    descriptor.prefetchError = "<script src> too many redirects for " + resolved;
    return null;
  }
  return walk.response;
}

async function rejectScriptResponse(
  descriptor: ParentScriptDescriptor,
  response: Response,
  resolved: string,
): Promise<boolean> {
  const blockedReason = response.headers.get("x-kitesurf-blocked");
  if (response.status === 403 && blockedReason) {
    descriptor.prefetchError = await response.text();
    return true;
  }
  if (!response.ok) {
    descriptor.prefetchError =
      "<script src> fetch returned HTTP " + response.status + " for " + resolved;
    return true;
  }
  return false;
}

async function checkAndStoreScriptResponse(
  descriptor: ParentScriptDescriptor,
  response: Response,
  resolved: string,
): Promise<void> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const opaque = responseIsOpaque(response.headers.get(KITESURF_CORS_VERDICT_HEADER));
  const verdict = await checkScriptResponse(scriptPolicyInput(descriptor, resolved), {
    contentType: response.headers.get("content-type"),
    contentTypeOptions: response.headers.get(KITESURF_NOSNIFF_HEADER),
    bytes,
    opaque,
  });
  if (!verdict.allowed) {
    descriptor.blocked = blockedScriptPolicy(verdict);
    console.warn(
      `[kitesurf-csp] blocked (${descriptor.blocked.reason}) ${resolved}: ` +
        descriptor.blocked.message,
    );
    return;
  }
  descriptor.prefetchedSource = new TextDecoder("utf-8", {
    fatal: false,
    ignoreBOM: false,
  }).decode(bytes);
}

function scriptPrefetchError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function prefetchScript(
  descriptor: ParentScriptDescriptor,
  target: ScriptTarget,
  context: ScriptFetchContext,
): Promise<void> {
  const { resolved, originClass } = target;
  const active = startScriptFetch(context.signal);
  try {
    const response = await fetchScriptResponse(
      descriptor,
      resolved,
      originClass,
      context,
      active.controller.signal,
    );
    if (response === null) return;
    if (await rejectScriptResponse(descriptor, response, resolved)) return;
    await checkAndStoreScriptResponse(descriptor, response, resolved);
  } catch (error) {
    descriptor.prefetchError = scriptPrefetchError(error);
  } finally {
    stopScriptFetch(context.signal, active);
  }
}

/** Prefetches classic scripts; per-script failures are stored on each descriptor. */
export async function prefetchExternalScripts(
  rawOptions: PrefetchExternalScriptsOptions,
): Promise<ParentScriptDescriptor[]> {
  const {
    descriptors,
    pageUrl,
    connectionId,
    mainFrameId,
    mainLoaderId,
    extraHeaders,
    cookieKey,
    baseUrl,
    sandboxOutbound,
    signal,
  } = normalizePrefetchExternalScriptsOptions(rawOptions);
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

  const context: ScriptFetchContext = {
    pageOrigin,
    connectionId,
    mainFrameId,
    outbound,
    signal,
  };
  for (const descriptor of out) {
    if (!isScriptPrefetchCandidate(descriptor)) continue;
    const target = prepareScriptTarget(descriptor, resolveBase, pageUrl);
    if (target === null) continue;
    fetches.push(prefetchScript(descriptor, target, context));
  }

  await Promise.all(fetches);
  return out;
}
