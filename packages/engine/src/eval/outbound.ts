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
import { traceSpan, type Tracer } from "../tracing.ts";
import { LocalTracer } from "../tracing-local.ts";
import {
  getInterception,
  interceptionMatches,
  registerParked,
  awaitVerdict,
  errorReasonToNet,
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
  // The host's egress transport; unlike externalOutbound, it keeps the engine's egress policy.
  egress?: ExternalOutbound;
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
function assetCacheStore(path: string, bytes: Uint8Array): void {
  if (bytes.byteLength > ASSET_CACHE_MAX_ENTRY_BYTES) return;
  const prior = assetCache.get(path);
  if (prior) {
    assetCache.delete(path);
    assetCacheBytes -= prior.byteLength;
  }
  while (assetCacheBytes + bytes.byteLength > ASSET_CACHE_MAX_TOTAL_BYTES && assetCache.size > 0) {
    const oldest = assetCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const evicted = assetCache.get(oldest);
    assetCache.delete(oldest);
    assetCacheBytes -= evicted ? evicted.byteLength : 0;
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
  if (
    !subresourceSpanCounts.has(key) &&
    subresourceSpanCounts.size >= MAX_SUBRESOURCE_SPAN_CONNECTIONS
  ) {
    const oldest = subresourceSpanCounts.keys().next().value;
    if (oldest !== undefined) subresourceSpanCounts.delete(oldest);
  }
  subresourceSpanCounts.set(key, n + 1);
  return true;
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

/** Outbound props a caller supplies; the override seals in the connection's outbound hooks. */
export type CallerOutboundProps = Omit<OutboundProps, "externalOutbound" | "egress">;

export interface SandboxOutboundOverride {
  readonly external: boolean;
  parent(props: CallerOutboundProps): Fetcher;
  loaded(props: CallerOutboundProps): Fetcher;
  session(props: CallerOutboundProps): SessionOutbound;
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
  let body = resp.body;
  if (resp.status < 200) {
    void body?.cancel().catch(() => {});
    if (resp.status !== 101) throw new TypeError("Failed to fetch");
    body = null;
  }
  return corsFilteredResponse(resp, body, new Headers(resp.headers));
}

export function createSandboxOutboundOverride(
  exports: SandboxOutboundExports,
  env: SandboxOutboundEnv,
  externalOutbound?: ExternalOutbound,
  egress?: ExternalOutbound,
): SandboxOutboundOverride {
  const seal = (props: CallerOutboundProps): OutboundProps => ({
    ...props,
    externalOutbound,
    egress: externalOutbound ? undefined : egress,
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
      return directExternalFetch(externalOutbound ?? egress, request);
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
    if (conn) {
      outboundInflight.set(conn, (outboundInflight.get(conn) ?? 0) + 1);
    }
    try {
      return await SandboxOutbound.fetchTraced(env, props, request);
    } finally {
      if (conn) {
        const n = (outboundInflight.get(conn) ?? 1) - 1;
        if (n <= 0) outboundInflight.delete(conn);
        else outboundInflight.set(conn, n);
      }
    }
  }

  private static async fetchTraced(
    env: SandboxOutboundEnv,
    props: OutboundProps | undefined,
    request: Request,
  ): Promise<Response> {
    const tracer = env.HOST_TRACER;
    if (!tracer) return SandboxOutbound.fetchPolicy(env, props, request);
    if (tracer.getSpanContext() === null) {
      const stamped = props?.localTraceParent;
      if (!(tracer instanceof LocalTracer) || !stamped) {
        return SandboxOutbound.fetchPolicy(env, props, request);
      }
      return tracer.runWithSpanContext(stamped, () =>
        SandboxOutbound.fetchSpanned(env, props, tracer, request),
      );
    }
    return SandboxOutbound.fetchSpanned(env, props, tracer, request);
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
    let host = "";
    let path = "";
    try {
      const u = new URL(request.url);
      host = u.hostname;
      path = u.pathname;
    } catch {}
    return traceSpan(
      tracer,
      "subresource.fetch",
      async (s) => {
        const resp = await SandboxOutbound.fetchPolicy(env, props, request);
        if (s && s.isRecording) {
          s.setTags({
            status: resp.status,
            contentLength: resp.headers.get("content-length") ?? "",
            blocked: resp.headers.get("x-kitesurf-blocked") ?? "",
          });
        }
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
    let parsedUrl: URL | null = null;
    try {
      parsedUrl = new URL(request.url);
    } catch {}
    if (parsedUrl && parsedUrl.hostname === ASSET_SENTINEL_HOST) {
      return SandboxOutbound.fetchAsset(env, parsedUrl);
    }

    const sealed = !!props;
    const externalOutbound = props?.externalOutbound;
    const hostEgress = externalOutbound !== undefined;
    const transport = externalOutbound ?? props?.egress;
    const headerOrigin = request.headers.get("x-kitesurf-page-origin") ?? "";
    // "null" may narrow sealed identity to opaque; other header values cannot replace it.
    const pageOrigin =
      headerOrigin === "null" ? "" : sealed ? (props.pageOrigin ?? "") : headerOrigin;

    // SameSite keeps the sealed document origin even when CORS marks the request opaque.
    const cookieOriginSource = sealed
      ? (props.pageOrigin ?? "")
      : headerOrigin === "null"
        ? ""
        : headerOrigin;
    let cookieInitiatorHost: string | null = null;
    if (cookieOriginSource) {
      try {
        cookieInitiatorHost = new URL(cookieOriginSource).hostname;
      } catch {}
    }
    const cookieContext = { initiatorHost: cookieInitiatorHost };

    const opaqueOrigin = !pageOrigin;

    let target: URL;
    try {
      target = new URL(request.url);
    } catch {
      return blocked("kitesurf: invalid URL", "invalid-url");
    }

    let allowed: URL;
    if (opaqueOrigin) {
      allowed = new URL("https://opaque.invalid/");
    } else {
      try {
        allowed = new URL(pageOrigin);
      } catch {
        return blocked("kitesurf: invalid page origin", "invalid-page-origin");
      }
    }

    if (allowed.host === "kitesurf.local") {
      return blocked(
        "kitesurf: synthetic-origin fetch dropped (no network during bench)",
        "synthetic-origin",
      );
    }

    const targetOriginKey = originKey(target);
    const allowedOriginKey = originKey(allowed);
    const sameOrigin = !opaqueOrigin && targetOriginKey === allowedOriginKey;
    let crossOriginNow = !sameOrigin;

    const allowCrossOrigin = request.headers.get("x-kitesurf-allow-cross-origin") === "1";
    // The page's WebSocket opens through fetch() and can label its request with any type.
    const webSocketUpgrade = (request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket";
    const resourceType = webSocketUpgrade
      ? "WebSocket"
      : (request.headers.get("x-kitesurf-resource-type") ?? "");
    const scriptCorsMode = request.headers.get("x-kitesurf-script-cors") ?? "";
    const safeCrossOriginType =
      resourceType === "Image" ||
      resourceType === "Stylesheet" ||
      (resourceType === "Document" && props?.allowDocumentBypass === true) ||
      (resourceType === "Script" && scriptCorsMode === "no-cors");
    const opaqueResourceBypass = allowCrossOrigin && safeCrossOriginType;

    const stylesheetCorsMode =
      resourceType === "Stylesheet"
        ? (request.headers.get("x-kitesurf-stylesheet-cors") ?? "")
        : "";
    const sheetWantsCors = stylesheetCorsMode === "cors" && !sameOrigin;

    const noCorsMode = request.headers.get("x-kitesurf-mode") === "no-cors";
    let opaqueNoCors = noCorsMode && !sameOrigin;
    let needsCorsCheck = !sameOrigin && !opaqueResourceBypass && !noCorsMode;

    const corpApplies = noCorsMode || (resourceType === "Script" && scriptCorsMode === "no-cors");

    const credentialsHeader = request.headers.get("x-kitesurf-credentials");
    const credentialsMode: CredentialsMode | null =
      credentialsHeader === null
        ? null
        : credentialsHeader === "omit" ||
            credentialsHeader === "same-origin" ||
            credentialsHeader === "include"
          ? credentialsHeader
          : "same-origin";
    let credentialsInclude = sameOrigin
      ? credentialsMode !== "omit"
      : credentialsMode === "include";
    let sendCredentials = credentialsMode === null || credentialsInclude;

    // Classify author headers before buildForwardRequest adds browser-owned headers.
    let authorUnsafeHeaders = needsCorsCheck ? corsUnsafeRequestHeaderNames(request.headers) : [];
    let wantsPreflight = needsCorsCheck && needsPreflight(request.method, request.headers);

    const connectionId = sealed
      ? (props.connectionId ?? "")
      : (request.headers.get(CONNECTION_ID_HEADER) ?? "");
    const foreignIsolate = isForeignIsolate(props?.engineIsolateId);
    if (foreignIsolate) noteForeignIsolate(connectionId);
    const tracker = connectionId ? getTracker(connectionId) : undefined;
    const requestFrameId = sealed
      ? (props.mainFrameId ?? "")
      : (request.headers.get(FRAME_ID_HEADER) ?? "");
    const trackerAttribution = tracker?.attributionForTarget(requestFrameId);
    const networkFrameId = trackerAttribution?.frameId ?? requestFrameId;
    const networkLoaderId = trackerAttribution?.loaderId ?? props?.mainLoaderId ?? "";
    const networkSessionIds = trackerAttribution?.sessionIds ?? [];

    if (connectionId) {
      const filters = getOutboundFilters(connectionId);
      if (filters) {
        const decision = shouldBlock(filters, request.url, resourceType);
        if (decision.blocked) {
          return new Response(`kitesurf: outbound blocked — ${decision.reason}\n`, {
            status: 451,
            statusText: "Blocked by kitesurf outbound filter",
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "x-kitesurf-blocked-reason": decision.reason,
            },
          });
        }
      }
    }

    const requestBlocker =
      props?.skipRequestBlocker === true || !connectionId
        ? undefined
        : getRequestBlocker(connectionId);
    const pageHost = allowed.host === "opaque.invalid" ? "" : allowed.hostname;
    const blockType = parseResourceType(resourceType);
    const verdict = classifyRequest(requestBlocker, request.url, pageHost, blockType);
    if (verdict) {
      if (tracker) {
        const headers = headersToRecord(request.headers);
        stripKitesurfHeaders(headers);
        const requestId = tracker.beginRequest({
          url: request.url,
          method: request.method,
          headers,
          type: blockType,
          initiator: {
            type: request.headers.get("x-kitesurf-initiator") === "parser" ? "parser" : "script",
            url: pageOrigin,
          },
          loaderId: networkLoaderId,
          frameId: networkFrameId,
          sessionIds: networkSessionIds,
        });
        tracker.failRequest(requestId, "net::ERR_BLOCKED_BY_CLIENT", "subresource-filter");
      }
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

    if (webSocketUpgrade) {
      const wsHeaders = new Headers();
      wsHeaders.set("Upgrade", "websocket");
      const proto = request.headers.get("Sec-WebSocket-Protocol");
      if (proto) wsHeaders.set("Sec-WebSocket-Protocol", proto);
      // A handshake does not follow redirects, so the page's opaque-origin header has no use here.
      // A browser always sends Origin, "null" for an opaque document, and its User-Agent.
      const wsOrigin = sealed ? props.pageOrigin : pageOrigin;
      wsHeaders.set("Origin", wsOrigin || "null");
      wsHeaders.set("User-Agent", request.headers.get("user-agent") || BROWSER_UA);
      const wsCookieKey = sealed
        ? props.cookieKey || connectionId
        : request.headers.get("x-kitesurf-cookie-key") || connectionId;
      const wsJar = wsCookieKey ? getCookieJar(wsCookieKey) : undefined;
      if (wsJar) {
        const cookieHeader = wsJar.cookieHeaderForUrl(request.url, cookieContext);
        if (cookieHeader) wsHeaders.set("cookie", cookieHeader);
      }
      return directExternalFetch(
        transport,
        new Request(request.url, { method: "GET", headers: wsHeaders }),
      );
    }

    const extraHeaders = props?.extraHeaders ?? {};
    const wbaHeaders = hostEgress ? {} : await wbaHeadersFor(env, target.host);
    let authorRequest = request;
    if (noCorsMode) {
      if (!isSafelistedMethod(request.method)) {
        return blocked(
          `kitesurf: mode 'no-cors' only permits GET, HEAD and POST, not ${request.method}`,
          "no-cors-method",
        );
      }
      const unsafe = corsUnsafeRequestHeaderNames(request.headers);
      if (unsafe.length > 0) {
        const reduced = new Headers(request.headers);
        for (const name of unsafe) reduced.delete(name);
        authorRequest = new Request(request, { headers: reduced });
      }
    }
    let forwardRequest = buildForwardRequest({
      original: authorRequest,
      resourceType,
      pageOrigin,
      extraHeaders,
      pageUrl: props?.pageUrl,
      referrerPolicy: props?.referrerPolicy,
      wbaHeaders,
      corsMode: needsCorsCheck || sheetWantsCors,
    });

    // Sealed props or x-kitesurf-cookie-key select the jar; only a missing context key
    // falls back to connectionId, the default-context jar.
    const cookieKey =
      (sealed ? (props.cookieKey ?? "") : (request.headers.get("x-kitesurf-cookie-key") ?? "")) ||
      connectionId;
    const jar = cookieKey ? getCookieJar(cookieKey) : undefined;
    if (jar && sendCredentials && !forwardRequest.headers.has("cookie")) {
      const cookieHeader = jar.cookieHeaderForUrl(request.url, cookieContext);
      if (cookieHeader) {
        forwardRequest.headers.set("cookie", cookieHeader);
      }
    }

    let requestId: string | null = null;
    if (tracker) {
      const typeHint = (request.headers.get("x-kitesurf-resource-type") ?? "Other") as
        | "Document"
        | "Stylesheet"
        | "Image"
        | "Script"
        | "XHR"
        | "Fetch"
        | "Other";
      const initType =
        request.headers.get("x-kitesurf-initiator") === "parser" ? "parser" : "script";
      requestId = tracker.beginRequest({
        url: request.url,
        method: request.method,
        headers: headersToRecord(forwardRequest.headers),
        type: typeHint,
        initiator: { type: initType, url: pageOrigin },
        loaderId: networkLoaderId,
        frameId: networkFrameId,
        sessionIds: networkSessionIds,
      });
    }

    const interceptConn = sealed
      ? props.interceptConnectionId || connectionId
      : (request.headers.get("x-kitesurf-intercept-connection") ?? connectionId);
    const interception = interceptConn ? getInterception(interceptConn) : undefined;
    if (interception && interceptionMatches(interception, forwardRequest.url, resourceType)) {
      const networkId = request.headers.get("x-kitesurf-network-id") ?? requestId ?? "";
      let postData: string | undefined;
      if (forwardRequest.method !== "GET" && forwardRequest.method !== "HEAD") {
        postData = await readBodyCapped(forwardRequest, POST_DATA_CAP_BYTES);
      }
      const parked = registerParked(interception, {
        url: forwardRequest.url,
        method: forwardRequest.method,
        headers: headersToRecord(forwardRequest.headers),
        postData,
        resourceType,
        frameId: networkFrameId,
        networkId,
      });
      const action = await awaitVerdict(interception, parked);
      if (action.kind === "fail") {
        const msg = errorReasonToNet(action.errorReason);
        if (requestId && tracker) tracker.failRequest(requestId, msg);
        throw new Error(msg);
      }
      if (action.kind === "fulfill") {
        const fulfillHeaders = new Headers();
        for (const h of action.responseHeaders ?? []) {
          fulfillHeaders.append(h.name, h.value);
        }
        const bodyBytes = action.body
          ? Uint8Array.from(atob(action.body), (c) => c.charCodeAt(0))
          : new Uint8Array(0);
        if (requestId && tracker) {
          tracker.completeRequest(requestId, {
            url: forwardRequest.url,
            status: action.responseCode,
            statusText: "",
            headers: headersToRecord(fulfillHeaders),
            mimeType:
              (fulfillHeaders.get("content-type")?.split(";")[0] ?? "").trim() || "text/plain",
            bodyLength: bodyBytes.length,
            body: action.body ?? "",
            bodyBase64Encoded: true,
          });
        }
        const noBody = [101, 204, 205, 304].includes(action.responseCode);
        const fulfilled = new Response(noBody ? null : bodyBytes, {
          status: action.responseCode,
          headers: fulfillHeaders,
        });
        if (needsCorsCheck && fulfilled.headers.has("access-control-allow-origin")) {
          const corsFailure = checkCorsResponse(fulfilled, pageOrigin, target, credentialsInclude);
          if (corsFailure) {
            failTrackedRequest(tracker, requestId, corsFailure.reason);
            return blocked(corsFailure.message, "cors");
          }
        }
        return fulfilled;
      }
      if (
        action.url !== undefined ||
        action.method !== undefined ||
        action.headers !== undefined ||
        action.postData !== undefined
      ) {
        const oh = action.headers
          ? (() => {
              const h = new Headers();
              for (const e of action.headers) h.append(e.name, e.value);
              h.set(
                "accept-encoding",
                decodableAcceptEncoding(h.get("accept-encoding"), h.has("range")),
              );
              return h;
            })()
          : forwardRequest.headers;
        forwardRequest = new Request(action.url ?? forwardRequest.url, {
          method: action.method ?? forwardRequest.method,
          headers: oh,
          body:
            action.postData !== undefined
              ? Uint8Array.from(atob(action.postData), (c) => c.charCodeAt(0))
              : forwardRequest.body,
          redirect: "manual",
          signal: forwardRequest.signal,
        });
        if (action.url !== undefined && action.url !== target.href) {
          try {
            target = new URL(forwardRequest.url);
          } catch {}
          forwardRequest.headers.delete("cookie");
          const overrideCookie = jar?.cookieHeaderForUrl(forwardRequest.url, cookieContext);
          if (overrideCookie) {
            forwardRequest.headers.set("cookie", overrideCookie);
          }
          const stillSameOrigin = !opaqueOrigin && originKey(target) === allowedOriginKey;
          crossOriginNow = !stillSameOrigin;
          opaqueNoCors = noCorsMode && !stillSameOrigin;
          needsCorsCheck = !stillSameOrigin && !opaqueResourceBypass && !noCorsMode;
          credentialsInclude = stillSameOrigin
            ? credentialsMode !== "omit"
            : credentialsMode === "include";
          sendCredentials = credentialsMode === null || credentialsInclude;
          if (!sendCredentials) forwardRequest.headers.delete("cookie");
        }
        // Recompute from author headers, not browser headers added to forwardRequest.
        const authorHeaders = action.headers ? oh : request.headers;
        authorUnsafeHeaders = needsCorsCheck ? corsUnsafeRequestHeaderNames(authorHeaders) : [];
        wantsPreflight = needsCorsCheck && needsPreflight(forwardRequest.method, authorHeaders);
        const wbaAfter = hostEgress ? {} : await wbaHeadersFor(env, target.host);
        for (const [k, v] of Object.entries(wbaAfter)) {
          forwardRequest.headers.set(k, v);
        }
        if (needsCorsCheck) {
          forwardRequest.headers.set("origin", pageOrigin || "null");
        }
      }
    }

    if (wantsPreflight) {
      // Grants from a host egress hook are session-scoped (that hook answered them), so
      // they never enter the shared cache, and a host-egress session never trusts one from it.
      const cached =
        !hostEgress &&
        preflightCacheLookup(
          pageOrigin || "null",
          forwardRequest.url,
          forwardRequest.method,
          authorUnsafeHeaders,
          credentialsInclude,
        );
      if (!cached) {
        const pfTimeout = new AbortController();
        const pfTimer = setTimeout(
          () => pfTimeout.abort(new Error("kitesurf: preflight headers timeout")),
          EGRESS_HEADERS_TIMEOUT_MS,
        );
        const pfSignal =
          typeof AbortSignal.any === "function" && forwardRequest.signal
            ? AbortSignal.any([forwardRequest.signal, pfTimeout.signal])
            : pfTimeout.signal;
        let verdict;
        try {
          verdict = await corsPreflight(
            {
              url: forwardRequest.url,
              method: forwardRequest.method,
              unsafeNames: authorUnsafeHeaders,
              requestOrigin: pageOrigin || "null",
              credentialsInclude,
              userAgent: forwardRequest.headers.get("user-agent") ?? BROWSER_UA,
              referer: forwardRequest.headers.get("referer"),
              signal: pfSignal,
              cacheable: !hostEgress,
            },
            async (req) => {
              const pfWba = hostEgress ? {} : await wbaHeadersFor(env, target.host);
              for (const [k, v] of Object.entries(pfWba)) {
                req.headers.set(k, v);
              }
              return directExternalFetch(transport, req);
            },
          );
        } finally {
          clearTimeout(pfTimer);
        }
        if (verdict.reason) {
          if (requestId && tracker) tracker.failRequest(requestId, verdict.reason);
          return blocked(
            `kitesurf: Access to fetch at '${target.href}' from origin '${pageOrigin}' has been blocked by CORS policy: ` +
              `Response to preflight request doesn't pass access control check` +
              (verdict.message ? ` (${verdict.message})` : "."),
            "cors",
          );
        }
      }
    }

    let resp: Response;
    const __egressT0 = Date.now();
    const egressAbortCtl = new AbortController();
    // Top-level documents get more time before PageScript exists; live-page egress keeps 10 s.
    const headersCapMs =
      resourceType === "Document" && props?.topLevelDocument === true
        ? DOCUMENT_HEADERS_TIMEOUT_MS
        : EGRESS_HEADERS_TIMEOUT_MS;
    const egressAbortTimer = setTimeout(() => {
      egressAbortCtl.abort(new Error(`kitesurf: egress headers timeout after ${headersCapMs}ms`));
    }, headersCapMs);
    const egressSignal =
      typeof AbortSignal.any === "function" && forwardRequest.signal
        ? AbortSignal.any([forwardRequest.signal, egressAbortCtl.signal])
        : egressAbortCtl.signal;
    try {
      resp = await directExternalFetch(
        transport,
        new Request(forwardRequest, { signal: egressSignal }),
      );
      clearTimeout(egressAbortTimer);
      const __egressMs = Date.now() - __egressT0;
      if (__egressMs > SLOW_EGRESS_HEADERS_THRESHOLD_MS) {
        console.warn(
          `[ks-egress] slow headers: ${__egressMs}ms ` +
            `type=${request.headers.get("x-kitesurf-resource-type") ?? "Other"} ` +
            `url=${forwardRequest.url.slice(0, MAX_SLOW_HEADER_URL_PREVIEW_CHARS)}`,
        );
      }
    } catch (err) {
      clearTimeout(egressAbortTimer);
      if (requestId && tracker) {
        tracker.failRequest(requestId, err instanceof Error ? err.message : String(err));
      }
      if (egressAbortCtl.signal.aborted) {
        return blocked(`kitesurf: egress timeout after ${headersCapMs}ms`, "egress-timeout");
      }
      throw err;
    }

    if (jar && sendCredentials) {
      try {
        const setCookies =
          typeof resp.headers.getSetCookie === "function" ? resp.headers.getSetCookie() : [];
        for (const sc of setCookies) {
          if (typeof sc === "string" && sc.length > 0) {
            jar.setFromHeader(forwardRequest.url, sc);
          }
        }
      } catch {}
    }

    if (corpApplies && pageOrigin) {
      const corp = (resp.headers.get("cross-origin-resource-policy") ?? "").trim();
      if (corp === "same-origin" || corp === "same-site") {
        let corpBlocked = true;
        try {
          const corpTarget = new URL(forwardRequest.url);
          const pageU = new URL(pageOrigin);
          if (originKey(corpTarget) === originKey(pageU)) {
            corpBlocked = false;
          } else {
            corpBlocked =
              corp === "same-origin" ||
              corpTarget.protocol !== pageU.protocol ||
              siteKey(corpTarget.hostname) !== siteKey(pageU.hostname);
          }
        } catch {}
        if (corpBlocked) {
          if (requestId && tracker) {
            tracker.failRequest(requestId, "corp-blocked");
          }
          return blocked(
            `kitesurf: Access to fetch at '${forwardRequest.url}' from origin '${pageOrigin}' has been blocked by Cross-Origin-Resource-Policy: ${corp}.`,
            "cors",
          );
        }
      }
    }

    if (needsCorsCheck) {
      const corsFailure = checkCorsResponse(resp, pageOrigin, target, credentialsInclude);
      if (corsFailure) {
        if (requestId && tracker) {
          tracker.failRequest(requestId, corsFailure.reason);
        }
        return blocked(corsFailure.message, "cors");
      }
    }

    const isRedirect =
      REDIRECT_STATUSES.has(resp.status) && (resp.headers.get("location") ?? "") !== "";
    const emptyLocationRedirect =
      REDIRECT_STATUSES.has(resp.status) && resp.headers.get("location") === "";
    if (needsCorsCheck && isRedirect) {
      const location = resp.headers.get("location");
      if (location) {
        let hasUserinfo = false;
        try {
          const next = new URL(location, forwardRequest.url);
          hasUserinfo = next.username !== "" || next.password !== "";
        } catch {}
        if (hasUserinfo) {
          if (requestId && tracker) {
            tracker.failRequest(requestId, "cors-redirect-userinfo");
          }
          return blocked(
            `kitesurf: Redirect from '${forwardRequest.url}' to a URL containing credentials is not allowed for a CORS request.`,
            "cors",
          );
        }
      }
    }
    const reduceToOpaque = opaqueNoCors && !isRedirect;

    const shellRedirect = isRedirect && crossOriginNow && props?.walksOwnRedirects !== true;

    const withholdImage =
      resourceType === "Image" && !isRedirect && crossOriginNow && opaqueResourceBypass;

    const interceptFont = resourceType === "Font" && !isRedirect && resp.ok && resp.body !== null;
    const shapeFont = interceptFont && props?.pixelFree === true;

    const shapedFont = async (out: Response, buffered: ArrayBuffer | null): Promise<Response> => {
      const rebuild = (body: BodyInit | null, headers: Headers): Response =>
        new Response(body, {
          status: out.status,
          statusText: out.statusText,
          headers,
        });
      let body: ArrayBuffer | Uint8Array | null = buffered;
      if (body === null) {
        const capped = await readCapped(out.body, MAX_SHAPED_FONT_BYTES);
        if (!capped.bytes) {
          return rebuild(capped.rest, exposeHeaders(out.headers));
        }
        body = capped.bytes;
      }
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
      const headers = new Headers(exposeHeaders(out.headers));
      // A loopback call may reach a replacement isolate with a separate resource store.
      // Its font keys cannot be resolved by the creating isolate's renderer, so only
      // publish a key when this is the creating isolate.
      if (!shapeFont && !foreignIsolate) {
        const key = putAuthorFont(bytes, connectionId, props?.mainFrameId ?? "");
        if (key !== null) headers.set(FONT_KEY_HEADER, key.toString());
      }
      if (!shapeFont) return rebuild(bytes, headers);
      let shaped: Uint8Array | null = null;
      try {
        shaped = await shapeFontBytes(bytes, env.HOST_TRACER);
      } catch {
        shaped = null;
      }
      if (!shaped) return rebuild(bytes, headers);
      headers.delete("content-length");
      headers.set("content-type", "font/otf");
      return rebuild(shaped, headers);
    };
    const withheldImage = async (
      out: Response,
      buffered: ArrayBuffer | null,
    ): Promise<Response> => {
      const shell = (extra?: Record<string, string>): Response =>
        new Response(null, {
          status: out.status,
          statusText: out.statusText,
          headers: extra ?? {},
        });
      let body = buffered;
      if (body === null) {
        const capped = await readCapped(out.body, MAX_ENTRY_BYTES);
        if (!capped.bytes) {
          void capped.rest.cancel();
          return shell();
        }
        body = capped.bytes.buffer;
      }
      const bytes = new Uint8Array(body);
      const dims = sniffImageDims(bytes);
      if (!dims) {
        if (!looksLikeSvg(bytes)) {
          console.warn(
            `[ks-outbound] resource-type Image on a non-image body: ${forwardRequest.url}`,
          );
        }
        return shell();
      }
      const key = putOpaqueImage(bytes, connectionId, props?.mainFrameId ?? "");
      if (!key) return shell();
      return shell({
        [RESOURCE_KEY_HEADER]: key.toString(),
        [IMAGE_WIDTH_HEADER]: String(dims.width),
        [IMAGE_HEIGHT_HEADER]: String(dims.height),
      });
    };
    const exposeHeaders = (h: Headers): Headers => {
      if (!needsCorsCheck || isRedirect) return h;
      const filtered = scrubKitesurfNamespace(filterCorsResponseHeaders(h, credentialsInclude));
      if (emptyLocationRedirect) filtered.set("location", "");
      stampScriptSecurity(h, filtered);
      return filtered;
    };

    function stampScriptSecurity(source: Headers, out: Headers): void {
      if (resourceType !== "Script") return;
      const nosniff = source.get("x-content-type-options");
      if (nosniff) out.set(KITESURF_NOSNIFF_HEADER, nosniff);
      if (corsVerdict !== null) {
        out.set(KITESURF_CORS_VERDICT_HEADER, corsVerdict);
      }
    }

    const corsVerdict: "clean" | "opaque" | null =
      resourceType === "Stylesheet"
        ? !crossOriginNow ||
          (stylesheetCorsMode === "cors" &&
            corsCheck(resp.headers, pageOrigin || "null", credentialsInclude) === null)
          ? "clean"
          : "opaque"
        : resourceType === "Script"
          ? !crossOriginNow || scriptCorsMode === "cors"
            ? "clean"
            : "opaque"
          : null;

    const stampSheetCors = (h: Headers): Headers => {
      if (corsVerdict === null) return h;
      const out = scrubKitesurfNamespace(h);
      out.set(KITESURF_CORS_VERDICT_HEADER, corsVerdict);
      stampScriptSecurity(h, out);
      return out;
    };

    const responseForCapturedBody = (
      out: Response,
      body: ArrayBuffer,
    ): Response | Promise<Response> => {
      if (reduceToOpaque) return opaqueResponse();
      if (withholdImage) return withheldImage(out, body);
      if (interceptFont) return shapedFont(out, body);
      if (shellRedirect) return redirectShell(out);
      if (!needsCorsCheck || isRedirect) {
        return new Response(body, {
          status: out.status,
          statusText: out.statusText,
          headers: stampSheetCors(out.headers),
        });
      }
      return corsFilteredResponse(out, body, exposeHeaders(out.headers));
    };

    if (
      (resourceType === "Image" || resourceType === "Media") &&
      !isRedirect &&
      resp.body !== null &&
      resp.status >= 200 &&
      resp.status <= 599
    ) {
      // Bound image/media bodies before Network capture so slow streams cannot pin the session.
      resp = new Response(withDeadline(resp.body, PIXEL_BODY_DEADLINE_MS), resp);
    }

    if (requestId && tracker) {
      const mimeType = resp.headers.get("content-type") ?? "";
      const contentLength = Number(resp.headers.get("content-length") ?? "0") || 0;
      const trimmedMime = (mimeType.split(";")[0] ?? "").trim() || "application/octet-stream";
      if (isTextLikeMime(mimeType) && resp.body && tracker.retainsBodies()) {
        try {
          const capped = await readCapped(resp.body, RESPONSE_BODY_BUFFER_CAP);
          if (capped.bytes) {
            const buf = capped.bytes.buffer;
            const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(buf);
            tracker.completeRequest(requestId, {
              url: request.url,
              status: resp.status,
              statusText: resp.statusText,
              headers: headersToRecord(resp.headers),
              mimeType: trimmedMime,
              bodyLength: contentLength || buf.byteLength,
              body: text,
              bodyBase64Encoded: false,
            });
            const capturedResponse = responseForCapturedBody(resp, buf);
            return capturedResponse instanceof Response ? capturedResponse : await capturedResponse;
          }
          const replay = new Response(capped.rest, {
            status: resp.status,
            statusText: resp.statusText,
            headers: resp.headers,
          });
          tracker.completeRequest(requestId, {
            url: request.url,
            status: resp.status,
            statusText: resp.statusText,
            headers: headersToRecord(resp.headers),
            mimeType: trimmedMime,
            bodyLength: contentLength,
          });
          resp = replay;
        } catch {
          tracker.completeRequest(requestId, {
            url: request.url,
            status: resp.status,
            statusText: resp.statusText,
            headers: headersToRecord(resp.headers),
            mimeType: trimmedMime,
            bodyLength: contentLength,
          });
        }
      } else {
        tracker.completeRequest(requestId, {
          url: request.url,
          status: resp.status,
          statusText: resp.statusText,
          headers: headersToRecord(resp.headers),
          mimeType: trimmedMime,
          bodyLength: contentLength,
        });
      }
    }

    if (reduceToOpaque) return opaqueResponse();
    if (withholdImage) return await withheldImage(resp, null);
    if (interceptFont) return await shapedFont(resp, null);
    if (shellRedirect) return redirectShell(resp);
    if (!needsCorsCheck || isRedirect) {
      if (corsVerdict === null || resp.status < 200 || resp.status > 599) {
        if (corsVerdict === null) return resp;
        return corsFilteredResponse(resp, resp.body, scrubKitesurfNamespace(resp.headers));
      }
      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: stampSheetCors(resp.headers),
      });
    }
    return corsFilteredResponse(resp, resp.body, exposeHeaders(resp.headers));
  }
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
  switch (reason) {
    case "cors-missing-origin":
      return {
        reason,
        message:
          prefix + `No 'Access-Control-Allow-Origin' header is present on the requested resource.`,
      };
    case "cors-multiple-origins":
      return {
        reason,
        message:
          prefix +
          `The 'Access-Control-Allow-Origin' header contains multiple values '${aca}', but only one is allowed.`,
      };
    case "cors-wildcard-with-credentials":
      return {
        reason,
        message:
          prefix +
          `The value of the 'Access-Control-Allow-Origin' header must not be the wildcard '*' when the request's credentials mode is 'include'.`,
      };
    case "cors-credentials-not-allowed":
      return {
        reason,
        message:
          prefix +
          `The value of the 'Access-Control-Allow-Credentials' header in the response is '` +
          `${resp.headers.get("access-control-allow-credentials") ?? ""}' which must be 'true' ` +
          `when the request's credentials mode is 'include'.`,
      };
    default:
      return {
        reason,
        message:
          prefix +
          `The 'Access-Control-Allow-Origin' header has a value '${aca}' that is not equal to the supplied origin.`,
      };
  }
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const POST_DATA_CAP_BYTES = 8 * 1024 * 1024;

async function readBodyCapped(req: Request, capBytes: number): Promise<string | undefined> {
  const cl = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(cl) && cl > capBytes) return undefined;
  const body = req.clone().body;
  if (!body) return undefined;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > capBytes) {
          await reader.cancel().catch(() => {});
          return undefined;
        }
        chunks.push(value);
      }
    }
  } catch {
    return undefined;
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
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
  const headers = new Headers();
  for (const [k, v] of original.headers.entries()) {
    const lower = k.toLowerCase();
    if (lower.startsWith("x-kitesurf-")) continue;
    headers.set(k, v);
  }
  if (!headers.has("user-agent")) headers.set("user-agent", BROWSER_UA);
  if (!headers.has("accept")) headers.set("accept", defaultAcceptFor(resourceType));
  if (!headers.has("origin") && !pageOrigin) headers.set("origin", "null");
  if (corsMode) headers.set("origin", pageOrigin || "null");
  const policy = parseReferrerPolicy(referrerPolicy);
  const requestReferrer = (() => {
    const raw = original.headers.get("x-kitesurf-referrer") ?? "";
    if (raw === "" || raw === "no-referrer") return raw;
    if (!pageOrigin) return "";
    try {
      return new URL(raw).origin === pageOrigin ? raw : "";
    } catch {
      return "";
    }
  })();
  if (
    !headers.has("referer") &&
    pageOrigin &&
    policy !== "no-referrer" &&
    requestReferrer !== "no-referrer"
  ) {
    const originOnly = pageOrigin.endsWith("/") ? pageOrigin : pageOrigin + "/";
    const carrier = (() => {
      if (!requestReferrer) return null;
      if (policy === "origin") return originOnly;
      try {
        const u = new URL(requestReferrer);
        u.hash = "";
        u.username = "";
        u.password = "";
        return u.href;
      } catch {
        return null;
      }
    })();
    const source = (() => {
      if (!pageUrl) return originOnly;
      try {
        return new URL(pageUrl).origin === pageOrigin ? pageUrl : originOnly;
      } catch {
        return originOnly;
      }
    })();
    const referer = carrier ?? determineReferrer(source, original.url, policy);
    if (referer) headers.set("referer", referer);
  }
  if (!headers.has("accept-language")) headers.set("accept-language", "en-US,en;q=0.9");
  let sameOrigin = false;
  if (pageOrigin) {
    try {
      sameOrigin = new URL(original.url).origin === new URL(pageOrigin).origin;
    } catch {
      sameOrigin = false;
    }
  }
  for (const [k, v] of Object.entries(extraHeaders)) {
    const lower = k.toLowerCase();
    // Restrict CDP extra Authorization and Cookie headers to same-origin requests.
    if (!sameOrigin && (lower === "authorization" || lower === "cookie")) {
      continue;
    }
    headers.set(k, v);
  }
  headers.set(
    "accept-encoding",
    decodableAcceptEncoding(headers.get("accept-encoding"), headers.has("range")),
  );
  for (const [k, v] of Object.entries(wbaHeaders)) {
    headers.set(k, v);
  }
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
