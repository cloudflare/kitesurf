// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Applies page-origin, cookie, CORS, interception, and egress rules to page requests.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { SessionOutbound, SessionOutboundRequest } from "@kitesurf/jsrpc-types/page-script";
import {
  CONNECTION_ID_HEADER,
  FRAME_ID_HEADER,
  getTracker,
} from "../cdp/network-events-registry.ts";
import { getCookieJar } from "../cdp/cookie-jar-registry.ts";
import { siteKey } from "../public-suffix.ts";
import { traceSpan, type Span, type Tracer } from "../tracing.ts";
import { LocalTracer } from "../tracing-local.ts";
import {
  getInterception,
  interceptionMatches,
  registerParked,
  awaitVerdict,
  errorReasonToNet,
  type InterceptAction,
} from "../cdp/fetch-interception.ts";
import { getOutboundFilters, shouldBlock } from "../cdp/outbound-filter-registry.ts";
import { isTextLikeMime, headersToRecord } from "../cdp/network-events.ts";
import { classifyRequest, getRequestBlocker, parseResourceType } from "../request-blocker.ts";
import {
  type CredentialsMode,
  corsCheck,
  corsPreflight,
  corsUnsafeRequestHeaderNames,
  filterCorsResponseHeaders,
  isSafelistedMethod,
  needsPreflight,
  preflightCacheLookup,
} from "./cors.ts";
import { wbaHeadersFor, type WbaEnv } from "./web-bot-auth.ts";
import { directExternalFetch, type ExternalOutbound } from "./external-outbound.ts";
import { looksLikeSvg, sniffImageDims } from "./image-dims.ts";
import { MAX_ENTRY_BYTES, putAuthorFont, putOpaqueImage } from "./resource-store.ts";
import { MAX_SHAPED_FONT_BYTES, shapeFontBytes } from "./font-shaping.ts";
import { engineIsolateId, isForeignIsolate } from "./isolate-id.ts";
import { readCapped, withDeadline } from "../read-capped.ts";
import {
  KITESURF_CORS_VERDICT_HEADER,
  KITESURF_NOSNIFF_HEADER,
} from "@kitesurf/script-gate/gateway-headers";
import { determineReferrer, parseReferrerPolicy } from "@kitesurf/script-gate/referrer-policy";

const RESOURCE_KEY_HEADER = "x-kitesurf-resource-key";
const IMAGE_WIDTH_HEADER = "x-kitesurf-image-width";
const IMAGE_HEIGHT_HEADER = "x-kitesurf-image-height";
const FONT_KEY_HEADER = "x-kitesurf-font-key";

function stripKitesurfHeaders(headers: Record<string, string>): void {
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase().startsWith("x-kitesurf-")) delete headers[name];
  }
}

function failTrackedRequest(
  tracker: ReturnType<typeof getTracker>,
  requestId: string | null,
  reason: string,
): void {
  if (requestId && tracker) tracker.failRequest(requestId, reason);
}

export interface OutboundProps {
  pageOrigin: string;
  externalOutbound?: ExternalOutbound;
  engineIsolateId?: string;
  localTraceParent?: import("../tracing.ts").SpanContext;
  mainFrameId?: string;
  mainLoaderId?: string;
  extraHeaders?: Record<string, string>;
  pageUrl?: string;
  // The document response's Referrer-Policy, shared with frame navigation.
  referrerPolicy?: string;
  connectionId?: string;
  interceptConnectionId?: string;
  cookieKey?: string;
  allowDocumentBypass?: boolean;
  /** Set only by the top-level navigation stub; the user asked for this document. */
  skipRequestBlocker?: boolean;
  topLevelDocument?: boolean;
  walksOwnRedirects?: boolean;
  /** Sealed pixel-free mode substitutes shaping-only fonts. */
  pixelFree?: boolean;
}

const ASSET_SENTINEL_HOST = "kitesurf-fonts";

const ASSET_CACHE_MAX_ENTRY_BYTES = 1_048_576;
const ASSET_CACHE_MAX_TOTAL_BYTES = 4_194_304;
const assetCache = new Map<string, Uint8Array>();
let assetCacheBytes = 0;

function removeAssetCacheEntry(path: string): void {
  const prior = assetCache.get(path);
  if (!prior) return;
  assetCache.delete(path);
  assetCacheBytes -= prior.byteLength;
}

function evictOldestAssetCacheEntry(): boolean {
  const oldest = assetCache.keys().next().value;
  if (oldest === undefined) return false;
  const evicted = assetCache.get(oldest);
  assetCache.delete(oldest);
  assetCacheBytes -= evicted?.byteLength ?? 0;
  return true;
}

function assetCacheOverCapacity(bytes: Uint8Array): boolean {
  return assetCacheBytes + bytes.byteLength > ASSET_CACHE_MAX_TOTAL_BYTES && assetCache.size > 0;
}

function assetCacheStore(path: string, bytes: Uint8Array): void {
  if (bytes.byteLength > ASSET_CACHE_MAX_ENTRY_BYTES) return;
  removeAssetCacheEntry(path);
  while (assetCacheOverCapacity(bytes)) {
    if (!evictOldestAssetCacheEntry()) break;
  }
  if (bytes.byteLength > ASSET_CACHE_MAX_TOTAL_BYTES) return;
  assetCache.set(path, bytes);
  assetCacheBytes += bytes.byteLength;
}

export function assetCacheRetainedBytes(): number {
  return assetCacheBytes;
}

const EGRESS_HEADERS_TIMEOUT_MS = 10_000;
const DOCUMENT_HEADERS_TIMEOUT_MS = 25_000;

const PIXEL_BODY_DEADLINE_MS = 10_000;
const SLOW_EGRESS_HEADERS_THRESHOLD_MS = 2_000;
const MAX_SLOW_HEADER_URL_PREVIEW_CHARS = 160;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const STATUS_CARRIER = 599;
export const CARRIED_STATUS_HEADER = "x-kitesurf-status";

const SUBRESOURCE_SPAN_BUDGET = 250;
const MAX_SUBRESOURCE_SPAN_CONNECTIONS = 256;
const subresourceSpanCounts = new Map<string, number>();

function takeSubresourceSpanBudget(connectionId: string | null): boolean {
  const key = connectionId ?? "unknown";
  const n = subresourceSpanCounts.get(key) ?? 0;
  if (n >= SUBRESOURCE_SPAN_BUDGET) return false;
  evictOldestSpanConnectionIfNeeded(key);
  subresourceSpanCounts.set(key, n + 1);
  return true;
}

function evictOldestSpanConnectionIfNeeded(key: string): void {
  if (
    subresourceSpanCounts.has(key) ||
    subresourceSpanCounts.size < MAX_SUBRESOURCE_SPAN_CONNECTIONS
  ) {
    return;
  }
  const oldest = subresourceSpanCounts.keys().next().value;
  if (oldest !== undefined) subresourceSpanCounts.delete(oldest);
}

const outboundInflight = new Map<string, number>();

export function getOutboundInflight(connectionId: string): number {
  return outboundInflight.get(connectionId) ?? 0;
}

const foreignIsolateNoted = new Set<string>();
const FOREIGN_ISOLATE_NOTED_CAP = 1024;

function noteForeignIsolate(connectionId: string): void {
  if (foreignIsolateNoted.has(connectionId)) return;
  if (foreignIsolateNoted.size >= FOREIGN_ISOLATE_NOTED_CAP) {
    foreignIsolateNoted.clear();
  }
  foreignIsolateNoted.add(connectionId);
  console.warn(
    `[ks-outbound] foreign isolate: session=${connectionId || "?"} fetch ran outside the owning engine isolate; engine-held state skipped`,
  );
}

export type SandboxOutboundEnv = WbaEnv & {
  FONT_ASSETS: { fetch(req: Request): Promise<Response> };
  HOST_TRACER?: Tracer;
};

export type SandboxOutboundExports = {
  SandboxOutbound(opts: { props: OutboundProps }): Fetcher;
};

export interface SandboxOutboundOverride {
  readonly external: boolean;
  parent(props: Omit<OutboundProps, "externalOutbound">): Fetcher;
  loaded(props: Omit<OutboundProps, "externalOutbound">): Fetcher;
  session(props: Omit<OutboundProps, "externalOutbound">): SessionOutbound;
  final(request: Request): Promise<Response>;
}

function sessionRequest(req: SessionOutboundRequest): Request {
  return new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    redirect: "manual",
  });
}

export function rpcSafeResponse(resp: Response): Response {
  if (resp.status >= 200 && resp.status <= 599) return resp;
  const body = rpcResponseBody(resp);
  return corsFilteredResponse(resp, body, new Headers(resp.headers));
}

function rpcResponseBody(resp: Response): ReadableStream<Uint8Array> | null {
  if (resp.status >= 200) return resp.body;
  void resp.body?.cancel().catch(() => {});
  if (resp.status === 101) return null;
  throw new TypeError("Failed to fetch");
}

export function createSandboxOutboundOverride(
  exports: SandboxOutboundExports,
  env: SandboxOutboundEnv,
  externalOutbound?: ExternalOutbound,
): SandboxOutboundOverride {
  const seal = (props: Omit<OutboundProps, "externalOutbound">): OutboundProps => ({
    ...props,
    externalOutbound,
    engineIsolateId: engineIsolateId(),
  });
  return {
    external: externalOutbound !== undefined,
    parent(props) {
      const sealed = seal(props);
      return {
        fetch: (request: Request) => SandboxOutbound.handle(env, sealed, request),
      } as Fetcher;
    },
    loaded(props) {
      return exports.SandboxOutbound({ props: seal(props) });
    },
    session(props) {
      const sealed = seal(props);
      return async (req) =>
        rpcSafeResponse(await SandboxOutbound.handle(env, sealed, sessionRequest(req)));
    },
    final(request) {
      return directExternalFetch(externalOutbound, request);
    },
  };
}

export class SandboxOutbound extends WorkerEntrypoint<SandboxOutboundEnv, OutboundProps> {
  override fetch(request: Request): Promise<Response> {
    return SandboxOutbound.handle(this.env, this.ctx.props, request);
  }

