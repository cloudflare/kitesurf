// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Tracks request lifecycles and buffered response bodies for CDP Network sessions.

import type Protocol from "devtools-protocol";
import type { CdpEvent, EventEmitter } from "./types.ts";

export type ResourceType = Protocol.Network.ResourceType;

export interface BeginRequestOpts {
  url: string;
  method: string;
  headers: Protocol.Network.Headers;
  type: ResourceType;
  initiator: Protocol.Network.Initiator;
  loaderId: Protocol.Network.LoaderId;
  frameId: Protocol.Page.FrameId;
  sessionIds?: Array<string | undefined>;
  timestamp?: Protocol.Network.MonotonicTime;
  requestId?: Protocol.Network.RequestId;
}

export interface CompleteRequestOpts {
  url: string;
  status: number;
  statusText: string;
  headers: Protocol.Network.Headers;
  mimeType: string;
  bodyLength: number;
  body?: string;
  bodyBase64Encoded?: boolean;
  fromDiskCache?: boolean;
  timestamp?: Protocol.Network.MonotonicTime;
  errorText?: string;
}

interface RequestRecord {
  url: string;
  type: ResourceType;
  loaderId: Protocol.Network.LoaderId;
  frameId: Protocol.Page.FrameId;
  sessionIds: Array<string | undefined>;
  body?: string;
  bodyBase64Encoded?: boolean;
  bodyBytes?: number;
  completed?: boolean;
}

const RESPONSE_BODY_CAP = 256 * 1024;

const MAX_RETAINED_REQUESTS = 500;

const MAX_RETAINED_BODY_BYTES = 12 * 1024 * 1024;
const REQUEST_ID_CONNECTION_PREFIX_CHARS = 8;
const MILLISECONDS_PER_SECOND = 1_000;
const SECONDS_PER_DAY = 86_400;
const SYNTHETIC_CERTIFICATE_VALIDITY_DAYS = 30;

export interface SessionBuffer {
  maxTotalBufferSize?: number;
  maxResourceBufferSize?: number;
}

function clampBufferSize(requested: number | undefined, ceiling: number): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) {
    return ceiling;
  }
  if (requested < 0) return ceiling;
  return Math.min(Math.floor(requested), ceiling);
}

let isolateRetainedBodyBytes = 0;

export function isolateRetainedBodyBytesTotal(): number {
  return isolateRetainedBodyBytes;
}

export class NetworkEventTracker {
  private nextSeq = 1;
  private records = new Map<string, RequestRecord>();
  private order: string[] = [];
  private retainedBodyBytesTotal = 0;

  private disposed = false;

  private pending: CdpEvent[] = [];

  private inFlightCount = 0;

  private readonly targetAttributions = new Map<
    string,
    {
      loaderId: Protocol.Network.LoaderId;
      frameId: Protocol.Page.FrameId;
      sessionIds: Array<string | undefined>;
    }
  >();

  getInFlight(): number {
    return this.inFlightCount;
  }

  setTargetAttribution(
    frameId: Protocol.Page.FrameId,
    loaderId: Protocol.Network.LoaderId,
    sessionIds: Array<string | undefined>,
  ): void {
    this.targetAttributions.set(frameId, {
      loaderId,
      frameId,
      sessionIds: [...sessionIds],
    });
  }

  deleteTargetAttribution(frameId: Protocol.Page.FrameId): void {
    this.targetAttributions.delete(frameId);
  }

  attributionForTarget(frameId: string):
    | {
        loaderId: Protocol.Network.LoaderId;
        frameId: Protocol.Page.FrameId;
        sessionIds: Array<string | undefined>;
      }
    | undefined {
    const attribution = this.targetAttributions.get(frameId);
    if (!attribution) return undefined;
    return { ...attribution, sessionIds: [...attribution.sessionIds] };
  }

  private readonly clockEpoch: number = Date.now();

  private monotonicSeconds(): number {
    return (Date.now() - this.clockEpoch) / MILLISECONDS_PER_SECOND;
  }

  private readonly enabledSessions = new Map<string, SessionBuffer>();

  private effectiveTotalBytes = 0;
  private effectivePerBodyBytes = 0;

