// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Defines CDP wire types and per-connection browser, target, frame, and session state.

import type { Protocol } from "devtools-protocol";
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";
import type { NetworkEventTracker } from "./network-events.ts";
import type { PageRendererManager } from "../eval/page-renderer.ts";
import type { DynamicWorkerBudget, WorkerLease } from "../eval/worker-budget.ts";
import type { DedicatedWorkers } from "./dedicated-workers.ts";
import type { PrespawnedFrame } from "../eval/oopif-render.ts";
import type { LearnedScripts } from "../eval/learned-scripts.ts";
import type { DiagSpanTracker } from "./diag-spans.ts";
import type { SandboxOutboundOverride } from "../eval/outbound.ts";
import type { WheelQueue } from "./wheel-queue.ts";
import type { RetainedText } from "../retained-text.ts";

export type CdpMethod = keyof ProtocolMapping.Commands;

export const CDP_COMMAND_UNHANDLED = Symbol("cdp-command-unhandled");

export type CdpParamsOf<M extends CdpMethod> = ProtocolMapping.Commands[M]["paramsType"][0];

export type CdpResultOf<M extends CdpMethod> = ProtocolMapping.Commands[M]["returnType"];

type Unvalidated<P> = P extends object ? { [K in keyof P]?: unknown } : P;

export type CdpRequest = {
  [M in CdpMethod]: {
    id: number;
    method: M;
    params?: M extends `Kitesurf.${string}` ? Unvalidated<CdpParamsOf<M>> : CdpParamsOf<M>;
    sessionId?: string;
  };
}[CdpMethod];

export interface CdpSuccess {
  id: number;
  result: unknown;
  sessionId?: string;
}

export interface CdpError {
  id: number;
  error: { code: number; message: string };
  sessionId?: string;
}

export type CdpResponse = CdpSuccess | CdpError;

export interface CdpEnvelopeError {
  id: unknown;
  error: { code: number; message: string };
}

/**
 * Validates the JSON envelope only; command handlers must still validate their parameters.
 * Parse and envelope errors return CDP error replies instead of throwing.
 */
export function parseCdpRequest(
  text: string,
): { ok: true; request: CdpRequest } | { ok: false; error: CdpEnvelopeError } {
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      error: { id: 0, error: { code: -32700, message: "Parse error: " + String(err) } },
    };
  }
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return { ok: false, error: { id: 0, error: { code: -32600, message: "Invalid Request" } } };
  }
  for (const key of ["params", "sessionId"]) {
    if (Reflect.get(message, key) === null) Reflect.deleteProperty(message, key);
  }
  const id: unknown = Reflect.get(message, "id");
  const method: unknown = Reflect.get(message, "method");
  const params: unknown = Reflect.get(message, "params");
  const sessionId: unknown = Reflect.get(message, "sessionId");
  if (
    typeof id !== "number" ||
    typeof method !== "string" ||
    (params !== undefined &&
      (typeof params !== "object" || params === null || Array.isArray(params))) ||
    (sessionId !== undefined && typeof sessionId !== "string")
  ) {
    return {
      ok: false,
      error: { id: id ?? 0, error: { code: -32600, message: "Invalid Request" } },
    };
  }
  return { ok: true, request: message as CdpRequest };
}

export type CdpEvent = {
  [M in keyof ProtocolMapping.Events]: ProtocolMapping.Events[M] extends [infer P]
    ? { method: M; params: P; sessionId?: string }
    : { method: M; params?: Record<string, never>; sessionId?: string };
}[keyof ProtocolMapping.Events];

export type EventEmitter = (event: CdpEvent) => void;

export interface BrowserState {
  targets: Map<string, TargetState>;
  sandboxOutbound: SandboxOutboundOverride;
  autoAttach: boolean;
  flatten: boolean;
  cookies: CookieJar;
  contexts: Map<string, { cookieJar: CookieJar }>;
  nextBrowserContextId: number;
  screencasts: Map<string, ScreencastState>;
  styleCache: Map<string, { css: string; fetchedAt: number }>;
  imageCache: Map<string, { bytes: Uint8Array; contentType: string; fetchedAt: number }>;
  networkEvents: NetworkEventTracker;
  layoutMode: "full" | "off";
  cdpDebug: boolean;
  isolateCapOverrides?: PageIsolateCapOverrides;
  connectionMode: "page" | "browser";
  ttyKeyboard?: boolean;
  preNavScripts: Map<string, string>;
  learnedInsertedScripts: LearnedScripts;
  pendingBindings: Set<string>;

  ttyUaCss?: number;
  ttyCellW?: number;
  ttyCellH?: number;

  darkColorScheme?: boolean;

  execContextSeq: number;
  runtimeEnabledSessions: Set<string>;
  rendererManager: PageRendererManager | null;
  workerBudget: DynamicWorkerBudget;
  dedicatedWorkers: DedicatedWorkers;
  skipSpeculativeRaster: boolean;
  skipPartialRaster: boolean;
  fontDefer: boolean;
  rendererSessionId: string | null;
  engineSessionId: string | null;
  wsClosing: boolean;

  attributionHeaders: Record<string, string>;
}

export interface ScreencastState {
  format: "jpeg" | "png";
  quality: number;
  maxWidth: number;
  maxHeight: number;
  everyNthFrame: number;
  pollIntervalMs: number;
  maxInFlight: number;
  wheelQueue: WheelQueue;
  ownerSessionId: string | undefined;
  configurationVersion: number;
  appliedConfigurationVersion: number;
  lastAckedSeq: number;
  wake?: () => void;
  paintDirty?: boolean;