  static async handle(
    env: SandboxOutboundEnv,
    props: OutboundProps | undefined,
    request: Request,
  ): Promise<Response> {
    // Inflight accounting covers headers only (body streams past the
    // return) — matching the platform's awaiting-headers socket cap.
    const conn = props?.connectionId ?? request.headers.get(CONNECTION_ID_HEADER) ?? "";
    beginOutboundInflight(conn);
    try {
      return await SandboxOutbound.fetchTraced(env, props, request);
    } finally {
      endOutboundInflight(conn);
    }
  }

  private static async fetchTraced(
    env: SandboxOutboundEnv,
    props: OutboundProps | undefined,
    request: Request,
  ): Promise<Response> {
    const tracer = env.HOST_TRACER;
    if (!tracer) return SandboxOutbound.fetchPolicy(env, props, request);
    if (tracer.getSpanContext() !== null) {
      return SandboxOutbound.fetchSpanned(env, props, tracer, request);
    }
    const stamped = localTraceParent(tracer, props);
    if (stamped === null) return SandboxOutbound.fetchPolicy(env, props, request);
    return tracer.runWithSpanContext(stamped, () =>
      SandboxOutbound.fetchSpanned(env, props, tracer, request),
    );
  }

  private static async fetchSpanned(
    env: SandboxOutboundEnv,
    props: OutboundProps | undefined,
    tracer: import("../tracing.ts").Tracer,
    request: Request,
  ): Promise<Response> {
    const connectionId = props?.connectionId ?? request.headers.get(CONNECTION_ID_HEADER);
    if (!takeSubresourceSpanBudget(connectionId)) {
      return SandboxOutbound.fetchPolicy(env, props, request);
    }
    const { host, path } = requestSpanLocation(request.url);
    return traceSpan(
      tracer,
      "subresource.fetch",
      async (s) => {
        const resp = await SandboxOutbound.fetchPolicy(env, props, request);
        tagSubresourceResponse(s, resp);
        return resp;
      },
      {
        kind: request.headers.get("x-kitesurf-resource-type") ?? "Other",
        host,
        path,
      },
    );
  }

  private static async fetchAsset(env: SandboxOutboundEnv, parsedUrl: URL): Promise<Response> {
    const key = parsedUrl.pathname + parsedUrl.search;
    const hit = assetCache.get(key);
    if (hit) {
      return new Response(hit.slice(), {
        headers: { "content-type": "font/otf" },
      });
    }
    const cleanUrl = `https://kitesurf.invalid${key}`;
    const resp = await env.FONT_ASSETS.fetch(new Request(cleanUrl, { method: "GET" }));
    if (!resp.ok) return resp;
    const bytes = new Uint8Array(await resp.arrayBuffer());
    assetCacheStore(key, bytes);
    return new Response(bytes.slice(), {
      headers: { "content-type": "font/otf" },
    });
  }

  /**
   * Applies page-origin, cookie, CORS, interception, tracker, and egress rules to one request.
   * Policy blocks return responses; upstream fetch or interception failures can reject the call.
   */
  static async fetchPolicy(
    env: SandboxOutboundEnv,
    props: OutboundProps | undefined,
    request: Request,
  ): Promise<Response> {
    const target = parseRequestTarget(request.url);
    if (target === null) return blocked("kitesurf: invalid URL", "invalid-url");
    if (target.hostname === ASSET_SENTINEL_HOST) {
      return SandboxOutbound.fetchAsset(env, target);
    }
    const policy = createOutboundPolicyState(env, props, request, target);
    if (policy.kind === "respond") return policy.response;
    return runOutboundPolicy(policy.value);
  }
}

function beginOutboundInflight(connectionId: string): void {
  if (!connectionId) return;
  outboundInflight.set(connectionId, (outboundInflight.get(connectionId) ?? 0) + 1);
}

function endOutboundInflight(connectionId: string): void {
  if (!connectionId) return;
  const count = (outboundInflight.get(connectionId) ?? 1) - 1;
  if (count <= 0) outboundInflight.delete(connectionId);
  else outboundInflight.set(connectionId, count);
}

function localTraceParent(
  tracer: Tracer,
  props: OutboundProps | undefined,
): import("../tracing.ts").SpanContext | null {
  if (!(tracer instanceof LocalTracer)) return null;
  return props?.localTraceParent ?? null;
}

function requestSpanLocation(url: string): { host: string; path: string } {
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname, path: parsed.pathname };
  } catch {
    return { host: "", path: "" };
  }
}

function tagSubresourceResponse(span: Span | null, response: Response): void {
  if (!span || !span.isRecording) return;
  span.setTags({
    status: response.status,
    contentLength: response.headers.get("content-length") ?? "",
    blocked: response.headers.get("x-kitesurf-blocked") ?? "",
  });
}

type OutboundStep<T> = { kind: "continue"; value: T } | { kind: "respond"; response: Response };

interface OutboundOriginState {
  sealed: boolean;
  externalOutbound: ExternalOutbound | undefined;
  hostEgress: boolean;
  pageOrigin: string;
  cookieContext: { initiatorHost: string | null };
  opaqueOrigin: boolean;
  allowed: URL;
  allowedOriginKey: string;
  sameOrigin: boolean;
  crossOriginNow: boolean;
}

interface OutboundCorsState {
  resourceType: string;
  scriptCorsMode: string;
  opaqueResourceBypass: boolean;
  stylesheetCorsMode: string;
  sheetWantsCors: boolean;
  noCorsMode: boolean;
  opaqueNoCors: boolean;
  needsCorsCheck: boolean;
  corpApplies: boolean;
  credentialsMode: CredentialsMode | null;
  credentialsInclude: boolean;
  sendCredentials: boolean;
  authorUnsafeHeaders: string[];
  wantsPreflight: boolean;
}

interface OutboundNetworkState {
  connectionId: string;
  foreignIsolate: boolean;
  tracker: ReturnType<typeof getTracker>;
  requestFrameId: string;
  networkFrameId: string;
  networkLoaderId: string;
  networkSessionIds: TrackerSessionIds;
}

interface OutboundPolicyState extends OutboundOriginState, OutboundCorsState, OutboundNetworkState {
  env: SandboxOutboundEnv;
  props: OutboundProps | undefined;
  request: Request;
  target: URL;
}

interface PreparedOutboundState extends OutboundPolicyState {
  forwardRequest: Request;
  cookieKey: string;
  jar: ReturnType<typeof getCookieJar>;
  requestId: string | null;
}

interface OutboundResponseState extends PreparedOutboundState {
  response: Response;
  isRedirect: boolean;
  emptyLocationRedirect: boolean;
  reduceToOpaque: boolean;
  shellRedirect: boolean;
  withholdImage: boolean;
  interceptFont: boolean;
  shapeFont: boolean;
  corsVerdict: "clean" | "opaque" | null;
}