  setEnabled(sessionId: string | undefined, on: boolean, buffer: SessionBuffer = {}): void {
    const key = sessionId ?? "";
    if (on) this.enabledSessions.set(key, buffer);
    else this.enabledSessions.delete(key);
    this.recomputeBufferLimits();
  }

  // Retention is shared by the WebSocket, so honor the largest enabled-session budget.
  private recomputeBufferLimits(): void {
    let total = 0;
    let perBody = 0;
    for (const req of this.enabledSessions.values()) {
      total = Math.max(total, clampBufferSize(req.maxTotalBufferSize, MAX_RETAINED_BODY_BYTES));
      perBody = Math.max(perBody, clampBufferSize(req.maxResourceBufferSize, RESPONSE_BODY_CAP));
    }
    this.effectiveTotalBytes = total;
    this.effectivePerBodyBytes = perBody;
    this.shedBodiesOverBudget();
  }

  isEnabled(sessionId: string | undefined): boolean {
    return this.enabledSessions.has(sessionId ?? "");
  }

  perBodyBudget(): number {
    return this.effectivePerBodyBytes;
  }

  retainsBodies(): boolean {
    return this.effectiveTotalBytes > 0 && this.effectivePerBodyBytes > 0;
  }

  forgetSession(sessionId: string): void {
    this.enabledSessions.delete(sessionId);
    this.recomputeBufferLimits();
  }

  private wantsEvents(sessionIds: Array<string | undefined>): boolean {
    if (this.enabledSessions.size === 0) return false;
    for (const sid of sessionIds) {
      if (this.isEnabled(sid)) return true;
    }
    return this.isEnabled(undefined);
  }

  constructor(
    private readonly emit: EventEmitter,
    private readonly connectionId: string,
  ) {}

  drain(): void {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    for (const ev of batch) {
      try {
        this.emit(ev);
      } catch {
        return;
      }
    }
  }

  private enqueue(ev: CdpEvent, sessionIds: Array<string | undefined>): void {
    if (sessionIds.length === 0) {
      if (this.isEnabled(undefined)) this.pending.push(ev);
      return;
    }
    let delivered = false;
    for (const sid of sessionIds) {
      if (!this.isEnabled(sid)) continue;
      this.pending.push({ ...ev, sessionId: sid } as CdpEvent);
      delivered = true;
    }
    if (!delivered && this.isEnabled(undefined)) this.pending.push(ev);
  }

  queueRaw(ev: CdpEvent): void {
    if (this.disposed) return;
    this.pending.push(ev);
  }

  newRequestId(): string {
    const n = this.nextSeq++;
    const connectionPrefix = this.connectionId.slice(0, REQUEST_ID_CONNECTION_PREFIX_CHARS);
    return `cs-${connectionPrefix}-${n}`;
  }

  beginRequest(opts: BeginRequestOpts): Protocol.Network.RequestId {
    const requestId = opts.requestId ?? this.newRequestId();
    const ts = opts.timestamp ?? this.monotonicSeconds();
    // Snapshot recipients at request start; later target changes cannot retarget its events.
    const sessionIds = opts.sessionIds
      ? [...opts.sessionIds]
      : [...(this.targetAttributions.get(opts.frameId)?.sessionIds ?? [])];

    this.records.set(requestId, {
      url: opts.url,
      type: opts.type,
      loaderId: opts.loaderId,
      frameId: opts.frameId,
      sessionIds,
    });
    this.order.push(requestId);
    // Lifecycle networkIdle uses this count even when no session subscribes to Network.
    this.inFlightCount++;
    this.evictIfFull();

    const request: Protocol.Network.Request = {
      url: opts.url,
      method: opts.method,
      headers: opts.headers,
      initialPriority: opts.type === "Document" ? "VeryHigh" : "Medium",
      referrerPolicy: "strict-origin-when-cross-origin",
      mixedContentType: "none",
      isSameSite: true,
    };
    const params: Protocol.Network.RequestWillBeSentEvent = {
      requestId,
      loaderId: opts.loaderId,
      documentURL: opts.url,
      request,
      timestamp: ts,
      wallTime: Date.now() / MILLISECONDS_PER_SECOND,
      initiator: opts.initiator,
      type: opts.type,
      frameId: opts.frameId,
      hasUserGesture: false,
      redirectHasExtraInfo: false,
    };
    this.enqueue(
      {
        method: "Network.requestWillBeSent",
        params,
        sessionId: undefined,
      },
      sessionIds,
    );

    const reqExtra: Protocol.Network.RequestWillBeSentExtraInfoEvent = {
      requestId,
      associatedCookies: [],
      headers: opts.headers,
      connectTiming: { requestTime: ts },
      siteHasCookieInOtherPartition: false,
    };
    this.enqueue(
      {
        method: "Network.requestWillBeSentExtraInfo",
        params: reqExtra,
        sessionId: undefined,
      },
      sessionIds,
    );

    return requestId;
  }