  frameSeq: number;
  lastRenderedMutationSeq: number;
  pendingAckSessionId: number | null;
  pendingAckSetAt: number;
  stopped: boolean;
  consecutiveRenderFailures: number;
  lastRenderError: string | null;
  framesDropped: number;
}

import type { DomHandle, DocScan } from "../wasm.ts";
import type { PageScriptStub, PageIsolateCapOverrides } from "../eval/page-script.ts";
import type { PageSession } from "./page-session.ts";
import type { CookieJar } from "../cookies.ts";

export interface FrameState {
  frameId: string;
  parentFrameId: string | null;
  loaderId: string;
  url: string;
  // A child frame's iframe name and id attributes, from which Page.Frame derives its name. Main
  // frames leave both unset, because Chrome never reports a name for them.
  name?: string;
  ownerElementId?: string;
  securityOrigin: string;
  mimeType: string;
  // Nested frames apply their own response policy to descendant requests.
  referrerPolicy?: string | null;
  ownerBackendNodeId: number;
  lifecycle: "init" | "dcl" | "load";
  detached: boolean;
  sessions: Set<string>;
  dom: DomHandle | null;
  isCrossOrigin: boolean;
  hasScript: boolean;
  pendingLoad: Promise<void> | null;
  delaysLoadEvent: boolean;
  readyState: "loading" | "interactive" | "complete";
  pageScript: PageScriptStub | null;
  pageScriptLease?: WorkerLease | null;
  oopifBlocked?: boolean;
  /** Sticky host-blocker refusal; never retried when worker budget frees. */
  requestBlocked?: boolean;
  lastRenderSeq: number;
  execContextId: number;
  pendingPostMessages?: Array<Record<string, unknown>>;
  oopifSpawning?: boolean;
  oopifPrespawn?: {
    url: string;
    promise: Promise<PrespawnedFrame | null>;
  };
}

export interface StyleSheetEntry {
  ownerNodeId: number;
  rev: number;
  text: string;
  isInline: boolean;
  sourceURL: string;
  origin: "regular" | "user-agent" | "injected" | "inspector";
  parsed: ParsedStyleSheet | null;
}

import type { ParsedStyleSheet } from "@kitesurf/jsrpc-types/query-dom";
export type { ParsedStyleSheet };

export interface NavigationHistoryEntry {
  id: number;
  url: string;
  userTypedURL: string;
  title: string;
  transitionType: Protocol.Page.TransitionType;
}

export interface TargetState {
  targetId: string;
  type: "page" | "browser";
  browserContextId?: string;
  sessions: Set<string>;
  url: string;
  title: string;
  /** The document source; read only to rebuild a released `dom`. */
  html: RetainedText;
  dom: DomHandle | null;
  docScan: DocScan | null;
  domEpoch: number;
  loaderId: string;
  frameId: string;
  isolatedWorlds?: Array<{ name: string; frameId: string; id: number }>;
  defaultContextId: number;
  retiredContextIds?: Set<number>;
  pendingNavAbort?: AbortController | null;
  // Applied to subresource and child-frame requests for this document.
  docReferrerPolicy?: string | null;
  docReferrer?: string | null;
  docCsp?: string | null;
  docCspReportOnly?: string | null;
  docCharset?: string | null;
  blankReady?: Promise<void> | null;
  frames: Map<string, FrameState>;
  pageScript: PageScriptStub | null;
  // The url the page isolate was sealed with. Page.navigate moves target.url to the next
  // document before it retires the isolate, so writes from the isolate's unload use this url.
  pageScriptUrl?: string;
  pageSession?: PageSession;
  pageScriptLease: WorkerLease | null;
  navigateGeneration: number;
  wheelTeardownDepth: number;
  // A navigation an input started and replied before; the next input waits for it, so it never
  // lands in the document being retired.
  inputNavigation?: Promise<void>;
  isolateLimitReportedGen?: number;
  navigationHistory: NavigationHistoryEntry[];
  navigationHistoryIndex: number;
  nextNavigationHistoryId: number;
  viewportWidth: number | null;
  viewportHeight: number | null;
  screencastConfigurationBarrier: Promise<void>;
  screencastConfigurationVersion: number;
  emulatedMedia: "screen" | "print";
  refetchOnPushState: boolean;
  autoReloadUrl: string | null;
  autoReloadCount: number;
  lastLoadAt: number;
  layoutMode: "full" | "off";
  compiledScripts: CompiledScriptMeta[];
  debuggerEnabledSessions: Set<string>;
  domEnabledSessions: Set<string>;
  cssEnabledSessions: Set<string>;
  webmcpSessions: Set<string>;
  webmcpEnableRevisions: Map<string, number>;
  webmcpWatchRevision: number;
  webmcpAnnouncedTools: Map<string, Map<string, string>>;
  styleSheets: Map<string, StyleSheetEntry>;
  nextStyleSheetRev: Map<number, number>;
  lastNavigatePhases: Record<string, number> | null;
  diagSpans?: DiagSpanTracker | null;
  screencastAckCount?: number;
  extraHttpHeaders: Record<string, string>;
  userAgentOverride: string;
}

export interface CompiledScriptMeta {
  scriptId: string;
  url: string;
  hasSourceURL: boolean;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  length: number;
  hash: string;
  sourceMapURL: string;
  isModule: boolean;
  source?: RetainedText;
}

export const ISOLATED_WORLD_CONTEXT_ID = 2;

export const SKIP_SPECULATIVE_RASTER_HEADER = "x-kitesurf-skip-raster";

export function makeTargetId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function makeSessionId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}