function parseRequestTarget(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function pageOriginForRequest(props: OutboundProps | undefined, headerOrigin: string): string {
  if (headerOrigin === "null") return "";
  if (props) return props.pageOrigin ?? "";
  return headerOrigin;
}

function cookieOriginForRequest(props: OutboundProps | undefined, headerOrigin: string): string {
  if (props) return props.pageOrigin ?? "";
  return headerOrigin === "null" ? "" : headerOrigin;
}

function cookieContextFromOrigin(origin: string): { initiatorHost: string | null } {
  if (!origin) return { initiatorHost: null };
  try {
    return { initiatorHost: new URL(origin).hostname };
  } catch {
    return { initiatorHost: null };
  }
}

function allowedPageOrigin(pageOrigin: string, opaqueOrigin: boolean): URL | null {
  if (opaqueOrigin) return new URL("https://opaque.invalid/");
  try {
    return new URL(pageOrigin);
  } catch {
    return null;
  }
}

function originStateForAllowedPage(
  props: OutboundProps | undefined,
  pageOrigin: string,
  cookieContext: { initiatorHost: string | null },
  opaqueOrigin: boolean,
  target: URL,
  allowed: URL,
): OutboundStep<OutboundOriginState> {
  if (allowed.host === "kitesurf.local") {
    return {
      kind: "respond",
      response: blocked(
        "kitesurf: synthetic-origin fetch dropped (no network during bench)",
        "synthetic-origin",
      ),
    };
  }
  const sameOrigin = !opaqueOrigin && originKey(target) === originKey(allowed);
  const externalOutbound = props?.externalOutbound;
  return {
    kind: "continue",
    value: {
      sealed: !!props,
      externalOutbound,
      hostEgress: externalOutbound !== undefined,
      pageOrigin,
      cookieContext,
      opaqueOrigin,
      allowed,
      allowedOriginKey: originKey(allowed),
      sameOrigin,
      crossOriginNow: !sameOrigin,
    },
  };
}

function createOutboundOriginState(
  props: OutboundProps | undefined,
  request: Request,
  target: URL,
): OutboundStep<OutboundOriginState> {
  const headerOrigin = request.headers.get("x-kitesurf-page-origin") ?? "";
  const pageOrigin = pageOriginForRequest(props, headerOrigin);
  const cookieContext = cookieContextFromOrigin(cookieOriginForRequest(props, headerOrigin));
  const opaqueOrigin = !pageOrigin;
  const allowed = allowedPageOrigin(pageOrigin, opaqueOrigin);
  if (allowed === null) {
    return {
      kind: "respond",
      response: blocked("kitesurf: invalid page origin", "invalid-page-origin"),
    };
  }
  return originStateForAllowedPage(props, pageOrigin, cookieContext, opaqueOrigin, target, allowed);
}

function isSafeOpaqueResource(
  resourceType: string,
  props: OutboundProps | undefined,
  scriptCorsMode: string,
): boolean {
  switch (resourceType) {
    case "Image":
    case "Stylesheet":
      return true;
    case "Document":
      return props?.allowDocumentBypass === true;
    case "Script":
      return scriptCorsMode === "no-cors";
    default:
      return false;
  }
}

function requestCredentialsMode(value: string | null): CredentialsMode | null {
  if (value === null) return null;
  if (value === "omit" || value === "same-origin" || value === "include") return value;
  return "same-origin";
}

function credentialsForOrigin(sameOrigin: boolean, mode: CredentialsMode | null): boolean {
  return sameOrigin ? mode !== "omit" : mode === "include";
}

function corpAppliesToRequest(
  request: Request,
  resourceType: string,
  scriptCorsMode: string,
): boolean {
  return (
    request.headers.get("x-kitesurf-mode") === "no-cors" ||
    (resourceType === "Script" && scriptCorsMode === "no-cors")
  );
}

function outboundResourceCorsState(
  props: OutboundProps | undefined,
  request: Request,
): Pick<
  OutboundCorsState,
  "resourceType" | "scriptCorsMode" | "opaqueResourceBypass" | "corpApplies"
> {
  const resourceType = request.headers.get("x-kitesurf-resource-type") ?? "";
  const scriptCorsMode = request.headers.get("x-kitesurf-script-cors") ?? "";
  const allowCrossOrigin = request.headers.get("x-kitesurf-allow-cross-origin") === "1";
  return {
    resourceType,
    scriptCorsMode,
    opaqueResourceBypass:
      allowCrossOrigin && isSafeOpaqueResource(resourceType, props, scriptCorsMode),
    corpApplies: corpAppliesToRequest(request, resourceType, scriptCorsMode),
  };
}

function outboundStylesheetCorsState(
  request: Request,
  resourceType: string,
  sameOrigin: boolean,
): Pick<OutboundCorsState, "stylesheetCorsMode" | "sheetWantsCors"> {
  const stylesheetCorsMode =
    resourceType === "Stylesheet" ? (request.headers.get("x-kitesurf-stylesheet-cors") ?? "") : "";
  return {
    stylesheetCorsMode,
    sheetWantsCors: stylesheetCorsMode === "cors" && !sameOrigin,
  };
}

function outboundRequestModeState(
  request: Request,
  sameOrigin: boolean,
  opaqueResourceBypass: boolean,
): Pick<OutboundCorsState, "noCorsMode" | "opaqueNoCors" | "needsCorsCheck"> {
  const noCorsMode = request.headers.get("x-kitesurf-mode") === "no-cors";
  return {
    noCorsMode,
    opaqueNoCors: noCorsMode && !sameOrigin,
    needsCorsCheck: !sameOrigin && !opaqueResourceBypass && !noCorsMode,
  };
}

function outboundCredentialState(
  request: Request,
  sameOrigin: boolean,
): Pick<OutboundCorsState, "credentialsMode" | "credentialsInclude" | "sendCredentials"> {
  const credentialsMode = requestCredentialsMode(request.headers.get("x-kitesurf-credentials"));
  const credentialsInclude = credentialsForOrigin(sameOrigin, credentialsMode);
  return {
    credentialsMode,
    credentialsInclude,
    sendCredentials: credentialsMode === null || credentialsInclude,
  };
}

function createOutboundCorsState(
  props: OutboundProps | undefined,
  request: Request,
  pageOrigin: string,
  sameOrigin: boolean,
): OutboundCorsState {
  const resource = outboundResourceCorsState(props, request);
  const stylesheet = outboundStylesheetCorsState(request, resource.resourceType, sameOrigin);
  const requestMode = outboundRequestModeState(request, sameOrigin, resource.opaqueResourceBypass);
  const credentials = outboundCredentialState(request, sameOrigin);
  const authorUnsafeHeaders = requestMode.needsCorsCheck
    ? corsUnsafeRequestHeaderNames(request.headers)
    : [];
  return {
    ...resource,
    ...stylesheet,
    ...requestMode,
    ...credentials,
    authorUnsafeHeaders,
    wantsPreflight: requestMode.needsCorsCheck && needsPreflight(request.method, request.headers),
  };
}

function outboundConnectionId(
  props: OutboundProps | undefined,
  request: Request,
  sealed: boolean,
): string {
  if (sealed) return props?.connectionId ?? "";
  return request.headers.get(CONNECTION_ID_HEADER) ?? "";
}

function outboundFrameId(
  props: OutboundProps | undefined,
  request: Request,
  sealed: boolean,
): string {
  if (sealed) return props?.mainFrameId ?? "";
  return request.headers.get(FRAME_ID_HEADER) ?? "";
}

type TrackerAttribution = ReturnType<
  NonNullable<ReturnType<typeof getTracker>>["attributionForTarget"]
>;
type TrackerSessionIds = NonNullable<TrackerAttribution>["sessionIds"];

function attributedNetworkFrameId(attribution: TrackerAttribution, fallback: string): string {
  return attribution?.frameId ?? fallback;
}

function attributedNetworkLoaderId(
  attribution: TrackerAttribution,
  props: OutboundProps | undefined,
): string {
  const loaderId = attribution?.loaderId;
  if (loaderId !== undefined) return loaderId;
  return props?.mainLoaderId ?? "";
}

function attributedNetworkSessionIds(attribution: TrackerAttribution): TrackerSessionIds {
  return attribution?.sessionIds ?? [];
}

function outboundNetworkAttribution(
  props: OutboundProps | undefined,
  requestFrameId: string,
  tracker: ReturnType<typeof getTracker>,
): Pick<OutboundNetworkState, "networkFrameId" | "networkLoaderId" | "networkSessionIds"> {
  const attribution = tracker?.attributionForTarget(requestFrameId);
  return {
    networkFrameId: attributedNetworkFrameId(attribution, requestFrameId),
    networkLoaderId: attributedNetworkLoaderId(attribution, props),
    networkSessionIds: attributedNetworkSessionIds(attribution),
  };
}

function createOutboundNetworkState(
  props: OutboundProps | undefined,
  request: Request,
  pageOrigin: string,
  sealed: boolean,
): OutboundNetworkState {
  const connectionId = outboundConnectionId(props, request, sealed);
  const foreignIsolate = isForeignIsolate(props?.engineIsolateId);
  if (foreignIsolate) noteForeignIsolate(connectionId);
  const tracker = connectionId ? getTracker(connectionId) : undefined;
  const requestFrameId = outboundFrameId(props, request, sealed);
  return {
    connectionId,
    foreignIsolate,
    tracker,
    requestFrameId,
    ...outboundNetworkAttribution(props, requestFrameId, tracker),
  };
}

function createOutboundPolicyState(
  env: SandboxOutboundEnv,
  props: OutboundProps | undefined,
  request: Request,
  target: URL,
): OutboundStep<OutboundPolicyState> {
  const origin = createOutboundOriginState(props, request, target);
  if (origin.kind === "respond") return origin;
  const cors = createOutboundCorsState(
    props,
    request,
    origin.value.pageOrigin,
    origin.value.sameOrigin,
  );
  const network = createOutboundNetworkState(
    props,
    request,
    origin.value.pageOrigin,
    origin.value.sealed,
  );
  return {
    kind: "continue",
    value: {
      env,
      props,
      request,
      target,
      ...origin.value,
      ...cors,
      ...network,
    },
  };
}

function outboundFilterResponse(state: OutboundPolicyState): Response | null {
  if (!state.connectionId) return null;
  const filters = getOutboundFilters(state.connectionId);
  if (!filters) return null;
  const decision = shouldBlock(filters, state.request.url, state.resourceType);
  if (!decision.blocked) return null;
  return new Response(`kitesurf: outbound blocked — ${decision.reason}\n`, {
    status: 451,
    statusText: "Blocked by kitesurf outbound filter",
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-kitesurf-blocked-reason": decision.reason,
    },
  });
}

function requestBlockerForState(state: OutboundPolicyState) {
  if (state.props?.skipRequestBlocker === true || !state.connectionId) return undefined;
  return getRequestBlocker(state.connectionId);
}

function requestBlockerVerdict(state: OutboundPolicyState) {
  const pageHost = state.allowed.host === "opaque.invalid" ? "" : state.allowed.hostname;
  return classifyRequest(
    requestBlockerForState(state),
    state.request.url,
    pageHost,
    parseResourceType(state.resourceType),
  );
}

function recordRequestBlockerFailure(state: OutboundPolicyState): void {
  if (!state.tracker) return;
  const headers = headersToRecord(state.request.headers);
  stripKitesurfHeaders(headers);
  const requestId = state.tracker.beginRequest({
    url: state.request.url,
    method: state.request.method,
    headers,
    type: parseResourceType(state.resourceType),
    initiator: {
      type: state.request.headers.get("x-kitesurf-initiator") === "parser" ? "parser" : "script",
      url: state.pageOrigin,
    },
    loaderId: state.networkLoaderId,
    frameId: state.networkFrameId,
    sessionIds: state.networkSessionIds,
  });
  state.tracker.failRequest(requestId, "net::ERR_BLOCKED_BY_CLIENT", "subresource-filter");
}

function requestBlockerResponse(state: OutboundPolicyState): Response | null {
  const verdict = requestBlockerVerdict(state);
  if (verdict === null) return null;
  recordRequestBlockerFailure(state);
  return new Response(`kitesurf: outbound blocked — ${verdict.reason}\n`, {
    status: 451,
    statusText: "Blocked by kitesurf request blocker",
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-kitesurf-blocked-reason": verdict.reason,
      "x-kitesurf-blocked-match": verdict.matched,
    },
  });
}

function earlyOutboundPolicyResponse(state: OutboundPolicyState): Response | null {
  const filtered = outboundFilterResponse(state);
  if (filtered !== null) return filtered;
  return requestBlockerResponse(state);
}