  redirectRequest(
    requestId: Protocol.Network.RequestId,
    opts: {
      newUrl: string;
      method: string;
      headers: Record<string, string>;
      status: number;
      statusText: string;
      responseHeaders: Record<string, string>;
      loaderId: string;
      frameId: string;
      type: Protocol.Network.ResourceType;
    },
  ): void {
    const rec = this.records.get(requestId);
    const prevUrl = rec?.url ?? opts.newUrl;
    if (rec) rec.url = opts.newUrl;
    const sessionIds = rec?.sessionIds ?? [];
    if (!this.wantsEvents(sessionIds)) return;
    const ts = this.monotonicSeconds();
    const redirectResponse: Protocol.Network.Response = {
      url: prevUrl,
      status: opts.status,
      statusText: opts.statusText,
      headers: opts.responseHeaders,
      mimeType: "",
      encodedDataLength: 0,
      fromDiskCache: false,
      fromServiceWorker: false,
      fromPrefetchCache: false,
      connectionReused: false,
      connectionId: 0,
      remoteIPAddress: "",
      remotePort: 0,
      securityState: "secure",
      charset: "",
      protocol: "http/1.1",
      responseTime: Date.now(),
    };
    const params: Protocol.Network.RequestWillBeSentEvent = {
      requestId,
      loaderId: opts.loaderId,
      documentURL: opts.newUrl,
      request: {
        url: opts.newUrl,
        method: opts.method,
        headers: opts.headers,
        initialPriority: opts.type === "Document" ? "VeryHigh" : "Medium",
        referrerPolicy: "strict-origin-when-cross-origin",
        mixedContentType: "none",
        isSameSite: true,
      },
      timestamp: ts,
      wallTime: Date.now() / MILLISECONDS_PER_SECOND,
      initiator: { type: "other" },
      redirectResponse,
      redirectHasExtraInfo: false,
      type: opts.type,
      frameId: opts.frameId,
      hasUserGesture: false,
    };
    this.enqueue(
      {
        method: "Network.requestWillBeSent",
        params,
        sessionId: undefined,
      },
      sessionIds,
    );
  }