function isWebSocketRequest(request: Request): boolean {
  return (request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket";
}

function websocketCookieKey(state: OutboundPolicyState): string {
  return state.sealed
    ? state.props?.cookieKey || state.connectionId
    : state.request.headers.get("x-kitesurf-cookie-key") || state.connectionId;
}

function setWebSocketProtocol(headers: Headers, request: Request): void {
  const protocol = request.headers.get("Sec-WebSocket-Protocol");
  if (protocol) headers.set("Sec-WebSocket-Protocol", protocol);
}

function setWebSocketOrigin(headers: Headers, pageOrigin: string): void {
  if (pageOrigin) headers.set("Origin", pageOrigin);
}

function setWebSocketCookie(state: OutboundPolicyState, headers: Headers): void {
  const jarKey = websocketCookieKey(state);
  const jar = jarKey ? getCookieJar(jarKey) : undefined;
  if (!jar) return;
  const cookie = jar.cookieHeaderForUrl(state.request.url, state.cookieContext);
  if (cookie) headers.set("cookie", cookie);
}

function websocketHeaders(state: OutboundPolicyState): Headers {
  const headers = new Headers();
  headers.set("Upgrade", "websocket");
  setWebSocketProtocol(headers, state.request);
  setWebSocketOrigin(headers, state.pageOrigin);
  setWebSocketCookie(state, headers);
  return headers;
}

function fetchOutboundWebSocket(state: OutboundPolicyState): Promise<Response> {
  return directExternalFetch(
    state.externalOutbound,
    new Request(state.request.url, { method: "GET", headers: websocketHeaders(state) }),
  );
}

function sanitizedNoCorsRequest(state: OutboundPolicyState): OutboundStep<Request> {
  if (!state.noCorsMode) return { kind: "continue", value: state.request };
  if (!isSafelistedMethod(state.request.method)) {
    return {
      kind: "respond",
      response: blocked(
        `kitesurf: mode 'no-cors' only permits GET, HEAD and POST, not ${state.request.method}`,
        "no-cors-method",
      ),
    };
  }
  const unsafe = corsUnsafeRequestHeaderNames(state.request.headers);
  if (unsafe.length === 0) return { kind: "continue", value: state.request };
  const headers = new Headers(state.request.headers);
  for (const name of unsafe) headers.delete(name);
  return { kind: "continue", value: new Request(state.request, { headers }) };
}

function configuredRequestCookieKey(state: OutboundPolicyState): string {
  if (state.sealed) return state.props?.cookieKey ?? "";
  return state.request.headers.get("x-kitesurf-cookie-key") ?? "";
}

function requestCookieKey(state: OutboundPolicyState): string {
  return configuredRequestCookieKey(state) || state.connectionId;
}

function attachRequestCookie(state: PreparedOutboundState): void {
  if (!state.jar || !state.sendCredentials || state.forwardRequest.headers.has("cookie")) return;
  const cookie = state.jar.cookieHeaderForUrl(state.request.url, state.cookieContext);
  if (cookie) state.forwardRequest.headers.set("cookie", cookie);
}

function trackedRequestId(state: OutboundPolicyState, forwardRequest: Request): string | null {
  if (!state.tracker) return null;
  const typeHint = (state.request.headers.get("x-kitesurf-resource-type") ?? "Other") as
    | "Document"
    | "Stylesheet"
    | "Image"
    | "Script"
    | "XHR"
    | "Fetch"
    | "Other";
  const initiatorType =
    state.request.headers.get("x-kitesurf-initiator") === "parser" ? "parser" : "script";
  return state.tracker.beginRequest({
    url: state.request.url,
    method: state.request.method,
    headers: headersToRecord(forwardRequest.headers),
    type: typeHint,
    initiator: { type: initiatorType, url: state.pageOrigin },
    loaderId: state.networkLoaderId,
    frameId: state.networkFrameId,
    sessionIds: state.networkSessionIds,
  });
}

async function prepareOutboundRequest(
  state: OutboundPolicyState,
): Promise<OutboundStep<PreparedOutboundState>> {
  const extraHeaders = state.props?.extraHeaders ?? {};
  const wbaHeaders = await outboundWbaHeaders(state);
  const authorRequest = sanitizedNoCorsRequest(state);
  if (authorRequest.kind === "respond") return authorRequest;
  return finishOutboundRequestPreparation(state, authorRequest.value, wbaHeaders, extraHeaders);
}

async function outboundWbaHeaders(state: OutboundPolicyState): Promise<Record<string, string>> {
  if (state.hostEgress) return {};
  return wbaHeadersFor(state.env, state.target.host);
}

async function finishOutboundRequestPreparation(
  state: OutboundPolicyState,
  authorRequest: Request,
  wbaHeaders: Record<string, string>,
  extraHeaders: Record<string, string>,
): Promise<OutboundStep<PreparedOutboundState>> {
  const forwardRequest = buildForwardRequest(
    outboundForwardRequestOptions(state, authorRequest, wbaHeaders, extraHeaders),
  );
  const cookieKey = requestCookieKey(state);
  const jar = cookieKey ? getCookieJar(cookieKey) : undefined;
  const prepared: PreparedOutboundState = {
    ...state,
    forwardRequest,
    cookieKey,
    jar,
    requestId: null,
  };
  attachRequestCookie(prepared);
  prepared.requestId = trackedRequestId(state, forwardRequest);
  return { kind: "continue", value: prepared };
}

function outboundForwardRequestOptions(
  state: OutboundPolicyState,
  original: Request,
  wbaHeaders: Record<string, string>,
  extraHeaders: Record<string, string>,
): BuildForwardRequestOptions {
  const props = state.props;
  return {
    original,
    resourceType: state.resourceType,
    pageOrigin: state.pageOrigin,
    extraHeaders,
    pageUrl: pageUrlFromProps(props),
    referrerPolicy: referrerPolicyFromProps(props),
    wbaHeaders,
    corsMode: state.needsCorsCheck || state.sheetWantsCors,
  };
}

function pageUrlFromProps(props: OutboundProps | undefined): string | undefined {
  return props?.pageUrl;
}

function referrerPolicyFromProps(props: OutboundProps | undefined): string | undefined {
  return props?.referrerPolicy;
}

type ContinueInterceptAction = Extract<InterceptAction, { kind: "continue" }>;

function interceptedHeaders(entries: NonNullable<ContinueInterceptAction["headers"]>): Headers {
  const headers = new Headers();
  for (const entry of entries) headers.append(entry.name, entry.value);
  headers.set(
    "accept-encoding",
    decodableAcceptEncoding(headers.get("accept-encoding"), headers.has("range")),
  );
  return headers;
}

function continueRequestHeaders(
  state: PreparedOutboundState,
  action: ContinueInterceptAction,
): Headers {
  return action.headers ? interceptedHeaders(action.headers) : state.forwardRequest.headers;
}

function continueRequestBody(
  state: PreparedOutboundState,
  action: ContinueInterceptAction,
): BodyInit | null {
  return action.postData !== undefined
    ? Uint8Array.from(atob(action.postData), (character) => character.charCodeAt(0))
    : state.forwardRequest.body;
}

function continuedRequest(
  state: PreparedOutboundState,
  action: ContinueInterceptAction,
  headers: Headers,
): Request {
  return new Request(action.url ?? state.forwardRequest.url, {
    method: action.method ?? state.forwardRequest.method,
    headers,
    body: continueRequestBody(state, action),
    redirect: "manual",
    signal: state.forwardRequest.signal,
  });
}

function hasContinueRequestOverrides(action: ContinueInterceptAction): boolean {
  return (
    action.url !== undefined ||
    action.method !== undefined ||
    action.headers !== undefined ||
    action.postData !== undefined
  );
}

function updateCorsAfterInterception(state: PreparedOutboundState, sameOrigin: boolean): void {
  const cors = interceptedCorsState(state, sameOrigin);
  state.crossOriginNow = cors.crossOriginNow;
  state.opaqueNoCors = cors.opaqueNoCors;
  state.needsCorsCheck = cors.needsCorsCheck;
  state.credentialsInclude = cors.credentialsInclude;
  state.sendCredentials = cors.sendCredentials;
  if (!state.sendCredentials) state.forwardRequest.headers.delete("cookie");
}

function interceptedCorsState(
  state: PreparedOutboundState,
  sameOrigin: boolean,
): Pick<
  OutboundCorsState,
  "opaqueNoCors" | "needsCorsCheck" | "credentialsInclude" | "sendCredentials"
> & { crossOriginNow: boolean } {
  const credentialsInclude = credentialsForOrigin(sameOrigin, state.credentialsMode);
  return {
    crossOriginNow: !sameOrigin,
    opaqueNoCors: state.noCorsMode && !sameOrigin,
    needsCorsCheck: !sameOrigin && !state.opaqueResourceBypass && !state.noCorsMode,
    credentialsInclude,
    sendCredentials: state.credentialsMode === null || credentialsInclude,
  };
}

function shouldUpdateInterceptionTarget(
  state: PreparedOutboundState,
  action: ContinueInterceptAction,
): boolean {
  return action.url !== undefined && action.url !== state.target.href;
}

function restoreInterceptionCookie(state: PreparedOutboundState): void {
  state.forwardRequest.headers.delete("cookie");
  const cookie = state.jar?.cookieHeaderForUrl(state.forwardRequest.url, state.cookieContext);
  if (cookie) state.forwardRequest.headers.set("cookie", cookie);
}

function updateInterceptionTarget(
  state: PreparedOutboundState,
  action: ContinueInterceptAction,
): void {
  if (!shouldUpdateInterceptionTarget(state, action)) return;
  try {
    state.target = new URL(state.forwardRequest.url);
  } catch {}
  restoreInterceptionCookie(state);
  const sameOrigin = !state.opaqueOrigin && originKey(state.target) === state.allowedOriginKey;
  updateCorsAfterInterception(state, sameOrigin);
}

async function addInterceptionOutboundHeaders(state: PreparedOutboundState): Promise<void> {
  const headers = state.hostEgress ? {} : await wbaHeadersFor(state.env, state.target.host);
  for (const [name, value] of Object.entries(headers)) {
    state.forwardRequest.headers.set(name, value);
  }
  if (state.needsCorsCheck) {
    state.forwardRequest.headers.set("origin", state.pageOrigin || "null");
  }
}

async function applyContinueInterceptAction(
  state: PreparedOutboundState,
  action: ContinueInterceptAction,
): Promise<void> {
  if (!hasContinueRequestOverrides(action)) return;
  const headers = continueRequestHeaders(state, action);
  state.forwardRequest = continuedRequest(state, action, headers);
  updateInterceptionTarget(state, action);
  const authorHeaders = action.headers ? headers : state.request.headers;
  state.authorUnsafeHeaders = state.needsCorsCheck
    ? corsUnsafeRequestHeaderNames(authorHeaders)
    : [];
  state.wantsPreflight =
    state.needsCorsCheck && needsPreflight(state.forwardRequest.method, authorHeaders);
  await addInterceptionOutboundHeaders(state);
}

function interceptedFulfillmentHeaders(
  action: Extract<InterceptAction, { kind: "fulfill" }>,
): Headers {
  const headers = new Headers();
  for (const entry of action.responseHeaders ?? []) headers.append(entry.name, entry.value);
  return headers;
}

function interceptedFulfillmentBody(
  action: Extract<InterceptAction, { kind: "fulfill" }>,
): Uint8Array {
  return action.body
    ? Uint8Array.from(atob(action.body), (character) => character.charCodeAt(0))
    : new Uint8Array(0);
}

function completeInterceptedFulfillment(
  state: PreparedOutboundState,
  action: Extract<InterceptAction, { kind: "fulfill" }>,
  headers: Headers,
  body: Uint8Array,
): void {
  if (!state.requestId || !state.tracker) return;
  state.tracker.completeRequest(state.requestId, {
    url: state.forwardRequest.url,
    status: action.responseCode,
    statusText: "",
    headers: headersToRecord(headers),
    mimeType: interceptedMimeType(headers),
    bodyLength: body.length,
    body: action.body ?? "",
    bodyBase64Encoded: true,
  });
}

function interceptedMimeType(headers: Headers): string {
  return (headers.get("content-type")?.split(";")[0] ?? "").trim() || "text/plain";
}

function interceptedCorsFailure(state: PreparedOutboundState, response: Response): Response | null {
  if (!state.needsCorsCheck || !response.headers.has("access-control-allow-origin")) return null;
  const failure = checkCorsResponse(
    response,
    state.pageOrigin,
    state.target,
    state.credentialsInclude,
  );
  if (failure === null) return null;
  failTrackedRequest(state.tracker, state.requestId, failure.reason);
  return blocked(failure.message, "cors");
}

function fulfilledInterceptResponse(
  action: Extract<InterceptAction, { kind: "fulfill" }>,
  headers: Headers,
  body: Uint8Array,
): Response {
  const noBody = [101, 204, 205, 304].includes(action.responseCode);
  return new Response(noBody ? null : body, {
    status: action.responseCode,
    headers,
  });
}

function failInterceptedAction(
  state: PreparedOutboundState,
  action: Extract<InterceptAction, { kind: "fail" }>,
): never {
  const message = errorReasonToNet(action.errorReason);
  failTrackedRequest(state.tracker, state.requestId, message);
  throw new Error(message);
}

async function applyInterceptAction(
  state: PreparedOutboundState,
  action: InterceptAction,
): Promise<Response | null> {
  switch (action.kind) {
    case "fail":
      return failInterceptedAction(state, action);
    case "fulfill": {
      const headers = interceptedFulfillmentHeaders(action);
      const body = interceptedFulfillmentBody(action);
      completeInterceptedFulfillment(state, action, headers, body);
      const response = fulfilledInterceptResponse(action, headers, body);
      return interceptedCorsFailure(state, response) ?? response;
    }
    case "continue":
      await applyContinueInterceptAction(state, action);
      return null;
  }
}

function interceptionConnection(state: PreparedOutboundState): string {
  return state.sealed
    ? state.props?.interceptConnectionId || state.connectionId
    : (state.request.headers.get("x-kitesurf-intercept-connection") ?? state.connectionId);
}

async function interceptionPostData(state: PreparedOutboundState): Promise<string | undefined> {
  if (state.forwardRequest.method === "GET" || state.forwardRequest.method === "HEAD") {
    return undefined;
  }
  return readBodyCapped(state.forwardRequest, POST_DATA_CAP_BYTES);
}

function matchingRequestInterception(
  state: PreparedOutboundState,
): ReturnType<typeof getInterception> {
  const connectionId = interceptionConnection(state);
  const interception = connectionId ? getInterception(connectionId) : undefined;
  if (!interception) return undefined;
  if (!interceptionMatches(interception, state.forwardRequest.url, state.resourceType)) {
    return undefined;
  }
  return interception;
}

async function interceptOutboundRequest(state: PreparedOutboundState): Promise<Response | null> {
  const interception = matchingRequestInterception(state);
  if (!interception) return null;
  const postData = await interceptionPostData(state);
  const parked = registerParked(interception, {
    url: state.forwardRequest.url,
    method: state.forwardRequest.method,
    headers: headersToRecord(state.forwardRequest.headers),
    postData,
    resourceType: state.resourceType,
    frameId: state.networkFrameId,
    networkId: state.request.headers.get("x-kitesurf-network-id") ?? state.requestId ?? "",
  });
  const action = await awaitVerdict(interception, parked);
  return applyInterceptAction(state, action);
}

function preflightCacheHit(state: PreparedOutboundState): boolean {
  return (
    !state.hostEgress &&
    preflightCacheLookup(
      state.pageOrigin || "null",
      state.forwardRequest.url,
      state.forwardRequest.method,
      state.authorUnsafeHeaders,
      state.credentialsInclude,
    )
  );
}

function preflightAbortSignal(request: Request, controller: AbortController): AbortSignal {
  if (typeof AbortSignal.any !== "function" || !request.signal) return controller.signal;
  return AbortSignal.any([request.signal, controller.signal]);
}

async function preflightOutboundHeaders(
  state: PreparedOutboundState,
  request: Request,
): Promise<Response> {
  const headers = state.hostEgress ? {} : await wbaHeadersFor(state.env, state.target.host);
  for (const [name, value] of Object.entries(headers)) request.headers.set(name, value);
  return directExternalFetch(state.externalOutbound, request);
}

async function fetchCorsPreflight(state: PreparedOutboundState) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("kitesurf: preflight headers timeout")),
    EGRESS_HEADERS_TIMEOUT_MS,
  );
  const signal = preflightAbortSignal(state.forwardRequest, controller);
  try {
    return await corsPreflight(
      {
        url: state.forwardRequest.url,
        method: state.forwardRequest.method,
        unsafeNames: state.authorUnsafeHeaders,
        requestOrigin: state.pageOrigin || "null",
        credentialsInclude: state.credentialsInclude,
        userAgent: state.forwardRequest.headers.get("user-agent") ?? BROWSER_UA,
        referer: state.forwardRequest.headers.get("referer"),
        signal,
        cacheable: !state.hostEgress,
      },
      (request) => preflightOutboundHeaders(state, request),
    );
  } finally {
    clearTimeout(timer);
  }
}

function preflightBlockedResponse(
  state: PreparedOutboundState,
  verdict: Awaited<ReturnType<typeof corsPreflight>>,
): Response | null {
  if (!verdict.reason) return null;
  failTrackedRequest(state.tracker, state.requestId, verdict.reason);
  return blocked(
    `kitesurf: Access to fetch at '${state.target.href}' from origin '${state.pageOrigin}' has been blocked by CORS policy: ` +
      `Response to preflight request doesn't pass access control check` +
      (verdict.message ? ` (${verdict.message})` : "."),
    "cors",
  );
}

async function runCorsPreflightIfNeeded(state: PreparedOutboundState): Promise<Response | null> {
  if (!state.wantsPreflight || preflightCacheHit(state)) return null;
  const verdict = await fetchCorsPreflight(state);
  return preflightBlockedResponse(state, verdict);
}

type EgressResult = OutboundStep<Response>;

function egressHeadersTimeout(state: PreparedOutboundState): number {
  return state.resourceType === "Document" && state.props?.topLevelDocument === true
    ? DOCUMENT_HEADERS_TIMEOUT_MS
    : EGRESS_HEADERS_TIMEOUT_MS;
}

function reportSlowEgressHeaders(
  startedAt: number,
  request: Request,
  forwardRequest: Request,
): void {
  const duration = Date.now() - startedAt;
  if (duration <= SLOW_EGRESS_HEADERS_THRESHOLD_MS) return;
  console.warn(
    `[ks-egress] slow headers: ${duration}ms ` +
      `type=${request.headers.get("x-kitesurf-resource-type") ?? "Other"} ` +
      `url=${forwardRequest.url.slice(0, MAX_SLOW_HEADER_URL_PREVIEW_CHARS)}`,
  );
}

function egressAbortSignal(request: Request, controller: AbortController): AbortSignal {
  if (typeof AbortSignal.any !== "function" || !request.signal) return controller.signal;
  return AbortSignal.any([request.signal, controller.signal]);
}

function outboundEgressFailure(
  state: PreparedOutboundState,
  controller: AbortController,
  timeoutMs: number,
  error: unknown,
): EgressResult {
  failTrackedRequest(
    state.tracker,
    state.requestId,
    error instanceof Error ? error.message : String(error),
  );
  if (controller.signal.aborted) {
    return {
      kind: "respond",
      response: blocked(`kitesurf: egress timeout after ${timeoutMs}ms`, "egress-timeout"),
    };
  }
  throw error;
}

async function fetchOutboundEgress(state: PreparedOutboundState): Promise<EgressResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutMs = egressHeadersTimeout(state);
  const timer = setTimeout(
    () => controller.abort(new Error(`kitesurf: egress headers timeout after ${timeoutMs}ms`)),
    timeoutMs,
  );
  const signal = egressAbortSignal(state.forwardRequest, controller);
  try {
    const response = await directExternalFetch(
      state.externalOutbound,
      new Request(state.forwardRequest, { signal }),
    );
    clearTimeout(timer);
    reportSlowEgressHeaders(startedAt, state.request, state.forwardRequest);
    return { kind: "continue", value: response };
  } catch (error) {
    clearTimeout(timer);
    return outboundEgressFailure(state, controller, timeoutMs, error);
  }
}

function isRedirectResponse(response: Response): boolean {
  return REDIRECT_STATUSES.has(response.status) && (response.headers.get("location") ?? "") !== "";
}

function isEmptyLocationRedirect(response: Response): boolean {
  return REDIRECT_STATUSES.has(response.status) && response.headers.get("location") === "";
}

function stylesheetCorsVerdict(
  state: PreparedOutboundState,
  response: Response,
): "clean" | "opaque" {
  if (!state.crossOriginNow) return "clean";
  const corsAllowed =
    state.stylesheetCorsMode === "cors" &&
    corsCheck(response.headers, state.pageOrigin || "null", state.credentialsInclude) === null;
  return corsAllowed ? "clean" : "opaque";
}

function scriptCorsVerdict(state: PreparedOutboundState): "clean" | "opaque" {
  return !state.crossOriginNow || state.scriptCorsMode === "cors" ? "clean" : "opaque";
}

function outboundResponseCorsVerdict(
  state: PreparedOutboundState,
  response: Response,
): "clean" | "opaque" | null {
  if (state.resourceType === "Stylesheet") return stylesheetCorsVerdict(state, response);
  if (state.resourceType === "Script") return scriptCorsVerdict(state);
  return null;
}