  completeRequest(requestId: Protocol.Network.RequestId, opts: CompleteRequestOpts): void {
    const rec = this.records.get(requestId);
    if (!rec) {
      return;
    }
    if (!rec.completed) {
      rec.completed = true;
      this.inFlightCount--;
    }

    // If the frame has a current attribution, skip bodies from other loaders;
    // the request's snapshotted Network recipients may still receive response events.
    const currentLoaderId = this.targetAttributions.get(rec.frameId)?.loaderId;
    const supersededLoader = currentLoaderId !== undefined && rec.loaderId !== currentLoaderId;
    if (
      !supersededLoader &&
      opts.body !== undefined &&
      opts.body.length * 2 <= this.perBodyBudget()
    ) {
      this.storeBody(rec, opts.body, opts.bodyBase64Encoded ?? false);
    }

    if (!this.wantsEvents(rec.sessionIds)) return;

    const ts = opts.timestamp ?? this.monotonicSeconds();
    const timing: Protocol.Network.ResourceTiming = {
      requestTime: ts,
      proxyStart: -1,
      proxyEnd: -1,
      dnsStart: -1,
      dnsEnd: -1,
      connectStart: -1,
      connectEnd: -1,
      sslStart: -1,
      sslEnd: -1,
      workerStart: -1,
      workerReady: -1,
      workerFetchStart: -1,
      workerRespondWithSettled: -1,
      sendStart: 0,
      sendEnd: 0,
      pushStart: 0,
      pushEnd: 0,
      receiveHeadersStart: 0,
      receiveHeadersEnd: 0,
    };
    const response: Protocol.Network.Response = {
      url: opts.url,
      status: opts.status,
      statusText: opts.statusText,
      headers: opts.headers,
      mimeType: opts.mimeType,
      encodedDataLength: opts.bodyLength,
      fromDiskCache: opts.fromDiskCache ?? false,
      fromServiceWorker: false,
      fromPrefetchCache: false,
      connectionReused: false,
      connectionId: 0,
      remoteIPAddress: "",
      remotePort: 0,
      securityState: "secure",
      charset: "",
      protocol: "http/1.1",
      responseTime: Date.now(),
      timing,
      securityDetails: {
        protocol: "TLS 1.3",
        keyExchange: "",
        keyExchangeGroup: "X25519",
        cipher: "AES_128_GCM",
        certificateId: 0,
        subjectName: hostFromUrl(opts.url),
        sanList: [hostFromUrl(opts.url)],
        issuer: "Kitesurf POC",
        validFrom: Math.floor(Date.now() / MILLISECONDS_PER_SECOND) - SECONDS_PER_DAY,
        validTo:
          Math.floor(Date.now() / MILLISECONDS_PER_SECOND) +
          SECONDS_PER_DAY * SYNTHETIC_CERTIFICATE_VALIDITY_DAYS,
        signedCertificateTimestampList: [],
        certificateTransparencyCompliance: "unknown",
        serverSignatureAlgorithm: 0,
        encryptedClientHello: false,
      },
      alternateProtocolUsage: "unspecifiedReason",
    };
    const respExtra: Protocol.Network.ResponseReceivedExtraInfoEvent = {
      requestId,
      blockedCookies: [],
      headers: opts.headers,
      resourceIPAddressSpace: "Public",
      statusCode: opts.status,
      cookiePartitionKey: { topLevelSite: "", hasCrossSiteAncestor: false },
      cookiePartitionKeyOpaque: false,
      exemptedCookies: [],
    };
    this.enqueue(
      {
        method: "Network.responseReceivedExtraInfo",
        params: respExtra,
        sessionId: undefined,
      },
      rec.sessionIds,
    );

    const responseEvent: Protocol.Network.ResponseReceivedEvent = {
      requestId,
      loaderId: rec.loaderId,
      frameId: rec.frameId,
      timestamp: ts,
      type: rec.type,
      response,
      hasExtraInfo: true,
    };
    this.enqueue(
      {
        method: "Network.responseReceived",
        params: responseEvent,
        sessionId: undefined,
      },
      rec.sessionIds,
    );

    if (opts.errorText) {
      const failedEvent: Protocol.Network.LoadingFailedEvent = {
        requestId,
        timestamp: ts,
        type: rec.type,
        errorText: opts.errorText,
        canceled: false,
      };
      this.enqueue(
        {
          method: "Network.loadingFailed",
          params: failedEvent,
          sessionId: undefined,
        },
        rec.sessionIds,
      );
      return;
    }

    const dataEvent: Protocol.Network.DataReceivedEvent = {
      requestId,
      timestamp: ts,
      dataLength: opts.bodyLength,
      encodedDataLength: opts.bodyLength,
    };
    this.enqueue(
      {
        method: "Network.dataReceived",
        params: dataEvent,
        sessionId: undefined,
      },
      rec.sessionIds,
    );

    const finishedEvent: Protocol.Network.LoadingFinishedEvent = {
      requestId,
      timestamp: ts,
      encodedDataLength: opts.bodyLength,
    };
    this.enqueue(
      {
        method: "Network.loadingFinished",
        params: finishedEvent,
        sessionId: undefined,
      },
      rec.sessionIds,
    );
  }

  failRequest(
    requestId: Protocol.Network.RequestId,
    errorText: string,
    blockedReason?: Protocol.Network.BlockedReason,
  ): void {
    const rec = this.records.get(requestId);
    if (!rec) return;
    if (!rec.completed) {
      rec.completed = true;
      this.inFlightCount--;
    }
    const failedEvent: Protocol.Network.LoadingFailedEvent = {
      requestId,
      timestamp: this.monotonicSeconds(),
      type: rec.type,
      errorText,
      canceled: false,
      ...(blockedReason ? { blockedReason } : {}),
    };
    this.enqueue(
      {
        method: "Network.loadingFailed",
        params: failedEvent,
        sessionId: undefined,
      },
      rec.sessionIds,
    );
  }