function shouldReduceToOpaque(state: PreparedOutboundState, isRedirect: boolean): boolean {
  return state.opaqueNoCors && !isRedirect;
}

function shouldShellRedirect(state: PreparedOutboundState, isRedirect: boolean): boolean {
  return isRedirect && state.crossOriginNow && state.props?.walksOwnRedirects !== true;
}

function shouldWithholdImage(state: PreparedOutboundState, isRedirect: boolean): boolean {
  return (
    state.resourceType === "Image" &&
    !isRedirect &&
    state.crossOriginNow &&
    state.opaqueResourceBypass
  );
}

function shouldInterceptFont(
  state: PreparedOutboundState,
  response: Response,
  isRedirect: boolean,
): boolean {
  return state.resourceType === "Font" && !isRedirect && response.ok && response.body !== null;
}

function createOutboundResponseState(
  state: PreparedOutboundState,
  response: Response,
): OutboundResponseState {
  const isRedirect = isRedirectResponse(response);
  const responseState: OutboundResponseState = {
    ...state,
    response,
    isRedirect,
    emptyLocationRedirect: isEmptyLocationRedirect(response),
    reduceToOpaque: shouldReduceToOpaque(state, isRedirect),
    shellRedirect: shouldShellRedirect(state, isRedirect),
    withholdImage: shouldWithholdImage(state, isRedirect),
    interceptFont: shouldInterceptFont(state, response, isRedirect),
    shapeFont: false,
    corsVerdict: null,
  };
  responseState.shapeFont = responseState.interceptFont && state.props?.pixelFree === true;
  responseState.corsVerdict = outboundResponseCorsVerdict(state, response);
  return responseState;
}

function saveResponseCookies(state: OutboundResponseState): void {
  if (!state.jar || !state.sendCredentials) return;
  try {
    const cookies = responseSetCookies(state.response);
    for (const cookie of cookies) {
      storeResponseCookie(state, cookie);
    }
  } catch {}
}

function responseSetCookies(response: Response): string[] {
  if (typeof response.headers.getSetCookie !== "function") return [];
  return response.headers.getSetCookie();
}

function storeResponseCookie(state: OutboundResponseState, cookie: string): void {
  if (typeof cookie !== "string" || cookie.length === 0) return;
  state.jar?.setFromHeader(state.forwardRequest.url, cookie);
}

function isCorpViolation(state: OutboundResponseState, corp: string): boolean {
  try {
    const target = new URL(state.forwardRequest.url);
    const page = new URL(state.pageOrigin);
    if (originKey(target) === originKey(page)) return false;
    return (
      corp === "same-origin" ||
      target.protocol !== page.protocol ||
      siteKey(target.hostname) !== siteKey(page.hostname)
    );
  } catch {
    return true;
  }
}

function shouldCheckCorp(state: OutboundResponseState): boolean {
  return state.corpApplies && state.pageOrigin !== "";
}

function supportedCorpPolicy(value: string): boolean {
  return value === "same-origin" || value === "same-site";
}

function corpResponseFailure(state: OutboundResponseState): Response | null {
  if (!shouldCheckCorp(state)) return null;
  const corp = (state.response.headers.get("cross-origin-resource-policy") ?? "").trim();
  if (!supportedCorpPolicy(corp)) return null;
  if (!isCorpViolation(state, corp)) return null;
  failTrackedRequest(state.tracker, state.requestId, "corp-blocked");
  return blocked(
    `kitesurf: Access to fetch at '${state.forwardRequest.url}' from origin '${state.pageOrigin}' has been blocked by Cross-Origin-Resource-Policy: ${corp}.`,
    "cors",
  );
}

function corsResponseFailure(state: OutboundResponseState): Response | null {
  if (!state.needsCorsCheck) return null;
  const failure = checkCorsResponse(
    state.response,
    state.pageOrigin,
    state.target,
    state.credentialsInclude,
  );
  if (failure === null) return null;
  failTrackedRequest(state.tracker, state.requestId, failure.reason);
  return blocked(failure.message, "cors");
}

function redirectHasCredentials(location: string, baseUrl: string): boolean {
  try {
    const target = new URL(location, baseUrl);
    return target.username !== "" || target.password !== "";
  } catch {
    return false;
  }
}

function corsRedirectFailure(state: OutboundResponseState): Response | null {
  if (!state.needsCorsCheck || !state.isRedirect) return null;
  const location = state.response.headers.get("location");
  if (!location || !redirectHasCredentials(location, state.forwardRequest.url)) return null;
  failTrackedRequest(state.tracker, state.requestId, "cors-redirect-userinfo");
  return blocked(
    `kitesurf: Redirect from '${state.forwardRequest.url}' to a URL containing credentials is not allowed for a CORS request.`,
    "cors",
  );
}

function validateOutboundResponse(state: OutboundResponseState): Response | null {
  const corpFailure = corpResponseFailure(state);
  if (corpFailure !== null) return corpFailure;
  const corsFailure = corsResponseFailure(state);
  if (corsFailure !== null) return corsFailure;
  return corsRedirectFailure(state);
}

function shouldApplyPixelBodyDeadline(state: OutboundResponseState): boolean {
  return (
    isPixelResource(state.resourceType) &&
    !state.isRedirect &&
    state.response.body !== null &&
    isValidResponseStatus(state.response.status)
  );
}

function isPixelResource(resourceType: string): boolean {
  return resourceType === "Image" || resourceType === "Media";
}

function isValidResponseStatus(status: number): boolean {
  return status >= 200 && status <= 599;
}

function boundPixelResponseBody(state: OutboundResponseState): void {
  const body = state.response.body;
  if (body === null || !shouldApplyPixelBodyDeadline(state)) return;
  state.response = new Response(withDeadline(body, PIXEL_BODY_DEADLINE_MS), state.response);
}

function rebuildOutboundResponse(out: Response, body: BodyInit | null, headers: Headers): Response {
  return new Response(body, {
    status: out.status,
    statusText: out.statusText,
    headers,
  });
}

function stampScriptSecurity(state: OutboundResponseState, source: Headers, output: Headers): void {
  if (state.resourceType !== "Script") return;
  const nosniff = source.get("x-content-type-options");
  if (nosniff) output.set(KITESURF_NOSNIFF_HEADER, nosniff);
  if (state.corsVerdict !== null) output.set(KITESURF_CORS_VERDICT_HEADER, state.corsVerdict);
}

function exposedResponseHeaders(state: OutboundResponseState, headers: Headers): Headers {
  if (!state.needsCorsCheck || state.isRedirect) return headers;
  const filtered = scrubKitesurfNamespace(
    filterCorsResponseHeaders(headers, state.credentialsInclude),
  );
  if (state.emptyLocationRedirect) filtered.set("location", "");
  stampScriptSecurity(state, headers, filtered);
  return filtered;
}

function stampedSheetCorsHeaders(state: OutboundResponseState, headers: Headers): Headers {
  if (state.corsVerdict === null) return headers;
  const output = scrubKitesurfNamespace(headers);
  output.set(KITESURF_CORS_VERDICT_HEADER, state.corsVerdict);
  stampScriptSecurity(state, headers, output);
  return output;
}

type BufferedOutboundBody =
  | { kind: "bytes"; bytes: Uint8Array }
  | { kind: "rest"; body: ReadableStream<Uint8Array> };

async function fontBodyBytes(
  out: Response,
  buffered: ArrayBuffer | null,
): Promise<BufferedOutboundBody> {
  if (buffered !== null) return { kind: "bytes", bytes: new Uint8Array(buffered) };
  const capped = await readCapped(out.body, MAX_SHAPED_FONT_BYTES);
  if (capped.bytes === null) return { kind: "rest", body: capped.rest };
  return { kind: "bytes", bytes: capped.bytes };
}

async function shapeOutboundFont(
  bytes: Uint8Array,
  env: SandboxOutboundEnv,
): Promise<Uint8Array | null> {
  try {
    return await shapeFontBytes(bytes, env.HOST_TRACER);
  } catch {
    return null;
  }
}

function shouldStoreFontKey(state: OutboundResponseState): boolean {
  return !state.shapeFont && !state.foreignIsolate;
}

function storeAuthorFontKey(
  state: OutboundResponseState,
  bytes: Uint8Array,
  headers: Headers,
): void {
  if (!shouldStoreFontKey(state)) return;
  const key = putAuthorFont(bytes, state.connectionId, state.props?.mainFrameId ?? "");
  if (key !== null) headers.set(FONT_KEY_HEADER, key.toString());
}

async function shapeFontResponseBytes(
  state: OutboundResponseState,
  out: Response,
  bytes: Uint8Array,
  headers: Headers,
): Promise<Response> {
  storeAuthorFontKey(state, bytes, headers);
  if (!state.shapeFont) return rebuildOutboundResponse(out, bytes, headers);
  const shaped = await shapeOutboundFont(bytes, state.env);
  if (shaped === null) return rebuildOutboundResponse(out, bytes, headers);
  headers.delete("content-length");
  headers.set("content-type", "font/otf");
  return rebuildOutboundResponse(out, shaped, headers);
}

async function shapedFontResponse(
  state: OutboundResponseState,
  out: Response,
  buffered: ArrayBuffer | null,
): Promise<Response> {
  const body = await fontBodyBytes(out, buffered);
  if (body.kind === "rest") {
    return rebuildOutboundResponse(out, body.body, exposedResponseHeaders(state, out.headers));
  }
  return shapeFontResponseBytes(
    state,
    out,
    body.bytes,
    new Headers(exposedResponseHeaders(state, out.headers)),
  );
}

function opaqueImageShell(out: Response, extra: Record<string, string> = {}): Response {
  return new Response(null, {
    status: out.status,
    statusText: out.statusText,
    headers: extra,
  });
}

async function imageBodyBytes(
  out: Response,
  buffered: ArrayBuffer | null,
): Promise<BufferedOutboundBody> {
  if (buffered !== null) return { kind: "bytes", bytes: new Uint8Array(buffered) };
  const capped = await readCapped(out.body, MAX_ENTRY_BYTES);
  if (capped.bytes === null) return { kind: "rest", body: capped.rest };
  return { kind: "bytes", bytes: capped.bytes };
}

function warnIfOpaqueImageIsNotImage(state: OutboundResponseState, bytes: Uint8Array): void {
  if (looksLikeSvg(bytes)) return;
  console.warn(
    `[ks-outbound] resource-type Image on a non-image body: ${state.forwardRequest.url}`,
  );
}

function opaqueImageResourceResponse(
  state: OutboundResponseState,
  out: Response,
  bytes: Uint8Array,
): Response {
  const dimensions = sniffImageDims(bytes);
  if (dimensions === null) {
    warnIfOpaqueImageIsNotImage(state, bytes);
    return opaqueImageShell(out);
  }
  const key = putOpaqueImage(bytes, state.connectionId, state.props?.mainFrameId ?? "");
  if (!key) return opaqueImageShell(out);
  return opaqueImageShell(out, {
    [RESOURCE_KEY_HEADER]: key.toString(),
    [IMAGE_WIDTH_HEADER]: String(dimensions.width),
    [IMAGE_HEIGHT_HEADER]: String(dimensions.height),
  });
}

async function withheldImageResponse(
  state: OutboundResponseState,
  out: Response,
  buffered: ArrayBuffer | null,
): Promise<Response> {
  const body = await imageBodyBytes(out, buffered);
  if (body.kind === "rest") {
    void body.body.cancel();
    return opaqueImageShell(out);
  }
  return opaqueImageResourceResponse(state, out, body.bytes);
}

function capturedBodySpecialResponse(
  state: OutboundResponseState,
  out: Response,
  body: ArrayBuffer,
): Response | Promise<Response> | null {
  if (state.reduceToOpaque) return opaqueResponse();
  if (state.withholdImage) return withheldImageResponse(state, out, body);
  if (state.interceptFont) return shapedFontResponse(state, out, body);
  if (state.shellRedirect) return redirectShell(out);
  return null;
}

async function responseForCapturedBody(
  state: OutboundResponseState,
  out: Response,
  body: ArrayBuffer,
): Promise<Response> {
  const special = await capturedBodySpecialResponse(state, out, body);
  if (special !== null) return special;
  if (!state.needsCorsCheck || state.isRedirect) {
    return new Response(body, {
      status: out.status,
      statusText: out.statusText,
      headers: stampedSheetCorsHeaders(state, out.headers),
    });
  }
  return corsFilteredResponse(out, body, exposedResponseHeaders(state, out.headers));
}

async function runOutboundPolicy(state: OutboundPolicyState): Promise<Response> {
  const earlyResponse = earlyOutboundPolicyResponse(state);
  if (earlyResponse !== null) return earlyResponse;
  if (isWebSocketRequest(state.request)) return fetchOutboundWebSocket(state);
  return fetchPreparedOutboundRequest(state);
}

async function fetchPreparedOutboundRequest(state: OutboundPolicyState): Promise<Response> {
  const prepared = await prepareOutboundRequest(state);
  if (prepared.kind === "respond") return prepared.response;
  return continuePreparedOutboundRequest(prepared.value);
}

async function continuePreparedOutboundRequest(state: PreparedOutboundState): Promise<Response> {
  const intercepted = await interceptOutboundRequest(state);
  if (intercepted !== null) return intercepted;
  const preflight = await runCorsPreflightIfNeeded(state);
  if (preflight !== null) return preflight;
  const egress = await fetchOutboundEgress(state);
  if (egress.kind === "respond") return egress.response;
  return finishOutboundResponse(state, egress.value);
}

async function finishOutboundResponse(
  state: PreparedOutboundState,
  response: Response,
): Promise<Response> {
  const responseState = createOutboundResponseState(state, response);
  saveResponseCookies(responseState);
  const failure = validateOutboundResponse(responseState);
  if (failure !== null) return failure;
  boundPixelResponseBody(responseState);
  return captureAndFilterOutboundResponse(responseState);
}

async function captureAndFilterOutboundResponse(state: OutboundResponseState): Promise<Response> {
  const captured = await captureTrackedOutboundResponse(state);
  if (captured !== null) return captured;
  return finalOutboundResponse(state);
}

function completeTrackedOutboundResponse(
  state: OutboundResponseState,
  mimeType: string,
  bodyLength: number,
  body?: string,
): void {
  if (!state.requestId || !state.tracker) return;
  const response = state.response;
  const common = {
    url: state.request.url,
    status: response.status,
    statusText: response.statusText,
    headers: headersToRecord(response.headers),
    mimeType,
    bodyLength,
  };
  state.tracker.completeRequest(
    state.requestId,
    body === undefined ? common : { ...common, body, bodyBase64Encoded: false },
  );
}

function shouldCaptureOutboundBody(state: OutboundResponseState, mimeType: string): boolean {
  return (
    isTextLikeMime(mimeType) &&
    state.response.body !== null &&
    state.tracker?.retainsBodies() === true
  );
}

function normalizedResponseMimeType(header: string): string {
  const mediaType = (header.split(";")[0] ?? "").trim();
  return mediaType || "application/octet-stream";
}

function responseContentLength(response: Response): number {
  return Number(response.headers.get("content-length") ?? "0") || 0;
}

function networkResponseMimeType(response: Response): { mimeType: string; contentLength: number } {
  return {
    mimeType: normalizedResponseMimeType(response.headers.get("content-type") ?? ""),
    contentLength: responseContentLength(response),
  };
}

async function captureTrackedOutboundResponse(
  state: OutboundResponseState,
): Promise<Response | null> {
  if (!state.requestId || !state.tracker) return null;
  const { mimeType, contentLength } = networkResponseMimeType(state.response);
  if (!shouldCaptureOutboundBody(state, state.response.headers.get("content-type") ?? "")) {
    completeTrackedOutboundResponse(state, mimeType, contentLength);
    return null;
  }
  return captureTrackedOutboundBody(state, mimeType, contentLength);
}

async function replayUncapturedOutboundBody(
  state: OutboundResponseState,
  mimeType: string,
  contentLength: number,
  rest: ReadableStream<Uint8Array>,
): Promise<null> {
  const response = state.response;
  state.response = new Response(rest, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  completeTrackedOutboundResponse(state, mimeType, contentLength);
  return null;
}

async function captureTrackedOutboundBody(
  state: OutboundResponseState,
  mimeType: string,
  contentLength: number,
): Promise<Response | null> {
  try {
    const capped = await readCapped(state.response.body, RESPONSE_BODY_BUFFER_CAP);
    if (capped.bytes === null) {
      return await replayUncapturedOutboundBody(state, mimeType, contentLength, capped.rest);
    }
    const body = capped.bytes.buffer;
    const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(body);
    completeTrackedOutboundResponse(state, mimeType, contentLength || body.byteLength, text);
    return await responseForCapturedBody(state, state.response, body);
  } catch {
    completeTrackedOutboundResponse(state, mimeType, contentLength);
    return null;
  }
}

function outboundSpecialResponse(
  state: OutboundResponseState,
): Response | Promise<Response> | null {
  if (state.reduceToOpaque) return opaqueResponse();
  if (state.withholdImage) return withheldImageResponse(state, state.response, null);
  if (state.interceptFont) return shapedFontResponse(state, state.response, null);
  if (state.shellRedirect) return redirectShell(state.response);
  return null;
}

function responseWithoutCorsCheck(state: OutboundResponseState): Response {
  const response = state.response;
  if (state.corsVerdict === null) return response;
  if (response.status < 200 || response.status > 599) {
    return corsFilteredResponse(response, response.body, scrubKitesurfNamespace(response.headers));
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: stampedSheetCorsHeaders(state, response.headers),
  });
}

function corsFilteredOutboundResponse(state: OutboundResponseState): Response {
  if (!state.needsCorsCheck || state.isRedirect) return responseWithoutCorsCheck(state);
  return corsFilteredResponse(
    state.response,
    state.response.body,
    exposedResponseHeaders(state, state.response.headers),
  );
}

async function finalOutboundResponse(state: OutboundResponseState): Promise<Response> {
  const special = outboundSpecialResponse(state);
  if (special !== null) return special;
  return corsFilteredOutboundResponse(state);
}

function opaqueResponse(): Response {
  return new Response(null, { status: 200, statusText: "", headers: {} });
}

export function corsFilteredResponse(
  resp: Response,
  body: BodyInit | null,
  headers: Headers,
): Response {
  if (resp.status >= 200 && resp.status <= 599) {
    return new Response(body, {
      status: resp.status,
      statusText: resp.statusText,
      headers,
    });
  }
  const carried = new Headers(headers);
  carried.set(CARRIED_STATUS_HEADER, String(resp.status));
  return new Response(body, {
    status: STATUS_CARRIER,
    statusText: resp.statusText,
    headers: carried,
  });
}

const RESPONSE_BODY_BUFFER_CAP = 256 * 1024;