  getResponseBody(
    requestId: Protocol.Network.RequestId,
  ): Protocol.Network.GetResponseBodyResponse | null {
    const rec = this.records.get(requestId);
    if (!rec || rec.body === undefined) return null;
    return {
      body: rec.body,
      base64Encoded: rec.bodyBase64Encoded ?? false,
    };
  }

  private evictIfFull(): void {
    while (this.order.length > MAX_RETAINED_REQUESTS) {
      const id = this.order.shift();
      if (id === undefined) continue;
      const rec = this.records.get(id);
      if (rec) this.dropBody(rec);
      this.records.delete(id);
    }
  }

  private storeBody(rec: RequestRecord, body: string, base64Encoded: boolean): void {
    if (this.disposed) return;
    if (this.effectiveTotalBytes <= 0) return;
    this.dropBody(rec);
    rec.body = body;
    rec.bodyBase64Encoded = base64Encoded;
    rec.bodyBytes = body.length * 2;
    this.retainedBodyBytesTotal += rec.bodyBytes;
    isolateRetainedBodyBytes += rec.bodyBytes;
    this.shedBodiesOverBudget();
  }

  private dropBody(rec: RequestRecord): void {
    if (rec.bodyBytes === undefined) return;
    this.retainedBodyBytesTotal -= rec.bodyBytes;
    isolateRetainedBodyBytes -= rec.bodyBytes;
    rec.bodyBytes = undefined;
    rec.body = undefined;
    rec.bodyBase64Encoded = undefined;
  }

  private shedBodiesOverBudget(): void {
    const over = (): boolean =>
      isolateRetainedBodyBytes > MAX_RETAINED_BODY_BYTES ||
      this.retainedBodyBytesTotal > this.effectiveTotalBytes;
    if (!over()) return;
    for (const id of this.order) {
      if (!over()) return;
      const rec = this.records.get(id);
      if (rec) this.dropBody(rec);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const rec of this.records.values()) this.dropBody(rec);
    this.records.clear();
    this.order.length = 0;
    this.targetAttributions.clear();
  }

  retainedBodyBytes(): number {
    return this.retainedBodyBytesTotal;
  }

  retainedRequestCount(): number {
    return this.records.size;
  }

  dropStaleLoaderBodies(frameId: Protocol.Page.FrameId): void {
    const currentLoaderId = this.targetAttributions.get(frameId)?.loaderId;
    if (currentLoaderId === undefined) return;
    for (const rec of this.records.values()) {
      if (rec.frameId === frameId && rec.loaderId !== currentLoaderId) {
        this.dropBody(rec);
      }
    }
  }
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function inferResourceType(contentType: string, hint?: ResourceType): ResourceType {
  if (hint && hint !== "Other") return hint;
  const ct = (contentType.toLowerCase().split(";")[0] ?? "").trim();
  if (!ct) return "Other";
  if (ct === "text/html" || ct === "application/xhtml+xml") return "Document";
  if (ct === "text/css") return "Stylesheet";
  if (
    ct === "text/javascript" ||
    ct === "application/javascript" ||
    ct === "application/x-javascript" ||
    (ct.endsWith("+json") && ct.includes("javascript"))
  ) {
    return "Script";
  }
  if (ct === "application/json" || ct.endsWith("+json")) return "Fetch";
  if (ct.startsWith("image/")) return "Image";
  if (ct.startsWith("font/") || ct.startsWith("application/font-")) return "Font";
  if (ct.startsWith("video/") || ct.startsWith("audio/")) return "Media";
  if (ct === "text/event-stream") return "EventSource";
  if (ct === "application/manifest+json") return "Manifest";
  return "Other";
}

export function isTextLikeMime(mimeType: string): boolean {
  const ct = (mimeType.toLowerCase().split(";")[0] ?? "").trim();
  if (!ct) return false;
  if (ct.startsWith("text/")) return true;
  if (
    ct === "application/json" ||
    ct === "application/javascript" ||
    ct === "application/x-javascript" ||
    ct === "application/xhtml+xml" ||
    ct === "application/xml" ||
    ct === "application/manifest+json"
  ) {
    return true;
  }
  if (ct.endsWith("+json") || ct.endsWith("+xml")) return true;
  return false;
}

export function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}