function redirectShell(resp: Response): Response {
  const headers = new Headers();
  const location = resp.headers.get("location");
  if (location !== null) headers.set("location", location);
  return new Response(null, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

function scrubKitesurfNamespace(headers: Headers): Headers {
  const out = new Headers(headers);
  for (const name of [...out.keys()]) {
    if (name.startsWith("x-kitesurf-")) out.delete(name);
  }
  return out;
}

function blocked(message: string, reason: string): Response {
  return new Response(message, {
    status: 403,
    headers: {
      "x-kitesurf-blocked": reason,
      "content-type": "text/plain;charset=utf-8",
    },
  });
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

interface CorsFailure {
  reason: string;
  message: string;
}

function checkCorsResponse(
  resp: Response,
  pageOrigin: string,
  target: URL,
  credentialsInclude: boolean,
): CorsFailure | null {
  const requestOrigin = pageOrigin || "null";
  const reason = corsCheck(resp.headers, requestOrigin, credentialsInclude);
  if (reason === null) return null;
  const prefix = `kitesurf: Access to fetch at '${target.href}' from origin '${pageOrigin}' has been blocked by CORS policy: `;
  const aca = (resp.headers.get("access-control-allow-origin") ?? "").trim();
  return { reason, message: corsFailureMessage(reason, prefix, aca, resp.headers) };
}

function corsFailureMessage(reason: string, prefix: string, aca: string, headers: Headers): string {
  switch (reason) {
    case "cors-missing-origin":
      return (
        prefix + `No 'Access-Control-Allow-Origin' header is present on the requested resource.`
      );
    case "cors-multiple-origins":
      return (
        prefix +
        `The 'Access-Control-Allow-Origin' header contains multiple values '${aca}', but only one is allowed.`
      );
    case "cors-wildcard-with-credentials":
      return (
        prefix +
        `The value of the 'Access-Control-Allow-Origin' header must not be the wildcard '*' when the request's credentials mode is 'include'.`
      );
    case "cors-credentials-not-allowed":
      return (
        prefix +
        `The value of the 'Access-Control-Allow-Credentials' header in the response is '` +
        `${headers.get("access-control-allow-credentials") ?? ""}' which must be 'true' ` +
        `when the request's credentials mode is 'include'.`
      );
    default:
      return (
        prefix +
        `The 'Access-Control-Allow-Origin' header has a value '${aca}' that is not equal to the supplied origin.`
      );
  }
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const POST_DATA_CAP_BYTES = 8 * 1024 * 1024;

interface CappedBodyChunks {
  chunks: Uint8Array[];
  totalBytes: number;
}

type BodyChunkResult = "continue" | "done" | "overflow";

function contentLengthExceedsCap(request: Request, capBytes: number): boolean {
  const contentLength = Number(request.headers.get("content-length") ?? "");
  return Number.isFinite(contentLength) && contentLength > capBytes;
}

async function readCappedBodyChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  collected: CappedBodyChunks,
  capBytes: number,
): Promise<BodyChunkResult> {
  const { done, value } = await reader.read();
  if (done) return "done";
  if (!value) return "continue";
  const totalBytes = collected.totalBytes + value.byteLength;
  if (totalBytes > capBytes) {
    await reader.cancel().catch(() => {});
    return "overflow";
  }
  collected.totalBytes = totalBytes;
  collected.chunks.push(value);
  return "continue";
}

async function collectCappedBodyChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  capBytes: number,
): Promise<CappedBodyChunks | null> {
  const collected: CappedBodyChunks = { chunks: [], totalBytes: 0 };
  try {
    for (;;) {
      const result = await readCappedBodyChunk(reader, collected, capBytes);
      if (result === "done") return collected;
      if (result === "overflow") return null;
    }
  } catch {
    return null;
  }
}

function decodeCappedBodyChunks(collected: CappedBodyChunks): string {
  const all = new Uint8Array(collected.totalBytes);
  let offset = 0;
  for (const chunk of collected.chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

async function readBodyCapped(req: Request, capBytes: number): Promise<string | undefined> {
  if (contentLengthExceedsCap(req, capBytes)) return undefined;
  const body = req.clone().body;
  if (!body) return undefined;
  const collected = await collectCappedBodyChunks(body.getReader(), capBytes);
  if (collected === null) return undefined;
  return decodeCappedBodyChunks(collected);
}

interface BuildForwardRequestOptions {
  original: Request;
  resourceType: string;
  pageOrigin: string;
  extraHeaders: Record<string, string>;
  pageUrl?: string;
  referrerPolicy?: string;
  wbaHeaders?: Record<string, string>;
  corsMode?: boolean;
}

function copyPageRequestHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const [name, value] of request.headers.entries()) {
    if (name.toLowerCase().startsWith("x-kitesurf-")) continue;
    headers.set(name, value);
  }
  return headers;
}

function setDefaultAgentHeader(headers: Headers): void {
  if (!headers.has("user-agent")) headers.set("user-agent", BROWSER_UA);
}

function setDefaultAcceptHeader(headers: Headers, resourceType: string): void {
  if (!headers.has("accept")) headers.set("accept", defaultAcceptFor(resourceType));
}

function setOpaqueOriginHeader(headers: Headers, pageOrigin: string): void {
  if (!headers.has("origin") && !pageOrigin) headers.set("origin", "null");
}

function setCorsOriginHeader(headers: Headers, pageOrigin: string, corsMode: boolean): void {
  if (corsMode) headers.set("origin", pageOrigin || "null");
}

function setDefaultForwardHeaders(
  headers: Headers,
  resourceType: string,
  pageOrigin: string,
  corsMode: boolean,
): void {
  setDefaultAgentHeader(headers);
  setDefaultAcceptHeader(headers, resourceType);
  setOpaqueOriginHeader(headers, pageOrigin);
  setCorsOriginHeader(headers, pageOrigin, corsMode);
}

function referrerMatchesPageOrigin(raw: string, pageOrigin: string): string {
  try {
    return new URL(raw).origin === pageOrigin ? raw : "";
  } catch {
    return "";
  }
}

function pageRequestReferrer(original: Request, pageOrigin: string): string {
  const raw = original.headers.get("x-kitesurf-referrer") ?? "";
  if (raw === "" || raw === "no-referrer") return raw;
  if (!pageOrigin) return "";
  return referrerMatchesPageOrigin(raw, pageOrigin);
}

function originOnlyReferrer(pageOrigin: string): string {
  return pageOrigin.endsWith("/") ? pageOrigin : pageOrigin + "/";
}

function referrerCarrier(
  requestReferrer: string,
  policy: ReturnType<typeof parseReferrerPolicy>,
  originOnly: string,
): string | null {
  if (!requestReferrer) return null;
  if (policy === "origin") return originOnly;
  try {
    const referrer = new URL(requestReferrer);
    referrer.hash = "";
    referrer.username = "";
    referrer.password = "";
    return referrer.href;
  } catch {
    return null;
  }
}

function pageReferrerSource(
  pageUrl: string | undefined,
  pageOrigin: string,
  originOnly: string,
): string {
  if (!pageUrl) return originOnly;
  try {
    return new URL(pageUrl).origin === pageOrigin ? pageUrl : originOnly;
  } catch {
    return originOnly;
  }
}

function shouldSetForwardReferrer(
  headers: Headers,
  pageOrigin: string,
  policy: ReturnType<typeof parseReferrerPolicy>,
  requestReferrer: string,
): boolean {
  return (
    !headers.has("referer") &&
    pageOrigin !== "" &&
    policy !== "no-referrer" &&
    requestReferrer !== "no-referrer"
  );
}

function setForwardReferrer(
  headers: Headers,
  original: Request,
  pageOrigin: string,
  pageUrl: string | undefined,
  policy: ReturnType<typeof parseReferrerPolicy>,
  requestReferrer: string,
): void {
  if (!shouldSetForwardReferrer(headers, pageOrigin, policy, requestReferrer)) return;
  const originOnly = originOnlyReferrer(pageOrigin);
  const carrier = referrerCarrier(requestReferrer, policy, originOnly);
  const source = pageReferrerSource(pageUrl, pageOrigin, originOnly);
  const value = carrier ?? determineReferrer(source, original.url, policy);
  if (value) headers.set("referer", value);
}

function isSameOriginPageRequest(original: Request, pageOrigin: string): boolean {
  if (!pageOrigin) return false;
  try {
    return new URL(original.url).origin === new URL(pageOrigin).origin;
  } catch {
    return false;
  }
}

function isCredentialHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "authorization" || lower === "cookie";
}

function addExtraForwardHeaders(
  headers: Headers,
  extraHeaders: Record<string, string>,
  sameOrigin: boolean,
): void {
  for (const [name, value] of Object.entries(extraHeaders)) {
    // Restrict CDP extra Authorization and Cookie headers to same-origin requests.
    if (!sameOrigin && isCredentialHeader(name)) continue;
    headers.set(name, value);
  }
}

function setForwardAcceptEncoding(headers: Headers): void {
  headers.set(
    "accept-encoding",
    decodableAcceptEncoding(headers.get("accept-encoding"), headers.has("range")),
  );
}

function addWbaForwardHeaders(headers: Headers, wbaHeaders: Record<string, string>): void {
  for (const [name, value] of Object.entries(wbaHeaders)) {
    headers.set(name, value);
  }
}

function forwardRequestHeaders(options: BuildForwardRequestOptions): Headers {
  const {
    original,
    resourceType,
    pageOrigin,
    extraHeaders,
    pageUrl,
    referrerPolicy,
    wbaHeaders = {},
    corsMode = false,
  } = options;
  const headers = copyPageRequestHeaders(original);
  setDefaultForwardHeaders(headers, resourceType, pageOrigin, corsMode);
  const policy = parseReferrerPolicy(referrerPolicy);
  const requestReferrer = pageRequestReferrer(original, pageOrigin);
  setForwardReferrer(headers, original, pageOrigin, pageUrl, policy, requestReferrer);
  if (!headers.has("accept-language")) headers.set("accept-language", "en-US,en;q=0.9");
  addExtraForwardHeaders(headers, extraHeaders, isSameOriginPageRequest(original, pageOrigin));
  setForwardAcceptEncoding(headers);
  addWbaForwardHeaders(headers, wbaHeaders);
  return headers;
}

export function buildForwardRequest({
  original,
  resourceType,
  pageOrigin,
  extraHeaders,
  pageUrl,
  referrerPolicy,
  wbaHeaders = {},
  corsMode = false,
}: BuildForwardRequestOptions): Request {
  const headers = forwardRequestHeaders({
    original,
    resourceType,
    pageOrigin,
    extraHeaders,
    pageUrl,
    referrerPolicy,
    wbaHeaders,
    corsMode,
  });
  return new Request(original.url, {
    method: original.method,
    headers,
    body: original.body,
    redirect: "manual",
    signal: original.signal,
  });
}

const ACCEPT_ENCODING = "gzip, br";
const DECODABLE_CODINGS = new Set(["gzip", "br", "identity"]);

export function decodableAcceptEncoding(value: string | null, hasRange: boolean): string {
  if (value !== null && value.split(",").every(acceptsOnlyDecodable)) {
    return value;
  }
  return hasRange ? "identity" : ACCEPT_ENCODING;
}

function acceptsOnlyDecodable(entry: string): boolean {
  const [coding = "", ...params] = entry.trim().toLowerCase().split(";");
  if (DECODABLE_CODINGS.has(coding.trim())) return true;
  return params.some((p) => /^\s*q\s*=\s*0(\.0{0,3})?\s*$/.test(p));
}

function defaultAcceptFor(resourceType: string): string {
  switch (resourceType) {
    case "Stylesheet":
      return "text/css,*/*;q=0.1";
    case "Image":
      return "image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";
    case "Font":
      return "*/*";
    case "Media":
      return "*/*";
    case "Script":
      return "*/*";
    case "Document":
      return "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8";
    default:
      return "*/*";
  }
}
