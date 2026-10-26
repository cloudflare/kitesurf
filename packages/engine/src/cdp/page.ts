// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements CDP Page commands and coordinates navigation, frames, and screencasts.

import type Protocol from "devtools-protocol";
import { decodeHtmlBytes } from "@kitesurf/dom-shim/html-encoding";
import type {
  CdpParamsOf,
  CdpEvent,
  CdpRequest,
  FrameState,
  NavigationHistoryEntry,
  ScreencastState,
  TargetState,
} from "./types.ts";
import type { DispatchCtx } from "./dispatch.ts";
import { resolveTarget, sessionOf, stubQueryDom, type QueryDomResult } from "./page-session.ts";
import {
  applyTtyNavParams,
  DEFAULT_TTY_CELL_HEIGHT_PX,
  DEFAULT_TTY_CELL_WIDTH_PX,
} from "../tty/nav-params.ts";
import { ttyFocusStylesheet, ttyUaStylesheet } from "../tty/stylesheet.ts";
import { wakeSceneStream } from "./scene-stream.ts";
import {
  cancelAndRemoveTargetWheelQueues,
  findWheelQueues,
  getWheelQueue,
  moveWheelQueue,
  removeWheelQueue,
  setWheelHandoffDrain,
  stopAndRemoveWheelQueue,
} from "./wheel-queue.ts";
import {
  createDom,
  extractScriptDescriptorsFromDom,
  scanDocument,
  type DomHandle,
} from "../wasm.ts";
import { prefetchExternalScripts } from "../eval/prefetch-scripts.ts";
import {
  applyImportMapGate,
  applyPreFetchScriptGate,
  documentBaseUrl,
  documentGateContext,
} from "../eval/script-gate.ts";
import {
  clampViewport,
  DEFAULT_VIEWPORT_HEIGHT,
  DEFAULT_VIEWPORT_WIDTH,
  MAX_SIDE,
} from "./viewport.ts";
import {
  astroIslandModuleUrls,
  modulePreloadSeeds,
  walkModuleGraph,
} from "../eval/walk-module-graph.ts";
import { traceSpan, redactUrl, type Span } from "../tracing.ts";
import { makeWallClock } from "../eval/host-clock.ts";
import { DiagSpanTracker } from "./diag-spans.ts";
import { registerTailTrace } from "../eval/tail-trace-registry.ts";
import { buildScriptBundle, insertedSourceDigests } from "../eval/script-bundle.ts";
import {
  forgetLearnedScript,
  learnedScriptsFor,
  recordInsertedScript,
} from "../eval/learned-scripts.ts";
import { nextRouteChunkUrls } from "../eval/next-route-chunks.ts";
import { maySpeculate, prefetchBestEffort } from "../eval/speculative-prefetch.ts";
import {
  scanForWasmUrls,
  scanForInlineWasm,
  bakeInlineWasm,
  prefetchWasmModules,
  type WasmBake,
} from "../eval/prefetch-wasm.ts";
import { makeTargetId } from "./types.ts";
import {
  buildFrameResourceTree,
  buildFrameTree,
  makeChildFrameState,
  makeFrameInfo,
  makeMainFrameState,
  mintFrameId,
  matchesAboutBlank,
  mintLoaderId,
  originOf,
} from "./frames.ts";
import { emitChildFrameAttachAndStart } from "./iframe-events.ts";
import {
  consoleEntryToCdpEvent,
  exceptionEntryToCdpEvent,
  getOrCreatePageScript,
  pageIsolateCaps,
  pageScriptCacheKey,
  originOf as pageScriptOriginOf,
  type PageScriptInitTimings,
  type PageScriptStartupInput,
  type PageScriptStub,
} from "../eval/page-script.ts";
import { registerIsolateLimitListener, type IsolateLimitNotice } from "../eval/limit-registry.ts";
import { disposeStub, publishStub, retireStub } from "./page-script-generation.ts";
import { emitSessionStart } from "../observability.ts";
import type { OutboundProps, SandboxOutboundOverride } from "../eval/outbound.ts";
import { getOutboundInflight } from "../eval/outbound.ts";
import { walkRedirects } from "../eval/redirect-walk.ts";
import { siteKey } from "../public-suffix.ts";
import { PageRendererManager, withTimeout, type RenderFrameResult } from "../eval/page-renderer.ts";
import { headersToRecord, type NetworkEventTracker } from "./network-events.ts";
import { effectiveExtraHeaders } from "./network.ts";
import { isWorkerUpstreamEvent } from "./dedicated-workers.ts";
import { isRecord } from "../guards.ts";
import { classifyRequest } from "../request-blocker.ts";
import { emitMutations } from "./dom.ts";
import { cookieKeyFor } from "./cookie-jar-registry.ts";
import { dropTargetImages } from "../eval/resource-store.ts";
import { documentKind, imageDocumentHtml } from "./document-kind.ts";
import {
  MAX_DOCUMENT_BYTES,
  MAX_STYLESHEET_BYTES,
  cappedErrorText,
  readCappedBytes,
  readCappedText,
} from "../read-capped.ts";
import {
  clearToolsForNavigate,
  emitToolsAdded,
  emitToolsRemoved,
  reconcileTools,
} from "./webmcp.ts";
import {
  emitFrameTarget,
  jarForTarget,
  announceOopifTarget,
  destroyOopifTarget,
} from "./target.ts";
import {
  ensureTargetDom,
  freeDetachedDom,
  releaseFrameDom,
  releaseTargetDom,
} from "./dom-release.ts";
import { clearStyleSheetsForNavigate, syncStyleSheetsFromEnumeration } from "./css.ts";
import { emitScriptParsed, hasDebuggerListeners, makeCompiledScriptMeta } from "./debugger.ts";
import type { ScriptBundle } from "../eval/script-bundle.ts";
import type { ParentScriptDescriptor, DocScan } from "../wasm.ts";
import type {
  LoadCompletion,
  ReceivedUpstreamParams,
  UpstreamEventName,
} from "@kitesurf/jsrpc-types/page-script";
import type { CdpMutation, ConsoleEntry, ExceptionEntry } from "@kitesurf/jsrpc-types/shared";
import type { RenderFrameArgs, PrespawnedFrame } from "../eval/oopif-render.ts";

const RENDER_DRAIN_TIMEOUT_MS = 10_000;
const RENDER_DRAIN_GRACE_MS = 2_500;

const MAX_CONSECUTIVE_AUTO_RELOADS = 3;
const AUTO_RELOAD_SETTLED_MS = 2_000;

const MILLISECONDS_PER_SECOND = 1_000;
const MAX_IMAGE_QUALITY = 100;
const DEFAULT_IMAGE_QUALITY = 80;
const MIN_SCREENCAST_DIMENSION = 32;
const MIN_SCREENCAST_FRAME_INTERVAL_MS = 16;
const MAX_SCREENCAST_FRAME_INTERVAL_MS = 1_000;
const MAX_SCREENCAST_EVERY_NTH_FRAME = 60;
const MAX_SCREENCAST_FRAMES_IN_FLIGHT = 8;
const MIN_ACK_POLL_INTERVAL_MS = 2;
const MAX_ACK_POLL_INTERVAL_MS = 8;
const DEFAULT_PDF_PAPER_WIDTH_INCHES = 8.5;
const DEFAULT_PDF_PAPER_HEIGHT_INCHES = 11;
const MAX_PDF_MARGIN_INCHES = 50;
const MAX_NAVIGATION_ERROR_SAMPLES = 3;
const MAX_NAVIGATION_ERROR_PREVIEW_CHARS = 120;
const MAX_CDP_DEBUG_ERROR_PREVIEW_CHARS = 80;
const MAX_FIRST_ERROR_CHARS = 300;
const MAX_PENDING_CHILD_POST_MESSAGES = 32;
const VALID_NAVIGATION_TRANSITIONS = [
  "link",
  "typed",
  "address_bar",
  "auto_bookmark",
  "auto_subframe",
  "manual_subframe",
  "generated",
  "auto_toplevel",
  "form_submit",
  "reload",
  "keyword",
  "keyword_generated",
  "other",
] as const satisfies readonly NavigationHistoryEntry["transitionType"][];
const VALID_NAVIGATION_TRANSITION_SET: ReadonlySet<string> = new Set(VALID_NAVIGATION_TRANSITIONS);

interface PdfPageLayout {
  width: number;
  height: number;
  cssPageSize: boolean;
  marginTopPx: number;
  marginRightPx: number;
  marginBottomPx: number;
  marginLeftPx: number;
}

function isNavigationTransitionType(
  value: string,
): value is NavigationHistoryEntry["transitionType"] {
  return VALID_NAVIGATION_TRANSITION_SET.has(value);
}

function partialKeyFor(ctx: DispatchCtx, target: TargetState): string | undefined {
  if (ctx.browser.skipPartialRaster) return undefined;
  // Scope retained pixels to this target and its current document generation.
  return `${target.targetId}:${target.navigateGeneration}`;
}

function hostOfUrl(url: string): string | null {
  try {
    const h = new URL(url).hostname;
    return h === "" ? null : h.toLowerCase();
  } catch {
    return null;
  }
}

function getRendererManager(ctx: DispatchCtx, target?: TargetState): PageRendererManager {
  if (!ctx.browser.rendererManager) {
    ctx.browser.rendererManager = new PageRendererManager(
      ctx.env,
      ctx.ctx,
      ctx.connectionId,
      ctx.browser.attributionHeaders,
      ctx.browser.workerBudget,
      rendererViewport(target),
    );
  }
  return ctx.browser.rendererManager;
}

function rendererViewport(target?: TargetState): { width: number; height: number } {
  return {
    width: target?.viewportWidth ?? DEFAULT_VIEWPORT_WIDTH,
    height: target?.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT,
  };
}

async function renderViaPageRenderer(
  ctx: DispatchCtx,
  target: TargetState,
  opts: {
    format: string;
    quality: number;
    omitBackground: boolean;
    sinceSeq?: number;
    clip?: { x: number; y: number; width: number; height: number };
    partialKey?: string;
    images?: "raw" | "encoded";
  },
): Promise<
  | {
      bytes?: Uint8Array;
      unchanged?: boolean;
      seq: number;
      scrollX: number;
      scrollY: number;
    }
  | { failed: string; stage: "record" | "rasterize" }
> {
  const manager = getRendererManager(ctx, target);
  const ps = target.pageScript;
  if (!ps) {
    return { failed: "no PageScript loaded", stage: "record" };
  }
  const tracer = ctx.env.HOST_TRACER;
  const traced = !!tracer && tracer.getSpanContext() !== null;
  const res = await traceSpan(tracer, "render.frame", () =>
    manager.renderFrame(ps, { ...opts, traced }),
  );
  return pageRendererFrameResult(res);
}

function pageRendererFrameResult(
  res: RenderFrameResult,
):
  | { bytes?: Uint8Array; unchanged?: boolean; seq: number; scrollX: number; scrollY: number }
  | { failed: string; stage: "record" | "rasterize" } {
  if (res.ok && res.unchanged === true) {
    return {
      unchanged: true,
      seq: res.seq,
      scrollX: res.scrollX,
      scrollY: res.scrollY,
    };
  }
  if (hasNoPageRendererFrameBytes(res)) return failedPageRendererFrame(res);
  return {
    bytes: res.bytes,
    seq: res.seq,
    scrollX: res.scrollX,
    scrollY: res.scrollY,
  };
}

function hasNoPageRendererFrameBytes(res: RenderFrameResult): boolean {
  return !res.ok || !res.bytes || res.bytes.length === 0;
}

function failedPageRendererFrame(res: RenderFrameResult): {
  failed: string;
  stage: "record" | "rasterize";
} {
  const reason = res.error ?? "unknown render failure";
  console.warn("kitesurf: pageRenderer renderFrame failed:", reason);
  return { failed: reason, stage: res.stage === "record" ? "record" : "rasterize" };
}

function recordNavigationHistory(target: TargetState, url: string, transitionType: string): void {
  if (transitionType === "back_forward") return;
  if (transitionType === "reload") {
    updateCurrentNavigationHistoryEntry(target, url);
    return;
  }
  appendNavigationHistoryEntry(target, url, transitionType);
}

function updateCurrentNavigationHistoryEntry(target: TargetState, url: string): void {
  const live = target.navigationHistory[target.navigationHistoryIndex];
  if (!live) return;
  live.url = url;
  live.userTypedURL = url;
}

function appendNavigationHistoryEntry(
  target: TargetState,
  url: string,
  transitionType: string,
): void {
  const outgoing = target.navigationHistory[target.navigationHistoryIndex];
  if (outgoing) outgoing.title = target.title;

  if (target.navigationHistoryIndex < target.navigationHistory.length - 1) {
    target.navigationHistory.length = target.navigationHistoryIndex + 1;
  }
  const tt = isNavigationTransitionType(transitionType) ? transitionType : "other";
  target.navigationHistory.push({
    id: target.nextNavigationHistoryId++,
    url,
    userTypedURL: url,
    title: "",
    transitionType: tt,
  });
  target.navigationHistoryIndex = target.navigationHistory.length - 1;
}

function clearPendingNavAbort(target: TargetState, navAbort: AbortController): void {
  if (target.pendingNavAbort === navAbort) target.pendingNavAbort = null;
}

function clearTimerIfSet(timer: ReturnType<typeof setTimeout> | null): void {
  if (timer !== null) clearTimeout(timer);
}

function returnScreenshotDomLease(
  target: TargetState,
  leased: DomHandle,
  epochAtLease: number,
): void {
  if (target.domEpoch === epochAtLease && target.dom === null) {
    target.dom = leased;
    return;
  }
  freeDetachedDom(leased, "[kitesurf-target]", {
    event: "screenshot_dom_free_failed",
    targetId: target.targetId,
    url: target.url,
  });
}

function finitePdfNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// PageScript JSON crosses an isolate boundary; narrow it before applying PDF settings.
function applyPdfPageBoxJson(
  json: string,
  preferCSSPageSize: boolean,
  layout: PdfPageLayout,
): void {
  const parsed = parsePdfPageBoxJson(json);
  if (!parsed) return;
  applyCssPageSize(parsed, preferCSSPageSize, layout);
  applyPdfPageMargins(parsed, layout);
}

function parsePdfPageBoxJson(json: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  return isRecord(parsed) && !Array.isArray(parsed) ? parsed : null;
}

function applyCssPageSize(
  parsed: Record<string, unknown>,
  preferCSSPageSize: boolean,
  layout: PdfPageLayout,
): void {
  const widthPt = finitePdfNumber(parsed.widthPt);
  const heightPt = finitePdfNumber(parsed.heightPt);
  const pageSize = preferCSSPageSize ? pdfCssPageSize(parsed, widthPt, heightPt) : null;
  if (!pageSize) return;
  layout.width = Math.round(pageSize.width * (96 / 72));
  layout.height = Math.round(pageSize.height * (96 / 72));
  layout.cssPageSize = true;
}

function pdfCssPageSize(
  parsed: Record<string, unknown>,
  widthPt: number | undefined,
  heightPt: number | undefined,
): { width: number; height: number } | null {
  if (parsed.hasSize !== true) return null;
  if (!widthPt || !heightPt) return null;
  return { width: widthPt, height: heightPt };
}

function applyPdfPageMargins(parsed: Record<string, unknown>, layout: PdfPageLayout): void {
  if (parsed.hasMargin !== true) return;
  layout.marginTopPx = pdfPageMarginPx(parsed.marginTopPt);
  layout.marginRightPx = pdfPageMarginPx(parsed.marginRightPt);
  layout.marginBottomPx = pdfPageMarginPx(parsed.marginBottomPt);
  layout.marginLeftPx = pdfPageMarginPx(parsed.marginLeftPt);
}

function pdfPageMarginPx(point: unknown): number {
  const value = finitePdfNumber(point);
  return value !== undefined && value > 0 ? value * (96 / 72) : 0;
}

async function restorePdfState(
  target: TargetState,
  previousMedia: TargetState["emulatedMedia"],
  backgroundSuppressed: boolean,
): Promise<void> {
  await restorePdfBackground(target, backgroundSuppressed);
  await restorePdfMedia(target, previousMedia);
}

async function restorePdfBackground(
  target: TargetState,
  backgroundSuppressed: boolean,
): Promise<void> {
  if (!backgroundSuppressed || !target.pageScript) return;
  try {
    await stubQueryDom(target.pageScript, "setSuppressBackgrounds", { enabled: false });
  } catch {}
}

async function restorePdfMedia(
  target: TargetState,
  previousMedia: TargetState["emulatedMedia"],
): Promise<void> {
  if (previousMedia === "print" || !target.pageScript) return;
  try {
    await stubQueryDom(target.pageScript, "setMediaType", { media: previousMedia, quiet: true });
    target.emulatedMedia = previousMedia;
  } catch {}
}

function consoleArgumentText(value: unknown): string {
  if (typeof value !== "object" || value === null) return String(value);
  return consoleObjectArgumentText(value);
}

function consoleObjectArgumentText(value: object): string {
  const description = "description" in value ? value.description : undefined;
  if (typeof description === "string" && description) return description;
  return consoleValueJsonText(value);
}

function consoleValueJsonText(value: object): string {
  const valueJson = "valueJson" in value ? value.valueJson : undefined;
  if (typeof valueJson === "string" && valueJson) {
    return parseConsoleValueJson(valueJson);
  }
  return JSON.stringify(value) ?? "";
}

function parseConsoleValueJson(valueJson: string): string {
  try {
    const parsed: unknown = JSON.parse(valueJson);
    return typeof parsed === "string" ? parsed : (JSON.stringify(parsed) ?? "");
  } catch {
    return valueJson;
  }
}

function firstConsoleWarningOrError(entries: ConsoleEntry[] | undefined): string | null {
  for (const entry of entries ?? []) {
    if (isConsoleWarningOrError(entry)) return consoleEntryMessage(entry);
  }
  return null;
}

function isConsoleWarningOrError(entry: ConsoleEntry): boolean {
  return entry.level === "error" || entry.level === "warning";
}

function consoleEntryMessage(entry: ConsoleEntry): string {
  const args: unknown[] = Array.isArray(entry.args) ? entry.args : [];
  return args.map(consoleArgumentText).join(" ").slice(0, MAX_FIRST_ERROR_CHARS);
}

// Kitesurf has no pinch zoom and ignores deviceScaleFactor, so scale and zoom
// are 1 and the deprecated device-pixel fields equal the CSS ones.
function layoutMetricsResponse(
  m: QueryDomResult<"layoutMetrics">,
): Protocol.Page.GetLayoutMetricsResponse {
  const layoutViewport: Protocol.Page.LayoutViewport = {
    pageX: m.scrollX,
    pageY: m.scrollY,
    clientWidth: m.viewportWidth,
    clientHeight: m.viewportHeight,
  };
  const visualViewport: Protocol.Page.VisualViewport = {
    offsetX: 0,
    offsetY: 0,
    pageX: m.scrollX,
    pageY: m.scrollY,
    clientWidth: m.viewportWidth,
    clientHeight: m.viewportHeight,
    scale: 1,
    zoom: 1,
  };
  const contentSize: Protocol.DOM.Rect = {
    x: 0,
    y: 0,
    width: m.contentWidth,
    height: m.contentHeight,
  };
  return {
    layoutViewport,
    visualViewport,
    contentSize,
    cssLayoutViewport: { ...layoutViewport },
    cssVisualViewport: { ...visualViewport },
    cssContentSize: { ...contentSize },
  };
}

type InternalHistoryNavigateRequest = Omit<
  Extract<CdpRequest, { method: "Page.navigate" }>,
  "params"
> & {
  params: Omit<CdpParamsOf<"Page.navigate">, "transitionType"> & {
    transitionType: "back_forward";
  };
};

type PageCommand = CdpRequest | InternalHistoryNavigateRequest;
type PagePrintToPDFRequest = Extract<PageCommand, { method: "Page.printToPDF" }>;
type PageStartScreencastRequest = Extract<PageCommand, { method: "Page.startScreencast" }>;
type PageHandler = (
  ctx: DispatchCtx,
  target: TargetState,
  req: PageCommand,
) => Promise<unknown> | unknown;

function emptyPageCommand(): Record<string, never> {
  return {};
}

const PAGE_HANDLERS: Partial<Record<PageCommand["method"], PageHandler>> = {
  "Page.enable": emptyPageCommand,
  "Page.disable": emptyPageCommand,
  "Page.setLifecycleEventsEnabled": emptyPageCommand,
  "Page.setInterceptFileChooserDialog": emptyPageCommand,
  "Page.getFrameTree": handlePageGetFrameTree,
  "Page.getResourceTree": handlePageGetResourceTree,
  "Page.getNavigationHistory": handlePageGetNavigationHistory,
  "Page.getLayoutMetrics": handlePageGetLayoutMetrics,
  "Page.navigateToHistoryEntry": handlePageNavigateToHistoryEntry,
  "Page.reload": handlePageReload,
  "Page.navigate": handlePageNavigate,
  "Page.addScriptToEvaluateOnNewDocument": handlePageAddScriptToEvaluateOnNewDocument,
  "Page.removeScriptToEvaluateOnNewDocument": handlePageRemoveScriptToEvaluateOnNewDocument,
  "Page.createIsolatedWorld": handlePageCreateIsolatedWorld,
  "Page.setBypassCSP": emptyPageCommand,
  "Page.stopLoading": emptyPageCommand,
  "Page.bringToFront": emptyPageCommand,
  "Page.handleJavaScriptDialog": emptyPageCommand,
  "Page.setDocumentContent": handlePageSetDocumentContent,
  "Page.captureScreenshot": handlePageCaptureScreenshot,
  "Page.printToPDF": handlePagePrintToPDF,
  "Page.startScreencast": handlePageStartScreencast,
  "Page.stopScreencast": handlePageStopScreencast,
  "Page.screencastFrameAck": handlePageScreencastFrameAck,
};

export async function handlePage(ctx: DispatchCtx, req: PageCommand): Promise<unknown> {
  const target = resolveTarget(ctx, req.sessionId);
  const handler = PAGE_HANDLERS[req.method];
  return handler ? handler(ctx, target, req) : {};
}

async function handlePageGetFrameTree(
  ctx: DispatchCtx,
  target: TargetState,
  req: PageCommand,
): Promise<unknown> {
  if (req.method !== "Page.getFrameTree") return {};
  {
    return { frameTree: buildFrameTree(target) };
  }
}

async function handlePageGetResourceTree(
  ctx: DispatchCtx,
  target: TargetState,
  req: PageCommand,
): Promise<unknown> {
  if (req.method !== "Page.getResourceTree") return {};
  {
    return { frameTree: buildFrameResourceTree(target) };
  }
}

async function handlePageGetNavigationHistory(
  ctx: DispatchCtx,
  target: TargetState,
  req: PageCommand,
): Promise<unknown> {
  if (req.method !== "Page.getNavigationHistory") return {};
  {
    const live = target.navigationHistory[target.navigationHistoryIndex];
    if (live) live.title = target.title;
    return {
      currentIndex: target.navigationHistoryIndex,
      entries: target.navigationHistory.map((e) => ({ ...e })),
    };
  }
}

async function handlePageGetLayoutMetrics(
  ctx: DispatchCtx,
  target: TargetState,
  req: PageCommand,
): Promise<unknown> {
  if (req.method !== "Page.getLayoutMetrics") return {};
  {
    // Playwright reads visualViewport before every screenshot. Never spawn
    // an isolate for this read: a target with no document is about:blank,
    // whose content size is the viewport.
    const metrics = await sessionOf(ctx, target).callIfLive.layoutMetrics({});
    if (metrics) return layoutMetricsResponse(metrics);
    const width = target.viewportWidth ?? DEFAULT_VIEWPORT_WIDTH;
    const height = target.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT;
    return layoutMetricsResponse({
      viewportWidth: width,
      viewportHeight: height,
      scrollX: 0,
      scrollY: 0,
      contentWidth: width,
      contentHeight: height,
    });
  }
}

async function handlePageNavigateToHistoryEntry(
  ctx: DispatchCtx,
  target: TargetState,
  req: PageCommand,
): Promise<unknown> {
  if (req.method !== "Page.navigateToHistoryEntry") return {};
  {
    const destination = findHistoryDestination(target, req.params?.entryId);
    if (destination.index === target.navigationHistoryIndex) return {};
    target.navigationHistoryIndex = destination.index;
    const navReq = {
      ...req,
      method: "Page.navigate",
      params: {
        url: destination.entry.url,
        transitionType: "back_forward",
        _kitesurfInternal: true,
      },
    } satisfies InternalHistoryNavigateRequest;
    await handlePage(ctx, navReq);
    return {};
  }
}

function findHistoryDestination(
  target: TargetState,
  entryId: unknown,
): { index: number; entry: NavigationHistoryEntry } {
  if (typeof entryId !== "number") {
    throw new Error("Page.navigateToHistoryEntry: entryId (integer) is required");
  }
  const index = target.navigationHistory.findIndex((entry) => entry.id === entryId);
  const entry = target.navigationHistory[index];
  if (index < 0 || !entry) {
    throw new Error(`Page.navigateToHistoryEntry: no entry with id ${entryId}`);
  }
  return { index, entry };
}

async function handlePageReload(
  ctx: DispatchCtx,
  target: TargetState,
  req: PageCommand,
): Promise<unknown> {
  if (req.method !== "Page.reload") return {};
  {
    const params = req.params || {};
    assertReloadLoaderId(params.loaderId, target.loaderId);
    const reloadUrl = target.url || "about:blank";
    logReloadRequest(ctx, target, req, reloadUrl);
    const reloadReq: CdpRequest = {
      ...req,
      method: "Page.navigate",
      params: { url: reloadUrl, transitionType: "reload", _kitesurfInternal: true },
    };
    return await handlePage(ctx, reloadReq);
  }
}

function assertReloadLoaderId(loaderId: unknown, currentLoaderId: string): void {
  if (typeof loaderId === "string" && loaderId !== currentLoaderId) {
    throw new Error(
      "Page.reload: loaderId mismatch (target navigated since the loaderId was issued)",
    );
  }
}

function logReloadRequest(
  ctx: DispatchCtx,
  target: TargetState,
  req: PageCommand,
  reloadUrl: string,
): void {
  if (!ctx.browser.cdpDebug) return;
  console.log(
    `[kitesurf-nav] Page.reload received id=${req.id} ` +
      `sessionId=${JSON.stringify(req.sessionId)} url=${reloadUrl} ` +
      `gen=${target.navigateGeneration}`,
  );
}

type PageNavigateRequest = Extract<PageCommand, { method: "Page.navigate" }>;

interface NavigationInput {
  url: string;
  postData: string | null;
  postContentType: string;
  referrer: unknown;
  transitionType: string;
  internal: boolean;
}

interface NavigationStart {
  abort: AbortController;
  loaderId: string;
}

interface NavigationDocumentSetup {
  requestId: string;
  headers: Record<string, string>;
  pageOrigin: string;
  outbound: ReturnType<SandboxOutboundOverride["parent"]>;
  body: Uint8Array | undefined;
}

type NavigationErrorResponse = { frameId: string; loaderId: string; errorText: string };
type NavigationFetchResult =
  | { ok: true; response: Response; finalUrl: string; requestId: string }
  | { ok: false; result: NavigationErrorResponse };
type NavigationBodyResult =
  | { ok: true; pageHtml: string; networkBody: { body: string; length: number } | null }
  | { ok: false; errorText: string };
type NavigationRedirectHop = Parameters<
  NonNullable<Parameters<typeof walkRedirects>[0]["onRedirect"]>
>[0];

async function handlePageNavigate(
  ctx: DispatchCtx,
  target: TargetState,
  req: PageCommand,
): Promise<unknown> {
  if (req.method !== "Page.navigate") return {};
  const input = navigationInput(req);
  validateNavigationUrl(input.url);
  logNavigationRequest(ctx, target, req, input.url);
  input.url = normalizeNavigationUrl(ctx, target, input.url, input.internal);
  const start = beginNavigation(target);
  resetTargetForNavigation(ctx, target, req, input.url, start.loaderId);
  if (isBlankNavigationUrl(input.url)) {
    return navigateToBlankDocument(ctx, target, req, input, start);
  }
  return loadNavigationDocument(ctx, target, req, input, start);
}

function navigationInput(req: PageNavigateRequest): NavigationInput {
  const params = req.params;
  return {
    url: navigationUrl(params),
    postData: navigationPostData(params),
    postContentType: navigationPostContentType(params),
    referrer: navigationReferrer(params),
    transitionType: navigationTransitionType(params),
    internal: isInternalNavigation(params),
  };
}

function navigationUrl(params: PageNavigateRequest["params"]): string {
  return params?.url ?? "about:blank";
}

function navigationPostData(params: PageNavigateRequest["params"]): string | null {
  return typeof params?._kitesurfPostData === "string" ? params._kitesurfPostData : null;
}

function navigationPostContentType(params: PageNavigateRequest["params"]): string {
  return typeof params?._kitesurfPostContentType === "string"
    ? params._kitesurfPostContentType
    : "application/x-www-form-urlencoded";
}

function navigationReferrer(params: PageNavigateRequest["params"]): unknown {
  return params?.referrer;
}

function navigationTransitionType(params: PageNavigateRequest["params"]): string {
  return params?.transitionType ?? "typed";
}

function isInternalNavigation(params: PageNavigateRequest["params"]): boolean {
  return params?._kitesurfInternal === true;
}

function validateNavigationUrl(url: string): void {
  if (isBlankNavigationUrl(url)) return;
  try {
    new URL(url);
  } catch {
    throw new Error("Cannot navigate to invalid URL");
  }
}

function logNavigationRequest(
  ctx: DispatchCtx,
  target: TargetState,
  req: PageNavigateRequest,
  url: string,
): void {
  if (!ctx.browser.cdpDebug) return;
  console.log(
    `[kitesurf-nav] Page.navigate received id=${req.id} ` +
      `sessionId=${JSON.stringify(req.sessionId)} url=${url} ` +
      `prevTargetUrl=${JSON.stringify(target.url)} ` +
      `gen=${target.navigateGeneration}`,
  );
}

function normalizeNavigationUrl(
  ctx: DispatchCtx,
  target: TargetState,
  url: string,
  internal: boolean,
): string {
  try {
    const parsed = new URL(url);
    target.refetchOnPushState = parsed.searchParams.get("ks_refetch_on_pushstate") === "1";
    if (parsed.searchParams.has("ks_refetch_on_pushstate")) {
      parsed.searchParams.delete("ks_refetch_on_pushstate");
      url = parsed.toString();
    }
    if (!internal && applyTtyNavParams(parsed.searchParams, ctx.browser)) {
      url = parsed.toString();
    }
  } catch {}
  return url;
}

function beginNavigation(target: TargetState): NavigationStart {
  target.pendingNavAbort?.abort();
  const abort = new AbortController();
  target.pendingNavAbort = abort;
  target.loaderId = makeTargetId();
  return { abort, loaderId: target.loaderId };
}

function resetTargetForNavigation(
  ctx: DispatchCtx,
  target: TargetState,
  req: PageNavigateRequest,
  url: string,
  loaderId: string,
): void {
  target.url = url;
  target.title = "";
  target.html = "";
  releaseTargetDom(target);
  target.docScan = null;
  target.docCsp = null;
  target.docCspReportOnly = null;
  target.docReferrerPolicy = null;
  target.docReferrer = null;
  target.docCharset = null;
  teardownOopifStubs(target, "parent navigate", ctx);
  ctx.browser.dedicatedWorkers.terminateTarget(target.targetId, "parent navigate");
  target.frames = new Map();
  target.frames.set(target.frameId, makeMainFrameState({ frameId: target.frameId, loaderId, url }));
  ctx.browser.networkEvents.setTargetAttribution(
    target.frameId,
    loaderId,
    targetSessionsNetwork(target, req.sessionId),
  );
  ctx.browser.networkEvents.dropStaleLoaderBodies(target.frameId);
}

function isBlankNavigationUrl(url: string): boolean {
  return url === "about:blank" || url === "";
}

async function navigateToBlankDocument(
  ctx: DispatchCtx,
  target: TargetState,
  req: PageNavigateRequest,
  input: NavigationInput,
  start: NavigationStart,
): Promise<unknown> {
  const html = "<html><head></head><body></body></html>";
  target.html = html;
  const baseUrl = sanitizeBaseUrl(input.url);
  try {
    target.dom = createDom(html, baseUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("kitesurf: navigate(about:blank) createDom trap:", message);
    target.dom = null;
    return { error: `navigate: wasm trap during parse: ${message}` };
  }
  const result = await pushNavigateToPageScript(ctx, target, html, baseUrl);
  recordNavigationHistory(target, input.url, input.transitionType);
  emitNavigationLifecycle(ctx, target, req.sessionId);
  emitExecutionContextCreated(ctx, target, req.sessionId);
  emitCapturedConsole(ctx, target, result.console, req.sessionId);
  emitCapturedExceptions(ctx, target, result.exceptions, req.sessionId);
  emitMutations(ctx, target, result.cdpMutations);
  clearPendingNavAbort(target, start.abort);
  return { frameId: target.frameId, loaderId: start.loaderId };
}

async function loadNavigationDocument(
  ctx: DispatchCtx,
  target: TargetState,
  req: PageNavigateRequest,
  input: NavigationInput,
  start: NavigationStart,
): Promise<unknown> {
  emitFrameStartedLoading(ctx, target, mainFrame(target), req.sessionId);
  try {
    const setup = beginNavigationDocumentRequest(ctx, target, input, start.loaderId);
    const fetched = await fetchNavigationDocument(ctx, target, input, start, setup);
    if (!fetched.ok) return fetched.result;
    return await finishNavigationResponse(ctx, target, req, input, start, fetched);
  } catch (error) {
    return navigationErrorResponse(target, start.loaderId, error);
  }
}

function navigationErrorResponse(
  target: TargetState,
  loaderId: string,
  error: unknown,
): NavigationErrorResponse {
  return {
    frameId: target.frameId,
    loaderId,
    errorText: error instanceof Error ? error.message : String(error),
  };
}

function beginNavigationDocumentRequest(
  ctx: DispatchCtx,
  target: TargetState,
  input: NavigationInput,
  loaderId: string,
): NavigationDocumentSetup {
  const headers = navigationRequestHeaders(ctx, target, input.url, input.referrer);
  target.docReferrer =
    Object.entries(headers).find(([name]) => name.toLowerCase() === "referer")?.[1] ?? null;
  if (input.postData !== null) headers["content-type"] = input.postContentType;
  const requestId = ctx.browser.networkEvents.beginRequest({
    url: input.url,
    method: input.postData !== null ? "POST" : "GET",
    headers,
    type: "Document",
    initiator: { type: "other" },
    loaderId,
    frameId: target.frameId,
    requestId: loaderId,
  });
  ctx.browser.networkEvents.drain();
  const pageOrigin = navigationPageOrigin(input.url);
  const outbound = ctx.browser.sandboxOutbound.parent({
    pageOrigin,
    mainFrameId: target.frameId,
    mainLoaderId: loaderId,
    interceptConnectionId: ctx.connectionId,
    cookieKey: cookieKeyFor(ctx.connectionId, target.browserContextId),
    allowDocumentBypass: true,
    skipRequestBlocker: true,
    topLevelDocument: true,
    walksOwnRedirects: true,
    extraHeaders: effectiveExtraHeaders(target),
  });
  return {
    requestId,
    headers,
    pageOrigin,
    outbound,
    body: navigationPostBody(input.postData),
  };
}

function navigationRequestHeaders(
  ctx: DispatchCtx,
  target: TargetState,
  url: string,
  referrer: unknown,
): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };
  const cookieHeader = jarForTarget(ctx, target).cookieHeaderForUrl(url);
  if (cookieHeader) headers.cookie = cookieHeader;
  if (typeof referrer === "string" && referrer) headers.referer = referrer;
  for (const [name, value] of Object.entries(effectiveExtraHeaders(target))) {
    headers[name] = value;
  }
  return headers;
}

function navigationPageOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function navigationPostBody(postData: string | null): Uint8Array | undefined {
  if (postData === null) return undefined;
  const body = new Uint8Array(postData.length);
  for (let index = 0; index < postData.length; index++) {
    body[index] = postData.charCodeAt(index) & 0xff;
  }
  return body;
}

async function fetchNavigationDocument(
  ctx: DispatchCtx,
  target: TargetState,
  input: NavigationInput,
  start: NavigationStart,
  setup: NavigationDocumentSetup,
): Promise<NavigationFetchResult> {
  const abortPromise = navigationAbortPromise(start.abort.signal);
  const siteState = { leftSite: false };
  try {
    const walk = await performNavigationRedirectWalk(
      ctx,
      target,
      input,
      start,
      setup,
      abortPromise,
      siteState,
    );
    return navigationFetchResult(ctx, target, start, setup.requestId, walk);
  } catch (error) {
    return navigationFetchFailure(ctx, target, start, setup.requestId, error);
  }
}

async function performNavigationRedirectWalk(
  ctx: DispatchCtx,
  target: TargetState,
  input: NavigationInput,
  start: NavigationStart,
  setup: NavigationDocumentSetup,
  abortPromise: Promise<never>,
  siteState: { leftSite: boolean },
): ReturnType<typeof walkRedirects> {
  return walkRedirects({
    url: input.url,
    method: input.postData !== null ? "POST" : "GET",
    body: setup.body,
    signal: start.abort.signal,
    headers: navigationRedirectHeaders(setup.headers, setup.pageOrigin, start.loaderId),
    cookieHeaderFor: (hopUrl) => navigationCookieHeader(ctx, target, hopUrl, siteState.leftSite),
    onSetCookie: (hopUrl, response) =>
      storeNavigationRedirectCookies(ctx, target, hopUrl, response),
    onRedirect: (hop) =>
      handleNavigationRedirect(ctx, target, setup.requestId, start.loaderId, hop, siteState),
    fetchHop: (hopRequest) => fetchNavigationHop(ctx, setup.outbound, hopRequest, abortPromise),
  });
}

function navigationFetchResult(
  ctx: DispatchCtx,
  target: TargetState,
  start: NavigationStart,
  requestId: string,
  walk: Awaited<ReturnType<typeof walkRedirects>>,
): NavigationFetchResult {
  if (!walk.ok) {
    ctx.browser.networkEvents.failRequest(requestId, "net::ERR_TOO_MANY_REDIRECTS");
    return {
      ok: false,
      result: navigationTextError(target, start.loaderId, "net::ERR_TOO_MANY_REDIRECTS"),
    };
  }
  target.docReferrer = walk.referrer || null;
  return { ok: true, response: walk.response, finalUrl: walk.finalUrl, requestId };
}

function navigationFetchFailure(
  ctx: DispatchCtx,
  target: TargetState,
  start: NavigationStart,
  requestId: string,
  error: unknown,
): NavigationFetchResult {
  const errorText = navErrorText(error, start.abort.signal.aborted);
  ctx.browser.networkEvents.failRequest(
    requestId,
    errorText ?? (error instanceof Error ? error.message : String(error)),
  );
  if (errorText) {
    return { ok: false, result: navigationTextError(target, start.loaderId, errorText) };
  }
  throw error;
}

function navigationAbortPromise(signal: AbortSignal): Promise<never> {
  const promise = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () =>
      reject(new DOMException("navigation replaced", "AbortError")),
    );
  });
  promise.catch(() => {});
  return promise;
}

function navigationTextError(
  target: TargetState,
  loaderId: string,
  errorText: string,
): NavigationErrorResponse {
  return { frameId: target.frameId, loaderId, errorText };
}

function navigationRedirectHeaders(
  headers: Record<string, string>,
  pageOrigin: string,
  loaderId: string,
): Record<string, string> {
  return {
    ...headers,
    "x-kitesurf-resource-type": "Document",
    "x-kitesurf-initiator": "parser",
    "x-kitesurf-allow-cross-origin": "1",
    "x-kitesurf-page-origin": pageOrigin,
    "x-kitesurf-network-id": loaderId,
  };
}

function navigationCookieHeader(
  ctx: DispatchCtx,
  target: TargetState,
  url: string,
  leftSite: boolean,
): string | null {
  return jarForTarget(ctx, target).cookieHeaderForUrl(
    url,
    leftSite ? { initiatorHost: null, topLevel: true } : undefined,
  );
}

function storeNavigationRedirectCookies(
  ctx: DispatchCtx,
  target: TargetState,
  url: string,
  response: Response,
): void {
  for (const cookie of readSetCookieHeaders(response)) {
    jarForTarget(ctx, target).setFromHeader(url, cookie);
  }
}

function handleNavigationRedirect(
  ctx: DispatchCtx,
  target: TargetState,
  requestId: string,
  loaderId: string,
  hop: NavigationRedirectHop,
  siteState: { leftSite: boolean },
): void {
  if (!siteState.leftSite && navigationRedirectLeavesSite(hop)) siteState.leftSite = true;
  ctx.browser.networkEvents.redirectRequest(requestId, {
    newUrl: hop.newUrl,
    method: hop.method,
    headers: withoutPlumbingHeaders(hop.headers),
    status: hop.status,
    statusText: hop.statusText,
    responseHeaders: headersToRecord(hop.responseHeaders),
    loaderId,
    frameId: target.frameId,
    type: "Document",
  });
}

function navigationRedirectLeavesSite(hop: NavigationRedirectHop): boolean {
  const from = hostOfUrl(hop.fromUrl);
  const to = hostOfUrl(hop.newUrl);
  return from === null || to === null || siteKey(from) !== siteKey(to);
}

async function fetchNavigationHop(
  ctx: DispatchCtx,
  outbound: NavigationDocumentSetup["outbound"],
  hopRequest: Parameters<Parameters<typeof walkRedirects>[0]["fetchHop"]>[0],
  abortPromise: Promise<never>,
): Promise<Response> {
  const fetchPromise = traceSpan(
    ctx.env.HOST_TRACER,
    "navigate.fetch_document",
    () => outbound.fetch(hopRequest),
    { url: redactUrl(hopRequest.url) },
  );
  fetchPromise.catch(() => {});
  return Promise.race([fetchPromise, abortPromise]);
}

async function finishNavigationResponse(
  ctx: DispatchCtx,
  target: TargetState,
  req: PageNavigateRequest,
  input: NavigationInput,
  start: NavigationStart,
  fetched: Extract<NavigationFetchResult, { ok: true }>,
): Promise<unknown> {
  const { response, finalUrl, requestId } = fetched;
  const kind = documentKind(response.headers);
  if (shouldAbortNavigationResponse(response, kind)) {
    return abortNavigationResponse(ctx, target, response, finalUrl, requestId, start);
  }
  applyNavigationResponseHeaders(target, response, finalUrl, input.transitionType);
  storeNavigationResponseCookies(ctx, target, finalUrl, response);
  const contentType = response.headers.get("content-type") ?? "text/html";
  const body = await readNavigationBody(ctx, target, response, kind, finalUrl, contentType);
  if (!body.ok) return failNavigationBody(ctx, target, requestId, start, body.errorText);
  completeNavigationNetworkRequest(ctx, response, finalUrl, requestId, contentType, body);
  emitMainFrameNavigation(ctx, target, finalUrl, req.sessionId);
  const pageHtml = pageHtmlWithoutNoscript(target, body.pageHtml);
  startNavigationChildFrames(ctx, target, req.sessionId);
  return await completePageScriptNavigation(ctx, target, req, start, pageHtml, finalUrl);
}

function shouldAbortNavigationResponse(
  response: Response,
  kind: ReturnType<typeof documentKind>,
): boolean {
  return response.status === 204 || response.status === 205 || kind === "blocked";
}

function abortNavigationResponse(
  ctx: DispatchCtx,
  target: TargetState,
  response: Response,
  url: string,
  requestId: string,
  start: NavigationStart,
): NavigationErrorResponse {
  void response.body?.cancel().catch(() => {});
  ctx.browser.networkEvents.completeRequest(requestId, {
    url,
    status: response.status,
    statusText: response.statusText,
    headers: headersToRecord(response.headers),
    mimeType: (response.headers.get("content-type")?.split(";")[0] ?? "").trim() || "text/html",
    bodyLength: 0,
    errorText: "net::ERR_ABORTED",
  });
  ctx.browser.networkEvents.drain();
  clearPendingNavAbort(target, start.abort);
  return navigationTextError(target, start.loaderId, "net::ERR_ABORTED");
}

function applyNavigationResponseHeaders(
  target: TargetState,
  response: Response,
  finalUrl: string,
  transitionType: string,
): void {
  target.url = finalUrl;
  target.docReferrerPolicy = response.headers.get("referrer-policy");
  target.docCsp = response.headers.get("content-security-policy");
  target.docCspReportOnly = response.headers.get("content-security-policy-report-only");
  recordNavigationHistory(target, finalUrl, transitionType);
}

function storeNavigationResponseCookies(
  ctx: DispatchCtx,
  target: TargetState,
  url: string,
  response: Response,
): void {
  for (const cookie of readSetCookieHeaders(response)) {
    jarForTarget(ctx, target).setFromHeader(url, cookie);
  }
}

async function readNavigationBody(
  ctx: DispatchCtx,
  target: TargetState,
  response: Response,
  kind: ReturnType<typeof documentKind>,
  finalUrl: string,
  contentType: string,
): Promise<NavigationBodyResult> {
  if (kind === "html") {
    return readHtmlNavigationBody(ctx, target, response, contentType);
  }
  return readWrappedNavigationBody(target, response, kind, finalUrl, contentType);
}

async function readHtmlNavigationBody(
  ctx: DispatchCtx,
  target: TargetState,
  response: Response,
  contentType: string,
): Promise<NavigationBodyResult> {
  const read = await traceSpan(ctx.env.HOST_TRACER, "navigate.read_document_body", () =>
    readCappedBytes(response, MAX_DOCUMENT_BYTES),
  );
  if (!read.ok) return { ok: false, errorText: cappedErrorText(read.failure) };
  const decoded = decodeHtmlBytes(read.bytes, contentType);
  const html = normalizeXhtmlDocument(decoded.html, contentType);
  target.docCharset = decoded.charset;
  target.html = html;
  releaseTargetDom(target);
  target.docScan = traceSpan(
    ctx.env.HOST_TRACER,
    "navigate.scan_document",
    () => scanDocument(html),
    { bytes: html.length },
  );
  target.title = target.docScan.title;
  return { ok: true, pageHtml: html, networkBody: null };
}

function normalizeXhtmlDocument(html: string, contentType: string): string {
  const sniffHead = html.replace(/^\uFEFF?\s*/, "");
  if (!contentType.includes("application/xhtml") || !sniffHead.startsWith("<html")) return html;
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + sniffHead;
}

async function readWrappedNavigationBody(
  target: TargetState,
  response: Response,
  kind: ReturnType<typeof documentKind>,
  finalUrl: string,
  contentType: string,
): Promise<NavigationBodyResult> {
  const read = await readCappedBytes(response, MAX_DOCUMENT_BYTES);
  if (!read.ok) return { ok: false, errorText: cappedErrorText(read.failure) };
  const wrapped = wrapNavigationDocument(read.bytes, kind, finalUrl, contentType, target);
  releaseTargetDom(target);
  target.docScan = scanDocument(wrapped.html);
  target.html = wrapped.html;
  return { ok: true, pageHtml: wrapped.html, networkBody: wrapped.networkBody };
}

function wrapNavigationDocument(
  bytes: Uint8Array,
  kind: ReturnType<typeof documentKind>,
  finalUrl: string,
  contentType: string,
  target: TargetState,
): { html: string; networkBody: { body: string; length: number } | null } {
  if (kind === "image") {
    const base64 = bytesToBase64(bytes);
    return {
      html: imageDocumentHtml(bytes, base64, contentType, finalUrl),
      networkBody: { body: base64, length: bytes.byteLength },
    };
  }
  const text = new TextDecoder().decode(bytes);
  return {
    html: wrapNavigationText(text, kind, finalUrl, target),
    networkBody: null,
  };
}

function wrapNavigationText(
  text: string,
  kind: ReturnType<typeof documentKind>,
  finalUrl: string,
  target: TargetState,
): string {
  if (kind === "json") return jsonViewerHtml(text, finalUrl);
  if (kind === "svg") {
    return svgDocumentHtml(text, {
      width: target.viewportWidth ?? DEFAULT_VIEWPORT_WIDTH,
      height: target.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT,
    });
  }
  return `<html><head></head><body><pre>${escapeHtml(text)}</pre></body></html>`;
}

function failNavigationBody(
  ctx: DispatchCtx,
  target: TargetState,
  requestId: string,
  start: NavigationStart,
  errorText: string,
): NavigationErrorResponse {
  ctx.browser.networkEvents.failRequest(requestId, errorText);
  clearPendingNavAbort(target, start.abort);
  return navigationTextError(target, start.loaderId, errorText);
}

function completeNavigationNetworkRequest(
  ctx: DispatchCtx,
  response: Response,
  finalUrl: string,
  requestId: string,
  contentType: string,
  body: Extract<NavigationBodyResult, { ok: true }>,
): void {
  const bodyFields = navigationNetworkBodyFields(body);
  ctx.browser.networkEvents.completeRequest(requestId, {
    url: finalUrl,
    status: response.status,
    statusText: response.statusText,
    headers: headersToRecord(response.headers),
    mimeType: navigationMimeType(contentType),
    ...bodyFields,
  });
  ctx.browser.networkEvents.drain();
}

function navigationMimeType(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim() || "text/html";
}

function navigationNetworkBodyFields(body: Extract<NavigationBodyResult, { ok: true }>): {
  bodyLength: number;
  body: string;
  bodyBase64Encoded: boolean;
} {
  return {
    bodyLength: navigationNetworkBodyLength(body),
    body: navigationNetworkBodyText(body),
    bodyBase64Encoded: body.networkBody !== null,
  };
}

function navigationNetworkBodyLength(body: Extract<NavigationBodyResult, { ok: true }>): number {
  return body.networkBody ? body.networkBody.length : body.pageHtml.length;
}

function navigationNetworkBodyText(body: Extract<NavigationBodyResult, { ok: true }>): string {
  return body.networkBody ? body.networkBody.body : body.pageHtml;
}

function emitMainFrameNavigation(
  ctx: DispatchCtx,
  target: TargetState,
  finalUrl: string,
  sessionId: string | undefined,
): void {
  const frame = mainFrame(target);
  frame.url = finalUrl;
  frame.securityOrigin = originOf(finalUrl);
  emitFrameNavigated(ctx, target, frame, sessionId);
}

function pageHtmlWithoutNoscript(target: TargetState, pageHtml: string): string {
  return target.docScan
    ? pageHtml.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, "")
    : pageHtml;
}

function startNavigationChildFrames(
  ctx: DispatchCtx,
  target: TargetState,
  sessionId: string | undefined,
): void {
  rebuildFrameTreeChildren(target);
  const childFrames = [...target.frames.values()].filter(
    (frame) => frame.parentFrameId !== null && frame.lifecycle === "init",
  );
  emitChildFrameAttachAndStart(ctx, childFrames, targetSessions(target, sessionId));
  resetPrespawnBudget(target);
  for (const frame of target.frames.values()) {
    startNavigationChildFrame(ctx, target, frame, sessionId);
  }
}

function startNavigationChildFrame(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
  sessionId: string | undefined,
): void {
  if (!shouldStartNavigationChildFrame(frame)) return;
  if (needsOopifPrespawn(frame)) {
    frame.readyState = "complete";
    frame.pendingLoad = Promise.resolve();
    prespawnOopifFrame(ctx, target, frame);
    return;
  }
  frame.pendingLoad = loadChildFrame(ctx, target, frame, sessionId);
}

function shouldStartNavigationChildFrame(frame: FrameState): boolean {
  return frame.parentFrameId !== null && frame.lifecycle === "init";
}

function needsOopifPrespawn(frame: FrameState): boolean {
  return frame.isCrossOrigin || frame.url === "about:blank" || frame.url === "";
}

async function completePageScriptNavigation(
  ctx: DispatchCtx,
  target: TargetState,
  req: PageNavigateRequest,
  start: NavigationStart,
  html: string,
  finalUrl: string,
): Promise<unknown> {
  const armedIframeGate = navigateOwesIframeInstalls(target);
  const result = await pushNavigateToPageScript(ctx, target, html, finalUrl, armedIframeGate);
  if (target.pageScript) releaseTargetDom(target);
  await backfillIframeOwnerNodeIds(target);
  emitFrameDclComplete(ctx, target, mainFrame(target), req.sessionId);
  scheduleLoadCompleteEmit(ctx, target, req.sessionId, armedIframeGate);
  emitExecutionContextCreated(ctx, target, req.sessionId);
  emitDocumentUpdated(ctx, target, req.sessionId);
  emitCapturedConsole(ctx, target, result.console, req.sessionId);
  emitCapturedExceptions(ctx, target, result.exceptions, req.sessionId);
  emitMutations(ctx, target, result.cdpMutations);
  if (target.pendingNavAbort === start.abort) target.pendingNavAbort = null;
  return { frameId: target.frameId, loaderId: start.loaderId };
}

async function handlePageAddScriptToEvaluateOnNewDocument(
  ctx: DispatchCtx,
  target: TargetState,
  req: PageCommand,
): Promise<unknown> {
  if (req.method !== "Page.addScriptToEvaluateOnNewDocument") return {};
  {
    const id = crypto.randomUUID();
    const source = typeof req.params?.source === "string" ? req.params.source : "";
    if (source) {
      ctx.browser.preNavScripts.set(id, source);
    }
    return { identifier: id };
  }
}

async function handlePageRemoveScriptToEvaluateOnNewDocument(
  ctx: DispatchCtx,
  target: TargetState,
  req: PageCommand,
): Promise<unknown> {
  if (req.method !== "Page.removeScriptToEvaluateOnNewDocument") return {};
  {
    const id = typeof req.params?.identifier === "string" ? req.params.identifier : null;
    if (id) ctx.browser.preNavScripts.delete(id);
    return {};
  }
}

async function handlePageCreateIsolatedWorld(
  ctx: DispatchCtx,
  target: TargetState,
  req: PageCommand,
): Promise<unknown> {
  if (req.method !== "Page.createIsolatedWorld") return {};
  {
    const targetForIsoWorld = isolatedWorldTarget(ctx, req.sessionId);
    const worldName = isolatedWorldName(req.params?.worldName);
    const frameId = isolatedWorldFrameId(req.params?.frameId, targetForIsoWorld);
    const existing = findIsolatedWorld(targetForIsoWorld, worldName, frameId);
    if (hasCreatedIsolatedWorld(existing)) {
      return { executionContextId: existing.id };
    }
    const id = ctx.browser.execContextSeq++;
    registerIsolatedWorld(targetForIsoWorld, existing, worldName, frameId, id);
    emitIsolatedWorldCreated(ctx, targetForIsoWorld, req.sessionId, worldName, frameId, id);
    return { executionContextId: id };
  }
}

function isolatedWorldTarget(ctx: DispatchCtx, sessionId: string | undefined): TargetState | null {
  try {
    return resolveTarget(ctx, sessionId);
  } catch {
    return null;
  }
}

function isolatedWorldName(worldName: string | undefined): string {
  return worldName ?? "";
}

function isolatedWorldFrameId(frameId: string | undefined, target: TargetState | null): string {
  return frameId ?? target?.frameId ?? "";
}

type IsolatedWorld = NonNullable<TargetState["isolatedWorlds"]>[number];

function findIsolatedWorld(
  target: TargetState | null,
  worldName: string,
  frameId: string,
): IsolatedWorld | undefined {
  return target?.isolatedWorlds?.find(
    (world) => world.name === worldName && world.frameId === frameId,
  );
}

function hasCreatedIsolatedWorld(world: IsolatedWorld | undefined): world is IsolatedWorld {
  return world !== undefined && world.id > 0;
}

function registerIsolatedWorld(
  target: TargetState | null,
  existing: IsolatedWorld | undefined,
  worldName: string,
  frameId: string,
  id: number,
): void {
  if (existing) {
    existing.id = id;
    return;
  }
  if (!target) return;
  (target.isolatedWorlds ??= []).push({ name: worldName, frameId, id });
}

function emitIsolatedWorldCreated(
  ctx: DispatchCtx,
  target: TargetState | null,
  sessionId: string | undefined,
  worldName: string,
  frameId: string,
  id: number,
): void {
  ctx.emit({
    method: "Runtime.executionContextCreated",
    params: {
      context: {
        id,
        origin: target ? originOf(target.url) : "",
        name: worldName,
        uniqueId: `cs-iso-${target?.targetId ?? "?"}-${id}`,
        auxData: { isDefault: false, type: "isolated", frameId },
      },
    },
    sessionId,
  });
}

async function handlePageSetDocumentContent(
  ctx: DispatchCtx,
  target: TargetState,
  req: PageCommand,
): Promise<unknown> {
  if (req.method !== "Page.setDocumentContent") return {};
  {
    if (target.type !== "page") return { error: "setDocumentContent requires a page target" };
    const html = pageDocumentContentHtml(req);
    const url = pageDocumentContentUrl(target);
    resetDocumentContentState(target, html, url);
    ctx.browser.dedicatedWorkers.terminateTarget(target.targetId, "setDocumentContent");
    const {
      console: capturedConsole,
      cdpMutations,
      exceptions,
    } = await pushNavigateToPageScript(ctx, target, html, url);
    teardownOopifStubs(target, "setDocumentContent", ctx);
    target.frames = new Map();
    target.frames.set(
      target.frameId,
      makeMainFrameState({
        frameId: target.frameId,
        loaderId: target.loaderId,
        url: target.url,
      }),
    );
    emitSetDocumentContentEvents(
      ctx,
      target,
      req.sessionId,
      capturedConsole,
      exceptions,
      cdpMutations,
    );
    releaseDocumentContentDom(target);
    return {};
  }
}

function pageDocumentContentHtml(req: PageCommand): string {
  if (req.method !== "Page.setDocumentContent") return "";
  return req.params?.html ?? "";
}

function pageDocumentContentUrl(target: TargetState): string {
  return sanitizeBaseUrl(target.url || "about:blank");
}

function releaseDocumentContentDom(target: TargetState): void {
  if (target.pageScript) releaseTargetDom(target);
}

function resetDocumentContentState(target: TargetState, html: string, url: string): void {
  target.url = url;
  target.html = html;
  releaseTargetDom(target);
  target.docScan = null;
  target.docCsp = null;
  target.docCspReportOnly = null;
  target.docCharset = null;
  if (url === "https://kitesurf.local/") return;
  target.docScan = scanDocument(html);
  target.title = target.docScan.title;
}

function emitSetDocumentContentEvents(
  ctx: DispatchCtx,
  target: TargetState,
  sessionId: string | undefined,
  capturedConsole: ConsoleEntry[],
  exceptions: ExceptionEntry[] | undefined,
  cdpMutations: CdpMutation[] | undefined,
): void {
  emitNavigationLifecycle(ctx, target, sessionId);
  emitExecutionContextCreated(ctx, target, sessionId);
  emitCapturedConsole(ctx, target, capturedConsole, sessionId);
  emitCapturedExceptions(ctx, target, exceptions, sessionId);
  emitMutations(ctx, target, cdpMutations);
}

type PageCaptureRequest = Extract<PageCommand, { method: "Page.captureScreenshot" }>;
type ScreenshotClip = NonNullable<PageCaptureRequest["params"]>["clip"];
type ScreenshotFormat = "png" | "jpeg" | "webp";
type ScreenshotClipRect = { x: number; y: number; width: number; height: number };
type PageFrameRenderResult = Awaited<ReturnType<typeof renderViaPageRenderer>>;

interface ScreenshotOptions {
  format: ScreenshotFormat;
  quality: number;
  omitBackground: boolean;
  clip: ScreenshotClip;
}

interface ScreenshotDrainResult {
  startedAt: number;
  elapsedMs: number;
  info: Record<string, unknown> | null;
}

async function handlePageCaptureScreenshot(
  ctx: DispatchCtx,
  target: TargetState,
  req: PageCommand,
): Promise<unknown> {
  if (req.method !== "Page.captureScreenshot") return {};
  try {
    const options = screenshotOptions(req);
    const pageScript = target.pageScript;
    if (pageScript) return await captureScreenshotFromPageScript(ctx, target, pageScript, options);
    return await captureScreenshotFromDom(ctx, target, options);
  } catch (error) {
    return screenshotFailure(error);
  }
}

function screenshotOptions(req: PageCaptureRequest): ScreenshotOptions {
  return {
    format: requestedScreenshotFormat(req.params?.format),
    quality: requestedScreenshotQuality(req.params?.quality),
    omitBackground: req.params?.omitBackground === true,
    clip: req.params?.clip,
  };
}

function requestedScreenshotFormat(format: string | undefined): ScreenshotFormat {
  if (format === "jpeg" || format === "webp") return format;
  return "png";
}

function requestedScreenshotQuality(quality: number | undefined): number {
  if (typeof quality === "number" && quality >= 1 && quality <= MAX_IMAGE_QUALITY) return quality;
  return DEFAULT_IMAGE_QUALITY;
}

async function captureScreenshotFromPageScript(
  ctx: DispatchCtx,
  target: TargetState,
  pageScript: PageScriptStub,
  options: ScreenshotOptions,
): Promise<{ data: string }> {
  const startedAt = Date.now();
  const drain = await drainScreenshotResources(ctx, pageScript, options.clip);
  await captureOopifFrames(
    ctx,
    target,
    startedAt + RENDER_DRAIN_TIMEOUT_MS + RENDER_DRAIN_GRACE_MS - Date.now(),
  );
  const rpcStartedAt = Date.now();
  const result = await renderViaPageRenderer(
    ctx,
    target,
    pageRendererScreenshotOptions(ctx, target, options),
  );
  const renderMs = Date.now() - rpcStartedAt;
  logScreenshotPhases(ctx, target, drain, renderMs);
  return screenshotRendererData(result);
}

function pageRendererScreenshotOptions(
  ctx: DispatchCtx,
  target: TargetState,
  options: ScreenshotOptions,
): Parameters<typeof renderViaPageRenderer>[2] {
  const rendererOptions: Parameters<typeof renderViaPageRenderer>[2] = {
    format: options.format,
    quality: options.quality,
    omitBackground: options.omitBackground,
  };
  if (options.clip) rendererOptions.clip = options.clip;
  if (!ctx.browser.screencasts.has(target.targetId)) {
    rendererOptions.partialKey = partialKeyFor(ctx, target);
  }
  return rendererOptions;
}

async function drainScreenshotResources(
  ctx: DispatchCtx,
  pageScript: PageScriptStub,
  clip: ScreenshotClip,
): Promise<ScreenshotDrainResult> {
  const startedAt = Date.now();
  let info: Record<string, unknown> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    const drain = stubQueryDom(pageScript, "awaitPendingResources", {
      timeoutMs: RENDER_DRAIN_TIMEOUT_MS,
      scope: screenshotDrainScope(clip),
    }).catch(() => null);
    const result = await traceSpan(ctx.env.HOST_TRACER, "screenshot.drain_resources", () =>
      Promise.race([
        drain,
        new Promise((resolve) => {
          graceTimer = setTimeout(
            () => resolve({ raced: true }),
            RENDER_DRAIN_TIMEOUT_MS + RENDER_DRAIN_GRACE_MS,
          );
        }),
      ]),
    );
    info = screenshotDrainInfo(result);
  } catch {
  } finally {
    clearTimerIfSet(graceTimer);
  }
  return { startedAt, elapsedMs: Date.now() - startedAt, info };
}

function screenshotDrainScope(
  clip: ScreenshotClip,
): { mode: "rect"; x: number; y: number; w: number; h: number } | { mode: "viewport" } {
  const rect = screenshotClipRect(clip);
  return rect
    ? { mode: "rect", x: rect.x, y: rect.y, w: rect.width, h: rect.height }
    : { mode: "viewport" };
}

function screenshotClipRect(clip: ScreenshotClip): ScreenshotClipRect | null {
  if (!clip || typeof clip !== "object") return null;
  const { x, y, width, height } = clip;
  return screenshotClipRectFromCoordinates(x, y, width, height);
}

function screenshotClipRectFromCoordinates(
  x: unknown,
  y: unknown,
  width: unknown,
  height: unknown,
): ScreenshotClipRect | null {
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    return null;
  }
  return { x, y, width, height };
}

function screenshotDrainInfo(result: unknown): Record<string, unknown> | null {
  return isRecord(result) && !Array.isArray(result) ? result : null;
}

function logScreenshotPhases(
  ctx: DispatchCtx,
  target: TargetState,
  drain: ScreenshotDrainResult,
  renderMs: number,
): void {
  const detail = screenshotDrainDetail(drain.info, drain.elapsedMs);
  if (!ctx.browser.cdpDebug && !detail && drain.elapsedMs + renderMs <= 1_000) return;
  console.log(
    `[screenshot] phases: drain=${drain.elapsedMs}ms render=${renderMs}ms ` +
      `url=${target.url ?? "?"}${detail}`,
  );
}

function screenshotDrainDetail(info: Record<string, unknown> | null, elapsedMs: number): string {
  if (!info) return "";
  if (info.raced !== true && info.timedOut !== true && elapsedMs <= 2_000) return "";
  return ` drainDetail=${JSON.stringify(info)}`;
}

function screenshotRendererData(result: PageFrameRenderResult): { data: string } {
  if ("failed" in result) {
    throw new Error(`Page.captureScreenshot failed: ${result.failed}`);
  }
  const bytes = result.bytes;
  if (!bytes || bytes.length === 0) {
    throw new Error("Page.captureScreenshot failed: renderer returned no bytes");
  }
  return { data: bytesToBase64(bytes) };
}

async function captureScreenshotFromDom(
  ctx: DispatchCtx,
  target: TargetState,
  options: ScreenshotOptions,
): Promise<{ data: string; error?: string }> {
  const pageUrl = target.url || "https://kitesurf.local/";
  const html = await screenshotDocumentHtml(ctx, target, pageUrl);
  if (!html) return { data: TINY_TRANSPARENT_PNG_B64 };
  return renderScreenshotHtml(target, html, pageUrl, options);
}

async function screenshotDocumentHtml(
  ctx: DispatchCtx,
  target: TargetState,
  pageUrl: string,
): Promise<string | null> {
  const leased = ensureTargetDom(target);
  if (!leased) return null;
  const epochAtLease = target.domEpoch;
  target.dom = null;
  try {
    await inlineStylesheets(
      leased,
      pageUrl,
      ctx.browser.sandboxOutbound,
      ctx.browser.styleCache,
      ctx.browser.networkEvents,
      target.loaderId,
      target.frameId,
    );
    return leased.outerHTML(0);
  } finally {
    returnScreenshotDomLease(target, leased, epochAtLease);
  }
}

async function renderScreenshotHtml(
  target: TargetState,
  html: string,
  pageUrl: string,
  options: ScreenshotOptions,
): Promise<{ data: string; error?: string }> {
  const width = target.viewportWidth ?? DEFAULT_VIEWPORT_WIDTH;
  const height = target.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT;
  const { renderHtmlToImage } = await import("../wasm.ts");
  const bytes = renderHtmlToImage(html, pageUrl, width, height, options.format, options.quality);
  if (bytes.length === 0) {
    return { data: TINY_TRANSPARENT_PNG_B64, error: "renderHtmlToImage returned empty" };
  }
  return { data: bytesToBase64(bytes) };
}

function screenshotFailure(error: unknown): { data: string; error?: string } {
  if (error instanceof Error && error.message.startsWith("Page.captureScreenshot failed:")) {
    throw error;
  }
  return {
    data: TINY_TRANSPARENT_PNG_B64,
    error: error instanceof Error ? error.message : String(error),
  };
}

async function handlePagePrintToPDF(
  ctx: DispatchCtx,
  target: TargetState,
  req: PageCommand,
): Promise<unknown> {
  if (req.method !== "Page.printToPDF") return {};
  return printPageToPdf(ctx, target, req);
}

interface PdfRequestOptions {
  layout: PdfPageLayout;
  preferCSSPageSize: boolean;
  printBackground: boolean;
  omitBackground: boolean;
  landscape: boolean;
}

function pdfRequestMargin(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_PDF_MARGIN_INCHES) * 96
    : 0;
}

function pdfPaperDimension(value: unknown, fallback: number): number {
  return typeof value === "number" && value > 0 ? value : fallback;
}

function defaultPdfLayout(): PdfPageLayout {
  return {
    width: Math.round(DEFAULT_PDF_PAPER_WIDTH_INCHES * 96),
    height: Math.round(DEFAULT_PDF_PAPER_HEIGHT_INCHES * 96),
    cssPageSize: false,
    marginTopPx: 0,
    marginRightPx: 0,
    marginBottomPx: 0,
    marginLeftPx: 0,
  };
}

function pdfLayoutFromParams(params: PagePrintToPDFRequest["params"]): PdfPageLayout {
  if (!params) return defaultPdfLayout();
  return {
    width: Math.round(pdfPaperDimension(params.paperWidth, DEFAULT_PDF_PAPER_WIDTH_INCHES) * 96),
    height: Math.round(pdfPaperDimension(params.paperHeight, DEFAULT_PDF_PAPER_HEIGHT_INCHES) * 96),
    cssPageSize: false,
    marginTopPx: pdfRequestMargin(params.marginTop),
    marginRightPx: pdfRequestMargin(params.marginRight),
    marginBottomPx: pdfRequestMargin(params.marginBottom),
    marginLeftPx: pdfRequestMargin(params.marginLeft),
  };
}

async function printPageToPdf(
  ctx: DispatchCtx,
  target: TargetState,
  req: PagePrintToPDFRequest,
): Promise<unknown> {
  const pdfPs = target.pageScript;
  if (!pdfPs) {
    return {
      data: EMPTY_PDF_B64,
      error: "no PageScript for target (PDF requires live paint dom)",
    };
  }
  const options = pdfRequestOptions(req);
  const { layout, preferCSSPageSize, printBackground, omitBackground, landscape } = options;
  const previousMedia = target.emulatedMedia;
  let backgroundSuppressed = false;
  try {
    await preparePdfDocument(target, pdfPs, previousMedia, preferCSSPageSize, landscape, layout);
    await drainPdfResources(ctx, pdfPs);
    backgroundSuppressed = await suppressPdfBackground(pdfPs, printBackground);
    return await renderPagePdf(ctx, target, pdfPs, layout, omitBackground);
  } catch (err) {
    return pdfFailure(err);
  } finally {
    await restorePdfState(target, previousMedia, backgroundSuppressed);
  }
}

function pdfRequestOptions(req: PagePrintToPDFRequest): PdfRequestOptions {
  const params = req.params;
  return {
    layout: pdfLayoutFromParams(params),
    preferCSSPageSize: params?.preferCSSPageSize === true,
    printBackground: params?.printBackground === true,
    omitBackground: params?.omitBackground === true,
    landscape: params?.landscape === true,
  };
}

async function preparePdfDocument(
  target: TargetState,
  pageScript: PageScriptStub,
  previousMedia: TargetState["emulatedMedia"],
  preferCSSPageSize: boolean,
  landscape: boolean,
  layout: PdfPageLayout,
): Promise<void> {
  if (previousMedia !== "print") {
    try {
      await stubQueryDom(pageScript, "setMediaType", { media: "print", quiet: true });
      target.emulatedMedia = "print";
    } catch {}
  }
  await applyPdfDocumentBox(pageScript, preferCSSPageSize, layout);
  if (landscape && !layout.cssPageSize) swapPdfLayoutDimensions(layout);
}

async function applyPdfDocumentBox(
  pageScript: PageScriptStub,
  preferCSSPageSize: boolean,
  layout: PdfPageLayout,
): Promise<void> {
  try {
    const response = await stubQueryDom(pageScript, "pageBoxJson", {});
    if (response?.ok && typeof response.json === "string") {
      applyPdfPageBoxJson(response.json, preferCSSPageSize, layout);
    }
  } catch {}
}

function swapPdfLayoutDimensions(layout: PdfPageLayout): void {
  [layout.width, layout.height] = [layout.height, layout.width];
}

async function drainPdfResources(ctx: DispatchCtx, pageScript: PageScriptStub): Promise<void> {
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    await traceSpan(ctx.env.HOST_TRACER, "pdf.drain_resources", () =>
      Promise.race([
        stubQueryDom(pageScript, "awaitPendingResources", {
          timeoutMs: RENDER_DRAIN_TIMEOUT_MS,
          upgradeFonts: true,
        }).catch(() => null),
        new Promise((resolve) => {
          graceTimer = setTimeout(
            () => resolve(null),
            RENDER_DRAIN_TIMEOUT_MS + RENDER_DRAIN_GRACE_MS,
          );
        }),
      ]),
    );
  } catch {
  } finally {
    clearTimerIfSet(graceTimer);
  }
}

async function suppressPdfBackground(
  pageScript: PageScriptStub,
  printBackground: boolean,
): Promise<boolean> {
  if (printBackground) return false;
  try {
    const response = await stubQueryDom(pageScript, "setSuppressBackgrounds", { enabled: true });
    return response?.ok === true;
  } catch {
    return false;
  }
}

async function renderPagePdf(
  ctx: DispatchCtx,
  target: TargetState,
  pageScript: PageScriptStub,
  layout: PdfPageLayout,
  omitBackground: boolean,
): Promise<unknown> {
  try {
    const manager = getRendererManager(ctx, target);
    const result = await traceSpan(ctx.env.HOST_TRACER, "render.pdf", () =>
      manager.renderPdf(pageScript, {
        paperWidth: layout.width,
        paperHeight: layout.height,
        omitBackground,
        marginTop: layout.marginTopPx,
        marginRight: layout.marginRightPx,
        marginBottom: layout.marginBottomPx,
        marginLeft: layout.marginLeftPx,
      }),
    );
    return pdfRenderResponse(result);
  } catch (err) {
    return pdfFailure(err);
  }
}

function pdfRenderResponse(result: Awaited<ReturnType<PageRendererManager["renderPdf"]>>): {
  data: string;
  error?: string;
} {
  const bytes = nonEmptyPdfBytes(result);
  if (bytes) return { data: bytesToBase64(bytes) };
  return { data: EMPTY_PDF_B64, error: pdfRendererError(result) };
}

function nonEmptyPdfBytes(
  result: Awaited<ReturnType<PageRendererManager["renderPdf"]>>,
): Uint8Array | null {
  if (!result.ok) return null;
  return nonEmptyBytes(result.bytes);
}

function nonEmptyBytes(bytes: Uint8Array | undefined): Uint8Array | null {
  if (!bytes) return null;
  if (bytes.length === 0) return null;
  return bytes;
}

function pdfRendererError(result: Awaited<ReturnType<PageRendererManager["renderPdf"]>>): string {
  return result.error ?? "pageRenderer returned no bytes";
}

function pdfFailure(err: unknown): { data: string; error: string } {
  return { data: EMPTY_PDF_B64, error: err instanceof Error ? err.message : String(err) };
}

interface ScreencastStartOptions {
  format: "png" | "jpeg";
  quality: number;
  maxWidth: number;
  maxHeight: number;
  everyNthFrame: number;
  pollIntervalMs: number;
  maxInFlight: number;
}

interface ScreencastStartState {
  state: ScreencastState;
  existing: ScreencastState | undefined;
  configurationVersion: number;
  ownerSessionId: string | undefined;
}

async function handlePageStartScreencast(
  ctx: DispatchCtx,
  target: TargetState,
  req: PageCommand,
): Promise<unknown> {
  if (req.method !== "Page.startScreencast") return {};
  const options = screencastOptionsFromParams(req.params);
  const ownerSessionId = req.sessionId || undefined;
  const start = createScreencastStartState(ctx, target, options, ownerSessionId);
  const formerDrain = handoffScreencastOwner(ctx, target, start.existing, ownerSessionId);
  return applyScreencastStartConfiguration(ctx, target, start, options, formerDrain);
}

function screencastOptionsFromParams(
  params: PageStartScreencastRequest["params"],
): ScreencastStartOptions {
  if (!params) return defaultScreencastStartOptions();
  const reqFormat = params.format;
  const format = reqFormat === "png" || reqFormat === "jpeg" ? reqFormat : "jpeg";
  const { width: maxWidth, height: maxHeight } = clampViewport(
    clampInt(params.maxWidth, MIN_SCREENCAST_DIMENSION, MAX_SIDE, DEFAULT_VIEWPORT_WIDTH),
    clampInt(params.maxHeight, MIN_SCREENCAST_DIMENSION, MAX_SIDE, DEFAULT_VIEWPORT_HEIGHT),
  );
  return {
    format,
    quality: clampInt(params.quality, 1, MAX_IMAGE_QUALITY, DEFAULT_IMAGE_QUALITY),
    maxWidth,
    maxHeight,
    everyNthFrame: clampInt(params.everyNthFrame, 1, MAX_SCREENCAST_EVERY_NTH_FRAME, 1),
    pollIntervalMs: clampInt(
      params.minFrameIntervalMs,
      MIN_SCREENCAST_FRAME_INTERVAL_MS,
      MAX_SCREENCAST_FRAME_INTERVAL_MS,
      POLL_INTERVAL_MS,
    ),
    maxInFlight: clampInt(
      params.maxFramesInFlight ?? params.maxInFlight,
      1,
      MAX_SCREENCAST_FRAMES_IN_FLIGHT,
      1,
    ),
  };
}

function defaultScreencastStartOptions(): ScreencastStartOptions {
  return {
    format: "jpeg",
    quality: DEFAULT_IMAGE_QUALITY,
    maxWidth: DEFAULT_VIEWPORT_WIDTH,
    maxHeight: DEFAULT_VIEWPORT_HEIGHT,
    everyNthFrame: 1,
    pollIntervalMs: POLL_INTERVAL_MS,
    maxInFlight: 1,
  };
}

function createScreencastStartState(
  ctx: DispatchCtx,
  target: TargetState,
  options: ScreencastStartOptions,
  ownerSessionId: string | undefined,
): ScreencastStartState {
  const existing = ctx.browser.screencasts.get(target.targetId);
  const configurationVersion = ++target.screencastConfigurationVersion;
  const state: ScreencastState = existing ?? {
    ...options,
    wheelQueue: getWheelQueue(ctx.browser, target.targetId, ownerSessionId),
    ownerSessionId,
    configurationVersion,
    appliedConfigurationVersion: configurationVersion - 1,
    lastAckedSeq: 0,
    frameSeq: 0,
    lastRenderedMutationSeq: -1,
    pendingAckSessionId: null,
    pendingAckSetAt: 0,
    stopped: false,
    consecutiveRenderFailures: 0,
    lastRenderError: null,
    framesDropped: 0,
  };
  state.configurationVersion = configurationVersion;
  if (!existing) {
    ctx.browser.screencasts.set(target.targetId, state);
    ctx.ctx.waitUntil(screencastLoop(ctx, target, state));
  }
  return { state, existing, configurationVersion, ownerSessionId };
}

function handoffScreencastOwner(
  ctx: DispatchCtx,
  target: TargetState,
  existing: ScreencastState | undefined,
  ownerSessionId: string | undefined,
): Promise<unknown> | null {
  if (!existing || existing.ownerSessionId === ownerSessionId) return null;
  const formerOwner = existing.ownerSessionId;
  const formerQueues = [...findWheelQueues(ctx.browser, target.targetId, formerOwner)];
  for (const formerQueue of formerQueues) {
    moveWheelQueue(ctx.browser, target.targetId, formerOwner, ownerSessionId, formerQueue);
  }
  const drains = formerQueues.map((formerQueue) =>
    formerQueue.stop().then(() => {
      removeWheelQueue(ctx.browser, target.targetId, ownerSessionId, formerQueue);
    }),
  );
  existing.ownerSessionId = ownerSessionId;
  existing.wheelQueue = getWheelQueue(ctx.browser, target.targetId, ownerSessionId);
  existing.lastAckedSeq = existing.frameSeq;
  existing.pendingAckSessionId = null;
  existing.pendingAckSetAt = 0;
  const drainBarrier = Promise.all(drains);
  setWheelHandoffDrain(ctx.browser, target.targetId, formerOwner, drainBarrier);
  return drainBarrier;
}

async function applyScreencastStartConfiguration(
  ctx: DispatchCtx,
  target: TargetState,
  start: ScreencastStartState,
  options: ScreencastStartOptions,
  formerDrain: Promise<unknown> | null,
): Promise<unknown> {
  const { state, configurationVersion } = start;
  const previousConfiguration = target.screencastConfigurationBarrier;
  let releaseConfiguration!: () => void;
  target.screencastConfigurationBarrier = new Promise<void>((resolve) => {
    releaseConfiguration = resolve;
  });
  await previousConfiguration;
  try {
    if (!screencastIsAttached(ctx, target, state)) return {};
    if (target.screencastConfigurationVersion !== configurationVersion) {
      await waitForScreencastDrain(formerDrain);
      return {};
    }
    target.viewportWidth = options.maxWidth;
    target.viewportHeight = options.maxHeight;
    await setScreencastViewport(target, options);
    await waitForScreencastDrain(formerDrain);
    if (!screencastConfigurationIsCurrent(ctx, target, state, configurationVersion)) return {};
    applyScreencastOptions(state, options, configurationVersion);
    ctx.emit({
      method: "Page.screencastVisibilityChanged",
      params: { visible: true },
      sessionId: state.ownerSessionId,
    });
    return {};
  } finally {
    releaseConfiguration();
  }
}

async function waitForScreencastDrain(formerDrain: Promise<unknown> | null): Promise<void> {
  if (formerDrain) await formerDrain;
}

function screencastConfigurationIsCurrent(
  ctx: DispatchCtx,
  target: TargetState,
  state: ScreencastState,
  configurationVersion: number,
): boolean {
  if (!screencastIsAttached(ctx, target, state)) return false;
  return target.screencastConfigurationVersion === configurationVersion;
}

function screencastIsAttached(
  ctx: DispatchCtx,
  target: TargetState,
  state: ScreencastState,
): boolean {
  if (state.stopped || ctx.browser.wsClosing) return false;
  if (ctx.browser.targets.get(target.targetId) !== target) return false;
  return ctx.browser.screencasts.get(target.targetId) === state;
}

async function setScreencastViewport(
  target: TargetState,
  options: ScreencastStartOptions,
): Promise<void> {
  if (!target.pageScript) return;
  try {
    await stubQueryDom(target.pageScript, "setViewport", {
      width: options.maxWidth,
      height: options.maxHeight,
    });
  } catch {}
}

function applyScreencastOptions(
  state: ScreencastState,
  options: ScreencastStartOptions,
  configurationVersion: number,
): void {
  state.format = options.format;
  state.quality = options.quality;
  state.maxWidth = options.maxWidth;
  state.maxHeight = options.maxHeight;
  state.everyNthFrame = options.everyNthFrame;
  state.pollIntervalMs = options.pollIntervalMs;
  state.maxInFlight = options.maxInFlight;
  state.lastRenderedMutationSeq = -1;
  state.appliedConfigurationVersion = configurationVersion;
  state.wake?.();
}

async function handlePageStopScreencast(
  ctx: DispatchCtx,
  target: TargetState,
  req: PageCommand,
): Promise<unknown> {
  if (req.method !== "Page.stopScreencast") return {};
  {
    const state = ctx.browser.screencasts.get(target.targetId);
    if (isOwnedScreencast(state, req.sessionId)) stopScreencast(ctx, target, state);
    return {};
  }
}

function isOwnedScreencast(
  state: ScreencastState | undefined,
  sessionId: string | undefined,
): state is ScreencastState {
  return state !== undefined && state.ownerSessionId === (sessionId || undefined);
}

function stopScreencast(ctx: DispatchCtx, target: TargetState, state: ScreencastState): void {
  state.stopped = true;
  state.wake?.();
  stopAndRemoveWheelQueue(ctx.browser, target.targetId, state.ownerSessionId, state.wheelQueue);
  ctx.browser.screencasts.delete(target.targetId);
}

async function handlePageScreencastFrameAck(
  ctx: DispatchCtx,
  target: TargetState,
  req: PageCommand,
): Promise<unknown> {
  if (req.method !== "Page.screencastFrameAck") return {};
  {
    const state = ctx.browser.screencasts.get(target.targetId);
    if (!state) return {};
    const ackId = screencastAckId(req, state);
    const ackCount = incrementScreencastAckCount(target);
    logScreencastAck(ackCount, ackId, state);
    clearAcknowledgedScreencastFrame(state, ackId);
    recordScreencastAck(state, ackId);
    return {};
  }
}

function screencastAckId(req: PageCommand, state: ScreencastState): number {
  if (req.method !== "Page.screencastFrameAck") return -1;
  return cappedScreencastAckId(req.params?.sessionId ?? -1, state.frameSeq);
}

function incrementScreencastAckCount(target: TargetState): number {
  target.screencastAckCount = (target.screencastAckCount ?? 0) + 1;
  return target.screencastAckCount;
}

function recordScreencastAck(state: ScreencastState, ackId: number): void {
  if (ackId > state.lastAckedSeq) state.lastAckedSeq = ackId;
  state.wake?.();
}

function cappedScreencastAckId(rawAckId: unknown, frameSeq: number): number {
  return typeof rawAckId === "number" && Number.isInteger(rawAckId)
    ? Math.min(rawAckId, frameSeq)
    : -1;
}

function logScreencastAck(count: number, ackId: number, state: ScreencastState): void {
  if (count % 5 !== 1) return;
  console.log(
    `[kitesurf-screencast] ack #${count} ` +
      `ackId=${ackId} pendingAck=${state.pendingAckSessionId} ` +
      `frameSeq=${state.frameSeq}`,
  );
}

function clearAcknowledgedScreencastFrame(state: ScreencastState, ackId: number): void {
  if (state.pendingAckSessionId === null || ackId < state.pendingAckSessionId) return;
  state.pendingAckSessionId = null;
  state.pendingAckSetAt = 0;
}
const TINY_TRANSPARENT_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=";

const EMPTY_PDF_B64 =
  "JVBERi0xLjQKMSAwIG9iago8PC9UeXBlIC9DYXRhbG9nIC9QYWdlcyAyIDAgUj4+CmVuZG9iagoyIDAgb2JqCjw8L1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlIC9QYWdlIC9QYXJlbnQgMiAwIFIgL01lZGlhQm94IFswIDAgNjEyIDc5Ml0gL1Jlc291cmNlcyA8PD4+IC9Db250ZW50cyA0IDAgUj4+CmVuZG9iago0IDAgb2JqCjw8L0xlbmd0aCAwPj4Kc3RyZWFtCgplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA1CjAwMDAwMDAwMDAgNjU1MzUgZgowMDAwMDAwMDA5IDAwMDAwIG4KMDAwMDAwMDA1OCAwMDAwMCBuCjAwMDAwMDAxMTEgMDAwMDAgbgowMDAwMDAwMjEzIDAwMDAwIG4KdHJhaWxlcgo8PC9TaXplIDUgL1Jvb3QgMSAwIFI+PgpzdGFydHhyZWYKMjY0CiUlRU9G";

function bytesToBase64(bytes: Uint8Array): string {
  return bytes.toBase64();
}

function sanitizeBaseUrl(url: string): string {
  if (!url) return "https://kitesurf.local/";
  try {
    const parsed = new URL(url);
    const hierarchical = ["http:", "https:", "file:", "ftp:", "ws:", "wss:"];
    if (hierarchical.includes(parsed.protocol)) return url;
    return "https://kitesurf.local/";
  } catch {
    return "https://kitesurf.local/";
  }
}

function frameGatesLoadEvent(f: FrameState): boolean {
  if (f.parentFrameId === null) return false;
  if (!f.pendingLoad) return false;
  if (!f.delaysLoadEvent) return false;
  return true;
}

function navigateOwesIframeInstalls(target: TargetState): boolean {
  for (const f of target.frames.values()) {
    if (frameGatesLoadEvent(f)) return true;
  }
  return false;
}

async function pushNavigateToPageScript(
  ctx: DispatchCtx,
  target: TargetState,
  html: string,
  url: string,
  owesIframeInstalls = false,
): Promise<NavigatePushResult> {
  if (target.type !== "page") return { console: [] };
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  target.blankReady = gate;
  try {
    return await pushNavigateToPageScriptInner(ctx, target, html, url, owesIframeInstalls);
  } finally {
    if (target.blankReady === gate) target.blankReady = null;
    release();
  }
}

interface NavigatePushResult {
  console: ConsoleEntry[];
  phases?: Record<string, number>;
  cdpMutations?: CdpMutation[];
  exceptions?: ExceptionEntry[];
}

async function pushNavigateToPageScriptInner(
  ctx: DispatchCtx,
  target: TargetState,
  html: string,
  url: string,
  owesIframeInstalls = false,
): Promise<NavigatePushResult> {
  const consoleAcc = await retirePageScriptForNavigate(ctx, target);
  const generation = advanceNavigationGeneration(ctx, target);

  const raPreSpawnWaitMs = ctx.analytics.sessionAgeMs();
  const raBakeStart = ctx.analytics.now();
  const {
    descriptors: scriptDescriptors,
    bundle: scriptBundle,
    wasmBake,
  } = await prepareNavigationScripts(ctx, target, html, url);

  logNavigationScriptSummary(ctx, target, url, scriptDescriptors, scriptBundle);

  const raInitTimings: PageScriptInitTimings = {};
  let pendingPageScript: ReturnType<typeof getOrCreatePageScript> | null;
  try {
    pendingPageScript = createPageScriptForNavigate({
      ctx,
      target,
      html,
      url,
      generation,
      descriptors: scriptDescriptors,
      bundle: scriptBundle,
      wasmBake,
      initTimings: raInitTimings,
    });
  } catch (err) {
    warnPageScriptCreationFailure(err);
    return { console: consoleAcc };
  }

  const raBakeMs = ctx.analytics.now() - raBakeStart;

  installPageScriptGenerationHandlers(ctx, target, pendingPageScript, generation, url);

  try {
    const navigation = await navigatePageScriptForDocument(
      ctx,
      target,
      pendingPageScript,
      html,
      url,
      generation,
      owesIframeInstalls,
    );
    if (target.navigateGeneration !== generation) {
      await disposeSupersededPageScript(ctx, pendingPageScript);
      return { console: consoleAcc };
    }
    return await completePageScriptNavigateRpc({
      ctx,
      target,
      pageScript: pendingPageScript,
      summary: navigation.summary,
      consoleEntries: consoleAcc,
      url,
      generation,
      navigationStartedAt: navigation.startedAt,
      preSpawnWaitMs: raPreSpawnWaitMs,
      bakeMs: raBakeMs,
      initTimings: raInitTimings,
    });
  } catch (err) {
    warnPageScriptNavigateFailure(err);
    await cleanupFailedPageScriptNavigation(ctx, target, pendingPageScript);
    return { console: consoleAcc };
  }
}

async function retirePageScriptForNavigate(
  ctx: DispatchCtx,
  target: TargetState,
): Promise<ConsoleEntry[]> {
  const consoleEntries: ConsoleEntry[] = [];
  target.wheelTeardownDepth += 1;
  try {
    await cancelAndRemoveTargetWheelQueues(ctx.browser, target.targetId);
    await retireCurrentPageScript(ctx, target, consoleEntries);
  } finally {
    target.wheelTeardownDepth -= 1;
  }
  return consoleEntries;
}

async function retireCurrentPageScript(
  ctx: DispatchCtx,
  target: TargetState,
  consoleEntries: ConsoleEntry[],
): Promise<void> {
  if (!target.pageScript) return;
  const harvest = await retireStub(target, "navigate", "Page.navigate: generation bump", {
    budget: ctx.browser.workerBudget,
  });
  appendRetiredConsoleEntries(consoleEntries, harvest?.console);
  applyRetiredCookieWrites(ctx, target, harvest?.cookieWrites);
}

function appendRetiredConsoleEntries(
  consoleEntries: ConsoleEntry[],
  entries: ConsoleEntry[] | undefined,
): void {
  for (const entry of entries ?? []) consoleEntries.push(entry);
}

function warnPageScriptCreationFailure(error: unknown): void {
  console.warn(
    "[kitesurf-nav] getOrCreatePageScript threw:",
    error instanceof Error ? error.message : String(error),
  );
}

function warnPageScriptNavigateFailure(error: unknown): void {
  console.warn(
    "[kitesurf-nav] PageScript.navigate threw:",
    error instanceof Error ? error.message : String(error),
  );
}

function applyRetiredCookieWrites(
  ctx: DispatchCtx,
  target: TargetState,
  cookieWrites: string[] | undefined,
): void {
  if (!target.url) return;
  for (const raw of cookieWrites ?? []) {
    jarForTarget(ctx, target).setFromDocumentCookie(target.url, raw);
  }
}

function advanceNavigationGeneration(ctx: DispatchCtx, target: TargetState): number {
  // Invalidate late-result checks before clearing per-document state.
  target.navigateGeneration += 1;
  restoreScreencastWheelQueue(ctx, target);
  target.lastLoadAt = 0;
  dropTargetImages(ctx.connectionId, target.targetId);
  target.compiledScripts.length = 0;
  clearStyleSheetsForNavigate(ctx, target);
  clearToolsForNavigate(ctx, target);
  return target.navigateGeneration;
}

function restoreScreencastWheelQueue(ctx: DispatchCtx, target: TargetState): void {
  const stream = ctx.browser.screencasts.get(target.targetId);
  if (!stream || stream.wheelQueue.isAccepting) return;
  stream.wheelQueue = getWheelQueue(ctx.browser, target.targetId, stream.ownerSessionId);
}

interface NavigationScriptBuild {
  descriptors: ParentScriptDescriptor[];
  bundle: ScriptBundle | null;
  wasmBake: WasmBake | null;
}

interface NavigationScriptBakeState {
  wasmBake: WasmBake | null;
}

interface NavigationScriptPlan {
  gate: ReturnType<typeof documentGateContext>;
  baseUrl: string;
  descriptors: ParentScriptDescriptor[];
  afterClassicPrefetch: ParentScriptDescriptor[];
  learnedUrls: string[];
  speculativeUrls: string[];
  speculativePrefetch: Promise<ParentScriptDescriptor[]>;
  importMaps: Awaited<ReturnType<typeof applyImportMapGate>>;
}

type NavigationModuleWalk = Awaited<ReturnType<typeof walkModuleGraph>>;

async function prepareNavigationScripts(
  ctx: DispatchCtx,
  target: TargetState,
  html: string,
  url: string,
): Promise<NavigationScriptBuild> {
  const state: NavigationScriptBakeState = { wasmBake: null };
  try {
    return await buildNavigationScripts(ctx, target, html, url, state);
  } catch (err) {
    console.warn(
      "[kitesurf-nav] script descriptor extraction/prefetch threw:",
      err instanceof Error ? err.message : String(err),
    );
    return { descriptors: [], bundle: null, wasmBake: state.wasmBake };
  }
}

async function buildNavigationScripts(
  ctx: DispatchCtx,
  target: TargetState,
  html: string,
  url: string,
  state: NavigationScriptBakeState,
): Promise<NavigationScriptBuild> {
  const plan = await createNavigationScriptPlan(ctx, target, html, url);
  const walk = await walkNavigationModuleGraph(ctx, target, html, url, plan);
  const fetched = await plan.speculativePrefetch;
  forgetFailedLearnedScripts(ctx, target, url, plan.learnedUrls, fetched);
  const insertedBake = fetched.filter(isSuccessfullyPrefetchedScript);
  logSpeculativeScriptsBaked(ctx, plan.speculativeUrls, insertedBake.length);
  const digests = await insertedSourceDigests(insertedBake);
  const bundle = buildNavigationScriptBundle(ctx, walk, insertedBake, digests);
  state.wasmBake = await prepareNavigationWasm(
    ctx,
    target,
    walk.descriptors,
    walk.additionalModules,
    url,
  );
  traceSpan(ctx.env.HOST_TRACER, "navigate.register_bundle", () =>
    registerBundleScripts(ctx, target, bundle),
  );
  return { descriptors: walk.descriptors, bundle, wasmBake: state.wasmBake };
}

function navigationScriptInput(ctx: DispatchCtx, target: TargetState): ParentScriptDescriptor[] {
  const raw = target.docScan ? target.docScan.scripts : extractScriptDescriptorsFromDom(target.dom);
  const injected = preNavigationScriptDescriptors(ctx);
  return injected.length > 0 ? [...injected, ...raw] : raw;
}

function preNavigationScriptDescriptors(ctx: DispatchCtx): ParentScriptDescriptor[] {
  const scripts: ParentScriptDescriptor[] = [];
  for (const source of ctx.browser.preNavScripts.values()) {
    scripts.push({
      src: null,
      kind: "classic",
      defer: false,
      async: false,
      body: source,
      injected: true,
    });
  }
  return scripts;
}

async function createNavigationScriptPlan(
  ctx: DispatchCtx,
  target: TargetState,
  html: string,
  url: string,
): Promise<NavigationScriptPlan> {
  const descriptors = navigationScriptInput(ctx, target);
  const gate = documentGateContext(url, {
    csp: target.docCsp,
    cspReportOnly: target.docCspReportOnly,
    scan: target.docScan,
  });
  const baseUrl = documentBaseUrl(url, target.docScan?.baseHref);
  const gated = await traceSpan(ctx.env.HOST_TRACER, "navigate.script_gate", () =>
    applyPreFetchScriptGate(descriptors, gate, baseUrl),
  );
  warnBlockedNavigationScripts(gated);
  const afterClassicPrefetch = await prefetchNavigationScripts(ctx, target, url, baseUrl, gated);
  const learnedUrls = learnedScriptsFor(
    ctx.browser.learnedInsertedScripts,
    url,
    target.browserContextId,
  );
  const routeChunkUrls = nextRouteChunkUrls(afterClassicPrefetch, url).filter(
    (candidate) => !learnedUrls.includes(candidate),
  );
  const speculativeUrls = [...learnedUrls, ...routeChunkUrls];
  const speculativePrefetch = startSpeculativeScriptPrefetch(
    ctx,
    target,
    url,
    baseUrl,
    gate,
    speculativeUrls,
  );
  const importMaps = await applyImportMapGate(target.docScan?.importMaps ?? [], gate, url);
  return {
    gate,
    baseUrl,
    descriptors: gated,
    afterClassicPrefetch,
    learnedUrls,
    speculativeUrls,
    speculativePrefetch,
    importMaps,
  };
}

function warnBlockedNavigationScripts(descriptors: ParentScriptDescriptor[]): void {
  for (const descriptor of descriptors) {
    if (!descriptor.blocked) continue;
    console.warn(
      `[kitesurf-csp] blocked (${descriptor.blocked.reason}) ${descriptor.src ?? "inline"}: ` +
        descriptor.blocked.message,
    );
  }
}

async function prefetchNavigationScripts(
  ctx: DispatchCtx,
  target: TargetState,
  url: string,
  baseUrl: string,
  descriptors: ParentScriptDescriptor[],
): Promise<ParentScriptDescriptor[]> {
  return traceSpan(ctx.env.HOST_TRACER, "navigate.prefetch_scripts", () =>
    prefetchExternalScripts({
      descriptors,
      pageUrl: url,
      connectionId: ctx.connectionId,
      mainFrameId: target.frameId,
      mainLoaderId: target.loaderId,
      extraHeaders: effectiveExtraHeaders(target),
      cookieKey: cookieKeyFor(ctx.connectionId, target.browserContextId),
      baseUrl,
      sandboxOutbound: ctx.browser.sandboxOutbound,
    }),
  );
}

function startSpeculativeScriptPrefetch(
  ctx: DispatchCtx,
  target: TargetState,
  url: string,
  baseUrl: string,
  gate: ReturnType<typeof documentGateContext>,
  urls: string[],
): Promise<ParentScriptDescriptor[]> {
  if (urls.length === 0) return Promise.resolve([]);
  return traceSpan(ctx.env.HOST_TRACER, "navigate.prefetch_speculative", () =>
    applyPreFetchScriptGate(
      urls.map((src) => ({ src, kind: "classic", defer: false, async: false, body: "" })),
      gate,
      baseUrl,
    ).then((gated) =>
      prefetchBestEffort(
        gated.filter((descriptor) => mayPrefetchNavigationDescriptor(ctx, descriptor)),
        (descriptor, signal) =>
          prefetchExternalScripts({
            descriptors: [descriptor],
            pageUrl: url,
            connectionId: "",
            mainFrameId: target.frameId,
            mainLoaderId: target.loaderId,
            extraHeaders: effectiveExtraHeaders(target),
            cookieKey: "",
            baseUrl,
            sandboxOutbound: ctx.browser.sandboxOutbound,
            signal,
          }).then((fetched) => fetched[0] ?? descriptor),
      ),
    ),
  ).catch((): ParentScriptDescriptor[] => []);
}

function mayPrefetchNavigationDescriptor(
  ctx: DispatchCtx,
  descriptor: ParentScriptDescriptor,
): boolean {
  return (
    !descriptor.blocked &&
    maySpeculate(ctx.connectionId, descriptor.resolvedSrc ?? descriptor.src ?? "")
  );
}

async function walkNavigationModuleGraph(
  ctx: DispatchCtx,
  target: TargetState,
  html: string,
  url: string,
  plan: NavigationScriptPlan,
): Promise<NavigationModuleWalk> {
  return traceSpan(ctx.env.HOST_TRACER, "navigate.walk_module_graph", () =>
    walkModuleGraph({
      descriptors: plan.afterClassicPrefetch,
      pageUrl: url,
      connectionId: ctx.connectionId,
      mainFrameId: target.frameId,
      mainLoaderId: target.loaderId,
      extraHeaders: effectiveExtraHeaders(target),
      cookieKey: cookieKeyFor(ctx.connectionId, target.browserContextId),
      options: {
        baseUrl: plan.baseUrl,
        gate: plan.gate,
        importMaps: plan.importMaps,
        moduleSeeds: astroIslandModuleUrls(html, plan.baseUrl),
        preloadSeeds: modulePreloadSeeds(html, plan.baseUrl),
        documentHtml: html,
      },
      sandboxOutbound: ctx.browser.sandboxOutbound,
    }),
  );
}

function forgetFailedLearnedScripts(
  ctx: DispatchCtx,
  target: TargetState,
  url: string,
  learnedUrls: string[],
  fetched: ParentScriptDescriptor[],
): void {
  const learned = new Set(learnedUrls);
  for (const descriptor of fetched) {
    if (shouldForgetLearnedScript(descriptor, learned)) {
      forgetLearnedScript(
        ctx.browser.learnedInsertedScripts,
        url,
        descriptor.src ?? "",
        target.browserContextId,
      );
    }
  }
}

function shouldForgetLearnedScript(
  descriptor: ParentScriptDescriptor,
  learnedUrls: ReadonlySet<string>,
): boolean {
  return (
    !!descriptor.src &&
    learnedUrls.has(descriptor.src) &&
    !!(descriptor.prefetchError || descriptor.blocked)
  );
}

function isSuccessfullyPrefetchedScript(descriptor: ParentScriptDescriptor): boolean {
  return (
    typeof descriptor.prefetchedSource === "string" &&
    !descriptor.prefetchError &&
    !descriptor.blocked
  );
}

function logSpeculativeScriptsBaked(ctx: DispatchCtx, urls: string[], bakedCount: number): void {
  if (!ctx.browser.cdpDebug || urls.length === 0) return;
  console.log(`[kitesurf-nav] speculative scripts baked ${bakedCount}/${urls.length}`);
}

function buildNavigationScriptBundle(
  ctx: DispatchCtx,
  walk: NavigationModuleWalk,
  insertedBake: ParentScriptDescriptor[],
  insertedDigests: Awaited<ReturnType<typeof insertedSourceDigests>>,
): ScriptBundle {
  return traceSpan(ctx.env.HOST_TRACER, "navigate.build_bundle", () =>
    buildScriptBundle(walk.descriptors, {
      cdpDebug: ctx.browser.cdpDebug,
      additionalModules: walk.additionalModules,
      importMapModuleSource: walk.importMapModuleSource,
      insertedBake,
      insertedDigests,
    }),
  );
}

async function prepareNavigationWasm(
  ctx: DispatchCtx,
  target: TargetState,
  descriptors: ParentScriptDescriptor[],
  additionalModules: NavigationModuleWalk["additionalModules"],
  url: string,
): Promise<WasmBake | null> {
  try {
    return await scanAndBakeNavigationWasm(ctx, target, descriptors, additionalModules, url);
  } catch (err) {
    console.warn(
      "[kitesurf-nav] wasm bake threw (non-fatal):",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

async function scanAndBakeNavigationWasm(
  ctx: DispatchCtx,
  target: TargetState,
  descriptors: ParentScriptDescriptor[],
  additionalModules: NavigationModuleWalk["additionalModules"],
  url: string,
): Promise<WasmBake | null> {
  const sources = navigationWasmSources(descriptors, additionalModules, url);
  const wasmUrls = traceSpan(
    ctx.env.HOST_TRACER,
    "navigate.scan_wasm_literals",
    () => scanForWasmUrls(sources),
    { sources: sources.length },
  );
  const inlineWasm = traceSpan(ctx.env.HOST_TRACER, "navigate.scan_inline_wasm", () =>
    scanForInlineWasm(sources),
  );
  if (wasmUrls.length === 0 && inlineWasm.length === 0) return null;
  const bake = await prefetchNavigationWasm(ctx, target, url, wasmUrls);
  await bakeInlineNavigationWasm(ctx, inlineWasm, bake);
  logNavigationWasmBake(wasmUrls.length, inlineWasm.length, bake);
  return bake;
}

function navigationWasmSources(
  descriptors: ParentScriptDescriptor[],
  additionalModules: NavigationModuleWalk["additionalModules"],
  url: string,
): Array<{ body: string; baseUrl: string }> {
  const sources: Array<{ body: string; baseUrl: string }> = [];
  appendDescriptorWasmSources(sources, descriptors, url);
  appendModuleWasmSources(sources, additionalModules);
  return sources;
}

function appendDescriptorWasmSources(
  sources: Array<{ body: string; baseUrl: string }>,
  descriptors: ParentScriptDescriptor[],
  url: string,
): void {
  for (const descriptor of descriptors) {
    const source = descriptorWasmSource(descriptor, url);
    if (source) sources.push(source);
  }
}

function descriptorWasmSource(
  descriptor: ParentScriptDescriptor,
  url: string,
): { body: string; baseUrl: string } | undefined {
  if (!descriptor.src) return inlineDescriptorWasmSource(descriptor, url);
  return externalDescriptorWasmSource(descriptor, url);
}

function inlineDescriptorWasmSource(
  descriptor: ParentScriptDescriptor,
  url: string,
): { body: string; baseUrl: string } | undefined {
  if (!descriptor.body) return undefined;
  return { body: descriptor.body, baseUrl: url };
}

function externalDescriptorWasmSource(
  descriptor: ParentScriptDescriptor,
  url: string,
): { body: string; baseUrl: string } | undefined {
  if (!descriptor.src || !descriptor.prefetchedSource) return undefined;
  return { body: descriptor.prefetchedSource, baseUrl: descriptor.resolvedSrc ?? url };
}

function appendModuleWasmSources(
  sources: Array<{ body: string; baseUrl: string }>,
  additionalModules: NavigationModuleWalk["additionalModules"],
): void {
  for (const [moduleUrl, source] of Object.entries(additionalModules)) {
    if (typeof source === "string") sources.push({ body: source, baseUrl: moduleUrl });
  }
}

function prefetchNavigationWasm(
  ctx: DispatchCtx,
  target: TargetState,
  url: string,
  urls: string[],
): Promise<WasmBake> {
  return traceSpan(
    ctx.env.HOST_TRACER,
    "navigate.prefetch_wasm",
    () =>
      prefetchWasmModules({
        urls,
        pageUrl: url,
        connectionId: ctx.connectionId,
        mainFrameId: target.frameId,
        mainLoaderId: target.loaderId,
        extraHeaders: effectiveExtraHeaders(target),
        cookieKey: cookieKeyFor(ctx.connectionId, target.browserContextId),
        sandboxOutbound: ctx.browser.sandboxOutbound,
      }),
    { count: urls.length },
  );
}

async function bakeInlineNavigationWasm(
  ctx: DispatchCtx,
  inlineWasm: Awaited<ReturnType<typeof scanForInlineWasm>>,
  bake: WasmBake,
): Promise<void> {
  if (inlineWasm.length === 0) return;
  await traceSpan(
    ctx.env.HOST_TRACER,
    "navigate.bake_inline_wasm",
    () => bakeInlineWasm(inlineWasm, bake),
    { count: inlineWasm.length },
  );
}

function logNavigationWasmBake(wasmCount: number, inlineCount: number, bake: WasmBake): void {
  const bakedCount = Object.keys(bake.modules).length;
  const errors = Object.entries(bake.errors)
    .map(
      ([moduleUrl, error]) => `${moduleUrl}: ${error.slice(0, MAX_NAVIGATION_ERROR_PREVIEW_CHARS)}`,
    )
    .slice(0, MAX_NAVIGATION_ERROR_SAMPLES);
  console.log(
    `[kitesurf-nav] wasm bake: discovered=${wasmCount} ` +
      `inline=${inlineCount} baked=${bakedCount}` +
      (errors.length ? ` errors=[${errors.join(" | ")}]` : ""),
  );
}

interface NavigationScriptSummary {
  total: number;
  inline: number;
  externalOk: number;
  externalError: number;
  errorSamples: string[];
}

function logNavigationScriptSummary(
  ctx: DispatchCtx,
  target: TargetState,
  url: string,
  descriptors: ParentScriptDescriptor[],
  bundle: ScriptBundle | null,
): void {
  try {
    logNavigationScriptSummaryContent(ctx, target, url, descriptors, bundle);
  } catch (err) {
    console.warn(
      "[kitesurf-nav] log-summary threw (non-fatal):",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function logNavigationScriptSummaryContent(
  ctx: DispatchCtx,
  target: TargetState,
  url: string,
  descriptors: ParentScriptDescriptor[],
  bundle: ScriptBundle | null,
): void {
  const summary = summarizeNavigationScripts(descriptors);
  const errors = summary.externalError > 0 ? ` errors=[${summary.errorSamples.join(" | ")}]` : "";
  console.log(
    `[kitesurf-nav] url=${url} scripts: total=${summary.total} inline=${summary.inline} ` +
      `ext-ok=${summary.externalOk} ext-err=${summary.externalError}${errors}`,
  );
  if (ctx.browser.cdpDebug) logNavigationScriptDetails(target, descriptors);
  logNavigationBundleSummary(bundle);
}

function summarizeNavigationScripts(
  descriptors: ParentScriptDescriptor[],
): NavigationScriptSummary {
  const summary: NavigationScriptSummary = {
    total: descriptors.length,
    inline: 0,
    externalOk: 0,
    externalError: 0,
    errorSamples: [],
  };
  for (const descriptor of descriptors) updateNavigationScriptSummary(summary, descriptor);
  return summary;
}

function updateNavigationScriptSummary(
  summary: NavigationScriptSummary,
  descriptor: ParentScriptDescriptor,
): void {
  if (!descriptor.src) {
    summary.inline++;
    return;
  }
  if (descriptor.prefetchError) {
    summary.externalError++;
    appendNavigationScriptError(summary, descriptor);
    return;
  }
  if (descriptor.prefetchedSource) summary.externalOk++;
}

function appendNavigationScriptError(
  summary: NavigationScriptSummary,
  descriptor: ParentScriptDescriptor,
): void {
  if (summary.errorSamples.length >= MAX_NAVIGATION_ERROR_SAMPLES || !descriptor.src) return;
  summary.errorSamples.push(
    `${descriptor.src}: ${descriptor.prefetchError?.slice(0, MAX_NAVIGATION_ERROR_PREVIEW_CHARS) ?? ""}`,
  );
}

function logNavigationScriptDetails(
  target: TargetState,
  descriptors: ParentScriptDescriptor[],
): void {
  for (let index = 0; index < descriptors.length; index++) {
    const descriptor = descriptors[index];
    if (descriptor) logNavigationScriptDetail(index, descriptor);
  }
  console.log(
    `[kitesurf-nav] htmlPreview length=${target.html.length} ` +
      `first200=${JSON.stringify(target.html.slice(0, 200))}`,
  );
}

function logNavigationScriptDetail(index: number, descriptor: ParentScriptDescriptor): void {
  const sourceLength = descriptor.prefetchedSource ? descriptor.prefetchedSource.length : 0;
  const bodyLength = descriptor.body ? descriptor.body.length : 0;
  const error = descriptor.prefetchError
    ? descriptor.prefetchError.slice(0, MAX_CDP_DEBUG_ERROR_PREVIEW_CHARS)
    : "";
  console.log(
    `[kitesurf-nav] script #${index}: src=${JSON.stringify(descriptor.src)} ` +
      `kind=${descriptor.kind} defer=${descriptor.defer} async=${descriptor.async} ` +
      `srcLen=${sourceLength} bodyLen=${bodyLength}` +
      (error ? ` err="${error}"` : ""),
  );
}

function logNavigationBundleSummary(bundle: ScriptBundle | null): void {
  if (!bundle) {
    console.log("[kitesurf-nav] bundle: null (extraction/prefetch failed)");
    return;
  }
  const summary = navigationBundleSummary(bundle);
  console.log(
    `[kitesurf-nav] bundle: regular=${summary.regular}chars async=${summary.asyncSource}chars ` +
      `modules=${summary.modules} (${summary.additionalModules} baked)`,
  );
}

interface NavigationBundleSummary {
  regular: number;
  asyncSource: number;
  modules: number;
  additionalModules: number;
}

function navigationBundleSummary(bundle: ScriptBundle): NavigationBundleSummary {
  return {
    regular: optionalStringLength(bundle.classicRegularSource),
    asyncSource: optionalStringLength(bundle.classicAsyncSource),
    modules: optionalArrayLength(bundle.moduleScriptUrls),
    additionalModules: Object.keys(bundle.additionalModules ?? {}).length,
  };
}

function optionalStringLength(value: string | null | undefined): number {
  return value?.length ?? 0;
}

function optionalArrayLength<T>(value: T[] | undefined): number {
  return value?.length ?? 0;
}

interface CreatePageScriptForNavigateInput {
  ctx: DispatchCtx;
  target: TargetState;
  html: string;
  url: string;
  generation: number;
  descriptors: ParentScriptDescriptor[];
  bundle: ScriptBundle | null;
  wasmBake: WasmBake | null;
  initTimings: PageScriptInitTimings;
}

function createPageScriptForNavigate(input: CreatePageScriptForNavigateInput): PageScriptStub {
  const { ctx, target, html, url, generation, descriptors, bundle, wasmBake, initTimings } = input;
  return traceSpan(
    ctx.env.HOST_TRACER,
    "init.bake_isolate",
    () =>
      getOrCreatePageScript({
        env: ctx.env,
        ctx: ctx.ctx,
        key: {
          connectionId: ctx.connectionId,
          targetId: target.targetId,
          navigateGeneration: generation,
          cookieKey: cookieKeyFor(ctx.connectionId, target.browserContextId),
        },
        pageOrigin: pageScriptOriginOf(url),
        startupInput: navigationPageScriptStartupInput(
          ctx,
          target,
          html,
          url,
          descriptors,
          bundle,
          wasmBake,
        ),
        attributionHeaders: ctx.browser.attributionHeaders,
        mainLoaderId: target.loaderId,
        extraHeaders: effectiveExtraHeaders(target),
        initTimings,
        capOverrides: ctx.browser.isolateCapOverrides,
        sandboxOutbound: ctx.browser.sandboxOutbound,
      }),
    { generation },
  );
}

function navigationPageScriptStartupInput(
  ctx: DispatchCtx,
  target: TargetState,
  html: string,
  url: string,
  descriptors: ParentScriptDescriptor[],
  bundle: ScriptBundle | null,
  wasmBake: WasmBake | null,
): PageScriptStartupInput {
  return {
    html,
    url,
    cookies: jarForTarget(ctx, target).documentCookieString(url),
    scriptDescriptors: descriptors,
    scriptBundle: bundle,
    wasmBake,
    cdpDebug: ctx.browser.cdpDebug,
    pixelFree: ctx.browser.skipSpeculativeRaster,
    fontDefer: ctx.browser.fontDefer,
    userAgent: target.userAgentOverride || null,
    referrerPolicy: target.docReferrerPolicy ?? null,
    referrer: target.docReferrer ?? null,
    csp: navigationCsp(target),
    metaCsp: navigationMetaCsp(target),
  };
}

function navigationCsp(target: TargetState): string[] {
  return target.docCsp ? [target.docCsp] : [];
}

function navigationMetaCsp(target: TargetState): string[] {
  return target.docScan?.metaCsp ?? [];
}

function installPageScriptGenerationHandlers(
  ctx: DispatchCtx,
  target: TargetState,
  pageScript: PageScriptStub | null,
  generation: number,
  url: string,
): void {
  if (!pageScript) return;
  installUpstreamEventHandler(ctx, target, pageScript, generation, url);
  installIsolateLimitSurface(
    ctx,
    target,
    generation,
    pageScriptCacheKey({
      connectionId: ctx.connectionId,
      targetId: target.targetId,
      navigateGeneration: generation,
    }),
  );
}

type PageScriptNavigateOptions = NonNullable<Parameters<PageScriptStub["navigate"]>[2]>;

interface NavigationPageScriptResult {
  summary: Awaited<ReturnType<PageScriptStub["navigate"]>>;
  startedAt: number;
}

async function navigatePageScriptForDocument(
  ctx: DispatchCtx,
  target: TargetState,
  pageScript: PageScriptStub,
  html: string,
  url: string,
  generation: number,
  owesIframeInstalls: boolean,
): Promise<NavigationPageScriptResult> {
  const cookies = jarForTarget(ctx, target).documentCookieString(url);
  const startedAt = ctx.analytics.now();
  const summary = await traceSpan(ctx.env.HOST_TRACER, "init.pagescript_navigate", (span) =>
    runPageScriptNavigate({
      ctx,
      target,
      pageScript,
      html,
      url,
      generation,
      owesIframeInstalls,
      cookies,
      span,
    }),
  );
  return { summary, startedAt };
}

interface RunPageScriptNavigateInput {
  ctx: DispatchCtx;
  target: TargetState;
  pageScript: PageScriptStub;
  html: string;
  url: string;
  generation: number;
  owesIframeInstalls: boolean;
  cookies: string;
  span: Span | null;
}

async function runPageScriptNavigate(
  input: RunPageScriptNavigateInput,
): Promise<Awaited<ReturnType<PageScriptStub["navigate"]>>> {
  const { ctx, target, pageScript, html, url, generation, owesIframeInstalls, cookies, span } =
    input;
  const tracer = ctx.env.HOST_TRACER;
  const traced = setupPageScriptNavigationTrace(ctx, target, generation, span, tracer);
  const navigate = pageScript.navigate(
    html,
    url,
    pageScriptNavigateOptions(ctx, target, cookies, owesIframeInstalls, traced),
  );
  pageScript.armAwaitLoad?.();
  const summary = await navigate;
  tagPageScriptNavigationPhases(span, summary.phases);
  return summary;
}

function setupPageScriptNavigationTrace(
  ctx: DispatchCtx,
  target: TargetState,
  generation: number,
  span: Span | null,
  tracer: DispatchCtx["env"]["HOST_TRACER"],
): boolean {
  if (!span || !span.isRecording || !tracer) return false;
  target.diagSpans?.closeAll("superseded");
  target.diagSpans = new DiagSpanTracker(tracer, tracer.getSpanContext());
  registerTailTrace(
    pageScriptCacheKey({
      connectionId: ctx.connectionId,
      targetId: target.targetId,
      navigateGeneration: generation,
    }),
    tracer,
    tracer.getSpanContext(),
  );
  return true;
}

function pageScriptNavigateOptions(
  ctx: DispatchCtx,
  target: TargetState,
  cookies: string,
  owesIframeInstalls: boolean,
  traced: boolean,
): PageScriptNavigateOptions {
  return {
    cookies,
    ...tracedPageScriptOption(traced),
    expectIframeInstalls: owesIframeInstalls,
    ...documentCharsetOption(target),
    ...darkColorSchemeOption(ctx),
    ...terminalPageScriptOptions(ctx),
    connectionId: ctx.connectionId,
    mainFrameId: target.frameId,
    cookieKey: cookieKeyFor(ctx.connectionId, target.browserContextId),
    bindingNames: pendingBindingNames(ctx),
    ...viewportPageScriptOptions(target),
  };
}

function tracedPageScriptOption(traced: boolean): { traced?: true } {
  return traced ? { traced: true } : {};
}

function documentCharsetOption(target: TargetState): { charset?: string } {
  return target.docCharset ? { charset: target.docCharset } : {};
}

function darkColorSchemeOption(ctx: DispatchCtx): { darkColorScheme?: boolean } {
  const darkColorScheme = ctx.browser.darkColorScheme;
  return darkColorScheme !== undefined ? { darkColorScheme } : {};
}

function terminalPageScriptOptions(
  ctx: DispatchCtx,
): Pick<PageScriptNavigateOptions, "ttyUaCss" | "ttyCellW" | "ttyCellH" | "ttyCss"> {
  const browser = ctx.browser;
  const ttyUaCss = browser.ttyUaCss;
  if (ttyUaCss) return terminalUaCssPageScriptOptions(browser, ttyUaCss);
  return terminalKeyboardPageScriptOptions(browser.ttyKeyboard);
}

function terminalUaCssPageScriptOptions(
  browser: DispatchCtx["browser"],
  ttyUaCss: number,
): Pick<PageScriptNavigateOptions, "ttyUaCss" | "ttyCellW" | "ttyCellH" | "ttyCss"> {
  const ttyCellW = browser.ttyCellW ?? DEFAULT_TTY_CELL_WIDTH_PX;
  const ttyCellH = browser.ttyCellH ?? DEFAULT_TTY_CELL_HEIGHT_PX;
  return {
    ttyUaCss,
    ttyCellW,
    ttyCellH,
    ttyCss: ttyUaStylesheet(ttyUaCss, ttyCellH, ttyCellW),
  };
}

function terminalKeyboardPageScriptOptions(
  ttyKeyboard: boolean | undefined,
): Pick<PageScriptNavigateOptions, "ttyCss"> {
  return ttyKeyboard ? { ttyCss: ttyFocusStylesheet } : {};
}

function pendingBindingNames(ctx: DispatchCtx): string[] | undefined {
  return ctx.browser.pendingBindings.size > 0 ? Array.from(ctx.browser.pendingBindings) : undefined;
}

function viewportPageScriptOptions(
  target: TargetState,
): Pick<PageScriptNavigateOptions, "viewportWidth" | "viewportHeight"> {
  if (target.viewportWidth == null || target.viewportHeight == null) return {};
  return { viewportWidth: target.viewportWidth, viewportHeight: target.viewportHeight };
}

function tagPageScriptNavigationPhases(
  span: Span | null,
  phases: Record<string, number> | undefined,
): void {
  if (!span || !phases || typeof phases !== "object") return;
  span.setTags(pageScriptNavigationPhaseTags(phases));
}

function pageScriptNavigationPhaseTags(
  phases: Record<string, number>,
): Record<string, string | number | boolean> {
  const tags: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(phases)) {
    addPageScriptNavigationPhaseTag(tags, key, value);
  }
  return tags;
}

function addPageScriptNavigationPhaseTag(
  tags: Record<string, string | number | boolean>,
  key: string,
  value: number,
): void {
  if (typeof value === "number") tags[`phase.${key}`] = value;
}

async function disposeSupersededPageScript(
  ctx: DispatchCtx,
  pageScript: PageScriptStub,
): Promise<void> {
  await disposeStub(
    pageScript,
    { unload: "awaited", reason: "Page.navigate: superseded" },
    { budget: ctx.browser.workerBudget },
  );
}

async function cleanupFailedPageScriptNavigation(
  ctx: DispatchCtx,
  target: TargetState,
  pageScript: PageScriptStub,
): Promise<void> {
  if (target.pageScript !== pageScript) {
    await disposeStub(
      pageScript,
      { unload: "awaited", reason: "Page.navigate: navigate threw" },
      { budget: ctx.browser.workerBudget },
    );
    return;
  }
  try {
    await pageScript.unload();
  } catch {}
}

interface CompletePageScriptNavigationInput {
  ctx: DispatchCtx;
  target: TargetState;
  pageScript: PageScriptStub;
  summary: Awaited<ReturnType<PageScriptStub["navigate"]>>;
  consoleEntries: ConsoleEntry[];
  url: string;
  generation: number;
  navigationStartedAt: number;
  preSpawnWaitMs: number;
  bakeMs: number;
  initTimings: PageScriptInitTimings;
}

async function completePageScriptNavigateRpc(
  input: CompletePageScriptNavigationInput,
): Promise<NavigatePushResult> {
  const {
    ctx,
    target,
    pageScript,
    summary,
    consoleEntries,
    url,
    generation,
    navigationStartedAt,
    preSpawnWaitMs,
    bakeMs,
    initTimings,
  } = input;
  logCompletedPageScriptNavigation(url, summary);
  appendNavigationConsoleEntries(consoleEntries, summary.console);
  applyNavigateCookieWrites(ctx, target, url, summary.cookieWrites);
  const cdpMutations = nonEmptyNavigateMutations(summary.cdpMutations);
  updateNavigatePhases(target, summary.phases);
  emitNavigationSessionStart(
    ctx,
    url,
    summary.phases,
    navigationStartedAt,
    preSpawnWaitMs,
    bakeMs,
    initTimings,
  );
  await setInitialPageScriptViewport(target, pageScript);
  await setInitialPageScriptLayout(target, pageScript);
  if (!publishNavigatedPageScript(ctx, target, pageScript, generation)) {
    return { console: consoleEntries };
  }
  ctx.browser.screencasts.get(target.targetId)?.wake?.();
  wakeSceneStream(ctx.browser, target.targetId);
  await restorePageScriptMedia(ctx, target, pageScript);
  await activatePageScriptDom(target, pageScript);
  await syncNavigatedPageScriptStyles(ctx, target, pageScript);
  return {
    console: consoleEntries,
    phases: target.lastNavigatePhases ?? undefined,
    cdpMutations,
    exceptions: summary.exceptions,
  };
}

function logCompletedPageScriptNavigation(
  url: string,
  summary: Awaited<ReturnType<PageScriptStub["navigate"]>>,
): void {
  try {
    logCompletedPageScriptNavigationContent(url, summary);
  } catch (err) {
    console.warn(
      "[kitesurf-nav] post-navigate log threw (non-fatal):",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function logCompletedPageScriptNavigationContent(
  url: string,
  summary: Awaited<ReturnType<PageScriptStub["navigate"]>>,
): void {
  const consoleCount = optionalArrayLength(summary.console);
  const mutationCount = optionalArrayLength(summary.cdpMutations);
  const cookieCount = optionalArrayLength(summary.cookieWrites);
  const errorSuffix = completedNavigationErrorSuffix(summary.console);
  const bundle = completedBundleExecutionSuffix(summary.bundleExec);
  const fontSuffix = completedNavigationFontSuffix(summary.fontDegradedReads);
  console.log(
    `[kitesurf-nav] done url=${url} consoleEntries=${consoleCount} mutations=${mutationCount} ` +
      `cookieWrites=${cookieCount}${errorSuffix}${bundle}${fontSuffix}`,
  );
}

function completedNavigationErrorSuffix(entries: ConsoleEntry[] | undefined): string {
  const error = firstConsoleWarningOrError(entries);
  return error ? ` firstError="${error}"` : "";
}

function completedNavigationFontSuffix(degradedReads: number | undefined): string {
  const count = degradedReads ?? 0;
  return count > 0 ? ` fontDegradedReads=${count}` : "";
}

function completedBundleExecutionSuffix(bundleExec: string[] | undefined): string {
  return bundleExec && bundleExec.length > 0 ? ` bundleExec=${JSON.stringify(bundleExec)}` : "";
}

function appendNavigationConsoleEntries(
  consoleEntries: ConsoleEntry[],
  entries: ConsoleEntry[] | undefined,
): void {
  if (!entries) return;
  for (const entry of entries) consoleEntries.push(entry);
}

function applyNavigateCookieWrites(
  ctx: DispatchCtx,
  target: TargetState,
  url: string,
  cookieWrites: string[] | undefined,
): void {
  if (!cookieWrites || cookieWrites.length === 0) return;
  for (const raw of cookieWrites) {
    jarForTarget(ctx, target).setFromDocumentCookie(url, raw);
  }
}

function nonEmptyNavigateMutations(
  mutations: CdpMutation[] | undefined,
): CdpMutation[] | undefined {
  return mutations && mutations.length > 0 ? mutations : undefined;
}

function updateNavigatePhases(
  target: TargetState,
  phases: Record<string, number> | undefined,
): void {
  if (phases && typeof phases === "object") target.lastNavigatePhases = phases;
}

function emitNavigationSessionStart(
  ctx: DispatchCtx,
  url: string,
  phases: Record<string, number> | undefined,
  navigationStartedAt: number,
  preSpawnWaitMs: number,
  bakeMs: number,
  initTimings: PageScriptInitTimings,
): void {
  const navRpcMs = ctx.analytics.now() - navigationStartedAt;
  const wsUpgradeMs = initTimings.wsUpgradeMs ?? 0;
  emitSessionStart(ctx.analytics, {
    totalMs: ctx.analytics.sessionAgeMs(),
    preSpawnWaitMs,
    bakeMs,
    wsUpgradeMs,
    navRpcMs: Math.max(0, navRpcMs - wsUpgradeMs),
    parseMs: navigationPhaseMs(phases, "parseMs"),
    shimMs: navigationPhaseMs(phases, "shimMs"),
    fontsMs: navigationPhaseMs(phases, "fontsMs"),
    regularScriptsMs: navigationPhaseMs(phases, "regularScriptsMs"),
    moduleScriptsMs: navigationPhaseMs(phases, "moduleScriptsMs"),
    teardownMs: navigationPhaseMs(phases, "teardownMs"),
    spawnKind: "navigate",
    host: pageScriptOriginOf(url),
  });
}

function navigationPhaseMs(phases: Record<string, number> | undefined, name: string): number {
  const value = phases?.[name];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function setInitialPageScriptViewport(
  target: TargetState,
  pageScript: PageScriptStub,
): Promise<void> {
  if (target.viewportWidth == null || target.viewportHeight == null) return;
  try {
    await stubQueryDom(pageScript, "setViewport", {
      width: target.viewportWidth,
      height: target.viewportHeight,
    });
  } catch {}
}

async function setInitialPageScriptLayout(
  target: TargetState,
  pageScript: PageScriptStub,
): Promise<void> {
  if (!target.layoutMode || target.layoutMode === "full") return;
  try {
    await stubQueryDom(pageScript, "setLayoutMode", { mode: target.layoutMode });
  } catch {}
}

function publishNavigatedPageScript(
  ctx: DispatchCtx,
  target: TargetState,
  pageScript: PageScriptStub,
  generation: number,
): boolean {
  return publishStub(
    target,
    pageScript,
    {
      isStale: () => target.navigateGeneration !== generation,
      reason: "Page.navigate: superseded",
    },
    { budget: ctx.browser.workerBudget },
  );
}

async function restorePageScriptMedia(
  ctx: DispatchCtx,
  target: TargetState,
  pageScript: PageScriptStub,
): Promise<void> {
  if (target.emulatedMedia !== "print") return;
  try {
    await stubQueryDom(pageScript, "setMediaType", { media: "print" });
  } catch {}
}

async function activatePageScriptDom(
  target: TargetState,
  pageScript: PageScriptStub,
): Promise<void> {
  if (target.domEnabledSessions.size === 0) return;
  try {
    await stubQueryDom(pageScript, "setCdpDomActive", { active: true });
  } catch {}
}

async function syncNavigatedPageScriptStyles(
  ctx: DispatchCtx,
  target: TargetState,
  pageScript: PageScriptStub,
): Promise<void> {
  if (target.cssEnabledSessions.size === 0 && ctx.browser.connectionMode !== "page") return;
  try {
    await syncStyleSheetsFromEnumeration(ctx, target, pageScript);
  } catch {}
}

function emitExecutionContextCreated(
  ctx: DispatchCtx,
  target: TargetState,
  sessionId: string | undefined,
): void {
  const sessions = targetSessions(target, sessionId);
  if (target.defaultContextId > 0) {
    emitContextsCleared(ctx, target, sessionId);
  }
  target.defaultContextId = 1;
  emitDefaultExecutionContext(ctx, target, sessions);
  emitIsolatedExecutionContexts(ctx, target, sessions);
}

function emitDefaultExecutionContext(
  ctx: DispatchCtx,
  target: TargetState,
  sessions: Array<string | undefined>,
): void {
  const params = {
    context: {
      id: target.defaultContextId,
      origin: originOf(target.url),
      name: "",
      uniqueId: `cs-ctx-${target.targetId}-${target.navigateGeneration}`,
      auxData: {
        isDefault: true,
        type: "default",
        frameId: target.frameId,
      },
    },
  };
  for (const s of sessions) {
    ctx.emit({
      method: "Runtime.executionContextCreated",
      params,
      sessionId: s,
    });
  }
}

function emitIsolatedExecutionContexts(
  ctx: DispatchCtx,
  target: TargetState,
  sessions: Array<string | undefined>,
): void {
  for (const w of target.isolatedWorlds ?? []) {
    w.id = ctx.browser.execContextSeq++;
    const isoParams = {
      context: {
        id: w.id,
        origin: originOf(target.url),
        name: w.name,
        uniqueId: `cs-iso-${target.targetId}-${w.id}`,
        auxData: { isDefault: false, type: "isolated", frameId: w.frameId },
      },
    };
    for (const s of sessions) {
      ctx.emit({
        method: "Runtime.executionContextCreated",
        params: isoParams,
        sessionId: s,
      });
    }
  }
}

function emitCapturedConsole(
  ctx: DispatchCtx,
  target: TargetState,
  entries: ConsoleEntry[],
  sessionId: string | undefined,
): void {
  const sessions = targetSessions(target, sessionId);
  for (const e of entries) {
    const ev = consoleEntryToCdpEvent(e, target.defaultContextId || 1);
    for (const s of sessions) {
      ctx.emit({ method: ev.method, params: ev.params, sessionId: s });
    }
  }
}

function registerBundleScripts(
  ctx: DispatchCtx,
  target: TargetState,
  bundle: ScriptBundle | null,
): void {
  if (!bundle) return;
  const emit = (meta: ReturnType<typeof makeCompiledScriptMeta>) =>
    emitCompiledScriptMeta(ctx, target, meta);
  registerClassicBundleScripts(bundle, emit);
  registerModuleBundleScripts(bundle, emit);
}

function emitCompiledScriptMeta(
  ctx: DispatchCtx,
  target: TargetState,
  meta: ReturnType<typeof makeCompiledScriptMeta>,
): void {
  target.compiledScripts.push(meta);
  if (!hasDebuggerListeners(target)) return;
  for (const sid of target.debuggerEnabledSessions) {
    emitScriptParsed(
      ctx,
      meta,
      sid === "" ? undefined : sid,
      target.frameId,
      target.defaultContextId || undefined,
    );
  }
}

function registerClassicBundleScripts(
  bundle: ScriptBundle,
  emit: (meta: ReturnType<typeof makeCompiledScriptMeta>) => void,
): void {
  if (bundle.classicRegularSource) {
    emit(
      makeCompiledScriptMeta(
        "bundle:classic-regular",
        bundle.classicRegularSource,
        "/__ks_user_classic_regular.js",
        {
          source: bundle.classicRegularSource,
          sourceMapURL: bundle.classicRegularSourceMapURL ?? "",
        },
      ),
    );
  }
  if (bundle.classicAsyncSource) {
    emit(
      makeCompiledScriptMeta(
        "bundle:classic-async",
        bundle.classicAsyncSource,
        "/__ks_user_classic_async.js",
        {
          source: bundle.classicAsyncSource,
          sourceMapURL: bundle.classicAsyncSourceMapURL ?? "",
        },
      ),
    );
  }
}

function registerModuleBundleScripts(
  bundle: ScriptBundle,
  emit: (meta: ReturnType<typeof makeCompiledScriptMeta>) => void,
): void {
  for (let i = 0; i < bundle.moduleScriptUrls.length; i++) {
    const moduleUrl = bundle.moduleScriptUrls[i] ?? "";
    if (!moduleUrl) continue;
    const src = bundle.additionalModules[moduleUrl];
    if (!isBundleModuleSource(src)) continue;
    emit(
      makeCompiledScriptMeta("bundle:module-" + i, src, moduleUrl, {
        source: src,
        isModule: true,
      }),
    );
  }
}

function isBundleModuleSource(source: unknown): source is string {
  return typeof source === "string" && source.length > 0;
}

function emitCapturedExceptions(
  ctx: DispatchCtx,
  target: TargetState,
  entries: ExceptionEntry[] | undefined,
  sessionId: string | undefined,
): void {
  if (!entries || entries.length === 0) return;
  const sessions = targetSessions(target, sessionId);
  const contextId = target.defaultContextId || 1;
  for (const entry of entries) {
    emitCapturedException(ctx, entry, contextId, sessions);
  }
}

function emitCapturedException(
  ctx: DispatchCtx,
  entry: ExceptionEntry,
  contextId: number,
  sessions: Array<string | undefined>,
): void {
  const ev = exceptionEntryToCdpEvent(entry, ++exceptionIdSeq, contextId);
  for (const sessionId of sessions) {
    ctx.emit({ method: ev.method, params: ev.params, sessionId });
  }
}

let exceptionIdSeq = 0;

export function mainFrame(t: TargetState): FrameState {
  const main = t.frames.get(t.frameId);
  if (main) return main;
  return makeMainFrameState({ frameId: t.frameId, loaderId: t.loaderId, url: t.url });
}

function navErrorText(err: unknown, aborted: boolean): string | null {
  if (aborted) return "net::ERR_ABORTED";
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  return matchingNavigationError(name, msg);
}

function matchingNavigationError(name: string, message: string): string | null {
  const rules = [
    { matches: name === "AbortError", text: "net::ERR_ABORTED" },
    { matches: /\baborted\b/i.test(message), text: "net::ERR_ABORTED" },
    { matches: name === "InvalidRedirectError", text: "net::ERR_INVALID_REDIRECT" },
    { matches: /refused/i.test(message), text: "net::ERR_CONNECTION_REFUSED" },
    { matches: /ECONNREFUSED/i.test(message), text: "net::ERR_CONNECTION_REFUSED" },
    { matches: /network connection lost/i.test(message), text: "net::ERR_CONNECTION_REFUSED" },
    { matches: /ENOTFOUND/i.test(message), text: "net::ERR_NAME_NOT_RESOLVED" },
    { matches: /name not resolved/i.test(message), text: "net::ERR_NAME_NOT_RESOLVED" },
    { matches: /could not resolve/i.test(message), text: "net::ERR_NAME_NOT_RESOLVED" },
    { matches: /dns/i.test(message), text: "net::ERR_NAME_NOT_RESOLVED" },
  ];
  for (const rule of rules) {
    if (rule.matches) return rule.text;
  }
  return null;
}

function targetSessions(
  target: TargetState,
  fallback: string | undefined,
): Array<string | undefined> {
  const out = new Set<string | undefined>();
  for (const s of target.sessions) out.add(s);
  out.add(fallback ? fallback : undefined);
  return Array.from(out);
}

function targetSessionsNetwork(
  target: TargetState,
  fallback: string | undefined,
): Array<string | undefined> {
  if (target.sessions.size > 0) {
    return Array.from(target.sessions);
  }
  return [fallback ? fallback : undefined];
}

function emitFrameStartedLoading(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
  sessionId: string | undefined,
): void {
  for (const s of targetSessions(target, sessionId)) {
    ctx.emit({
      method: "Page.frameStartedLoading",
      params: { frameId: frame.frameId },
      sessionId: s,
    });
  }
}

function emitFrameNavigated(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
  sessionId: string | undefined,
): void {
  if (frame.frameId === target.frameId) {
    emitContextsCleared(ctx, target, sessionId);
  }
  const params: Protocol.Page.FrameNavigatedEvent = {
    frame: makeFrameInfo(frame),
    type: "Navigation",
  };
  for (const s of targetSessions(target, sessionId)) {
    ctx.emit({
      method: "Page.frameNavigated",
      params,
      sessionId: s,
    });
  }
}

function emitContextsCleared(
  ctx: DispatchCtx,
  target: TargetState,
  sessionId: string | undefined,
): void {
  if (target.defaultContextId === 0) return;
  target.defaultContextId = 0;
  resetIsolatedWorldContextIds(target);
  emitExecutionContextsCleared(ctx, targetSessions(target, sessionId));
}

function resetIsolatedWorldContextIds(target: TargetState): void {
  for (const world of target.isolatedWorlds ?? []) {
    if (world.id > 0) (target.retiredContextIds ??= new Set()).add(world.id);
    world.id = 0;
  }
}

function emitExecutionContextsCleared(ctx: DispatchCtx, sessions: Array<string | undefined>): void {
  for (const s of sessions) {
    ctx.emit({ method: "Runtime.executionContextsCleared", sessionId: s });
  }
}

export function emitFrameDclComplete(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
  sessionId: string | undefined,
): void {
  const ts = Date.now() / MILLISECONDS_PER_SECOND;
  const sessions = targetSessions(target, sessionId);
  for (const name of ["init", "DOMContentLoaded"] as const) {
    const params: Protocol.Page.LifecycleEventEvent = {
      frameId: frame.frameId,
      loaderId: frame.loaderId,
      name,
      timestamp: ts,
    };
    for (const s of sessions) {
      ctx.emit({
        method: "Page.lifecycleEvent",
        params,
        sessionId: s,
      });
    }
  }
  if (frame.parentFrameId === null) {
    for (const s of sessions) {
      ctx.emit({
        method: "Page.domContentEventFired",
        params: { timestamp: ts },
        sessionId: s,
      });
    }
  }
  frame.lifecycle = "dcl";
}

export function emitFrameLoadComplete(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
  sessionId: string | undefined,
): void {
  const ts = Date.now() / MILLISECONDS_PER_SECOND;
  const sessions = targetSessions(target, sessionId);
  const params: Protocol.Page.LifecycleEventEvent = {
    frameId: frame.frameId,
    loaderId: frame.loaderId,
    name: "load",
    timestamp: ts,
  };
  emitLifecycleEvent(ctx, sessions, params);
  if (frame.parentFrameId === null) {
    emitMainFrameLoadComplete(ctx, target, sessions, ts);
  }
  emitFrameStoppedLoading(ctx, sessions, frame.frameId);
  if (frame.parentFrameId === null) {
    scheduleNetworkIdleEmit(ctx, target, frame, sessions);
  }
  frame.lifecycle = "load";
}

function emitLifecycleEvent(
  ctx: DispatchCtx,
  sessions: ReadonlyArray<string | undefined>,
  params: Protocol.Page.LifecycleEventEvent,
): void {
  for (const sessionId of sessions) {
    ctx.emit({ method: "Page.lifecycleEvent", params, sessionId });
  }
}

function emitMainFrameLoadComplete(
  ctx: DispatchCtx,
  target: TargetState,
  sessions: ReadonlyArray<string | undefined>,
  timestamp: number,
): void {
  target.lastLoadAt = Date.now();
  for (const sessionId of sessions) {
    ctx.emit({
      method: "Page.loadEventFired",
      params: { timestamp },
      sessionId,
    });
  }
}

function emitFrameStoppedLoading(
  ctx: DispatchCtx,
  sessions: ReadonlyArray<string | undefined>,
  frameId: string,
): void {
  for (const sessionId of sessions) {
    ctx.emit({
      method: "Page.frameStoppedLoading",
      params: { frameId },
      sessionId,
    });
  }
}

function scheduleLoadCompleteEmit(
  ctx: DispatchCtx,
  target: TargetState,
  sessionId: string | undefined,
  armedIframeGate = false,
): void {
  const pageScript = target.pageScript;
  if (!pageScript) return;
  if (typeof (pageScript as { awaitLoad?: unknown }).awaitLoad !== "function") {
    emitFrameLoadComplete(ctx, target, mainFrame(target), sessionId);
    return;
  }
  ctx.ctx.waitUntil(runLoadCompletion(ctx, target, pageScript, sessionId, armedIframeGate));
}

async function runLoadCompletion(
  ctx: DispatchCtx,
  target: TargetState,
  pageScript: PageScriptStub,
  sessionId: string | undefined,
  armedIframeGate: boolean,
): Promise<void> {
  const generation = target.navigateGeneration;
  const urlAtSchedule = target.url;
  const { iframeWaits, installWaits } = collectChildFrameLoadWaits(
    ctx,
    target,
    sessionId,
    generation,
  );
  armIframeInstallGate(ctx, target, generation, installWaits, armedIframeGate);
  const summaryWait = awaitLoadSummary(ctx, pageScript);
  drivePageTasks(ctx, target, summaryWait);
  const [summary] = await Promise.all([summaryWait, ...iframeWaits]);
  await completeLoadSummary(ctx, target, sessionId, generation, urlAtSchedule, summary);
}

function collectChildFrameLoadWaits(
  ctx: DispatchCtx,
  target: TargetState,
  sessionId: string | undefined,
  generation: number,
): { iframeWaits: Promise<void>[]; installWaits: Promise<void>[] } {
  const iframeWaits: Promise<void>[] = [];
  const installWaits: Promise<void>[] = [];
  for (const frame of target.frames.values()) {
    collectChildFrameLoadWait(ctx, target, frame, sessionId, generation, iframeWaits, installWaits);
  }
  return { iframeWaits, installWaits };
}

function collectChildFrameLoadWait(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
  sessionId: string | undefined,
  generation: number,
  iframeWaits: Promise<void>[],
  installWaits: Promise<void>[],
): void {
  const pendingLoad = frame.pendingLoad;
  if (frame.parentFrameId === null || !pendingLoad) return;
  let markInstalled: () => void = () => {};
  if (frameGatesLoadEvent(frame)) {
    installWaits.push(
      new Promise<void>((resolve) => {
        markInstalled = resolve;
      }),
    );
  }
  iframeWaits.push(
    pendingLoad
      .catch(() => {})
      .then(() =>
        finishPendingChildFrameLoad(ctx, target, frame, sessionId, generation, markInstalled),
      ),
  );
}

async function finishPendingChildFrameLoad(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
  sessionId: string | undefined,
  generation: number,
  markInstalled: () => void,
): Promise<void> {
  const pageScript = target.pageScript;
  try {
    if (isStaleChildFrameLoad(ctx.browser, target, frame, generation)) {
      releaseFrameDom(frame);
      return;
    }
    await installPendingIframeContent(pageScript, frame);
    releaseFrameDom(frame);
  } finally {
    markInstalled();
  }
  if (shouldSpawnLoadedOopif(pageScript, frame)) {
    await spawnOopifPipeline(ctx, target, frame);
  }
  emitChildFrameDclLoad(ctx, target, frame, sessionId);
}

function isStaleChildFrameLoad(
  browser: DispatchCtx["browser"],
  target: TargetState,
  frame: FrameState,
  generation: number,
): boolean {
  return browser.wsClosing || target.navigateGeneration !== generation || frame.detached;
}

function shouldSpawnLoadedOopif(pageScript: PageScriptStub | null, frame: FrameState): boolean {
  if (!pageScript) return false;
  if (!frame.url || frame.url === "about:blank") return false;
  return frame.isCrossOrigin || frame.hasScript;
}

async function installPendingIframeContent(
  pageScript: PageScriptStub | null,
  frame: FrameState,
): Promise<void> {
  if (!pageScript || typeof pageScript.installIframeContent !== "function") return;
  const html = frameOuterHtml(frame);
  try {
    await pageScript.installIframeContent({
      frameId: frame.frameId,
      ownerBackendNodeId: frame.ownerBackendNodeId,
      html,
      url: frame.url,
      failed: !frame.dom,
      mimeType: frame.mimeType,
      crossOrigin: isCrossOriginIframeContent(frame),
    });
  } catch (err) {
    console.warn(
      "[kitesurf-iframe] installIframeContent failed for " + frame.url + ":",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function frameOuterHtml(frame: FrameState): string {
  if (!frame.dom) return "";
  try {
    return frame.dom.outerHTML(0);
  } catch {
    return "";
  }
}

function isCrossOriginIframeContent(frame: FrameState): boolean {
  const hasNonBlankUrl = !!frame.url && frame.url !== "about:blank";
  return hasNonBlankUrl && (frame.isCrossOrigin || frame.hasScript);
}

function armIframeInstallGate(
  ctx: DispatchCtx,
  target: TargetState,
  generation: number,
  installWaits: Promise<void>[],
  armed: boolean,
): void {
  if (!armed) return;
  void Promise.all(installWaits)
    .then(() => settleIframeInstalls(ctx, target, generation))
    .catch(() => {});
}

function settleIframeInstalls(
  ctx: DispatchCtx,
  target: TargetState,
  generation: number,
): Promise<unknown> | undefined {
  if (ctx.browser.wsClosing || target.navigateGeneration !== generation) return;
  return target.pageScript?.iframeInstallsSettled?.();
}

async function awaitLoadSummary(
  ctx: DispatchCtx,
  pageScript: PageScriptStub,
): Promise<Partial<LoadCompletion>> {
  try {
    return await traceSpan(ctx.env.HOST_TRACER, "navigate.await_load", async (span) => {
      const summary = await pageScript.awaitLoad();
      tagLoadSummarySpan(ctx, span, summary);
      return summary;
    });
  } catch (err) {
    console.warn(
      "[kitesurf-nav] awaitLoad threw (firing load lifecycle anyway):",
      err instanceof Error ? err.message : String(err),
    );
    return {};
  }
}

function tagLoadSummarySpan(ctx: DispatchCtx, span: Span | null, summary: LoadCompletion): void {
  if (!span || typeof summary.sentAt !== "number") return;
  const receivedAt = Date.now();
  const tags: Record<string, string | number | boolean> = {
    reply_transit_ms: receivedAt - summary.sentAt,
    outbound_inflight_at_recv: getOutboundInflight(ctx.connectionId),
  };
  if (typeof summary.readyAt === "number") {
    tags.summary_queue_ms = summary.sentAt - summary.readyAt;
  }
  span.setTags(tags);
}

async function completeLoadSummary(
  ctx: DispatchCtx,
  target: TargetState,
  sessionId: string | undefined,
  generation: number,
  urlAtSchedule: string,
  summary: Partial<LoadCompletion>,
): Promise<void> {
  if (!isCurrentLoadCompletion(ctx, target, generation)) return;
  settleLoadDiagSpans(target, summary);
  applyLoadSummaryCookies(ctx, target, summary.cookieWrites, urlAtSchedule);
  emitLoadSummaryEvents(ctx, target, summary, sessionId);
  updateLoadNavigationPhases(target, summary.phases);
  await reconcileLoadTools(ctx, target);
  emitFrameLoadComplete(ctx, target, mainFrame(target), sessionId);
}

function isCurrentLoadCompletion(
  ctx: DispatchCtx,
  target: TargetState,
  generation: number,
): boolean {
  return !ctx.browser.wsClosing && target.navigateGeneration === generation;
}

function settleLoadDiagSpans(target: TargetState, summary: Partial<LoadCompletion>): void {
  if (!target.diagSpans) return;
  target.diagSpans.settleFromSummary(summary.phases ?? {});
  target.diagSpans.closeAll("load-complete");
  target.diagSpans = null;
}

function applyLoadSummaryCookies(
  ctx: DispatchCtx,
  target: TargetState,
  cookieWrites: string[] | undefined,
  url: string,
): void {
  if (!cookieWrites || cookieWrites.length === 0 || !url) return;
  for (const raw of cookieWrites) {
    jarForTarget(ctx, target).setFromDocumentCookie(url, raw);
  }
}

function emitLoadSummaryEvents(
  ctx: DispatchCtx,
  target: TargetState,
  summary: Partial<LoadCompletion>,
  sessionId: string | undefined,
): void {
  emitLoadConsole(ctx, target, summary.console, sessionId);
  emitLoadExceptions(ctx, target, summary.exceptions, sessionId);
  emitLoadMutations(ctx, target, summary.cdpMutations);
}

function emitLoadConsole(
  ctx: DispatchCtx,
  target: TargetState,
  entries: ConsoleEntry[] | undefined,
  sessionId: string | undefined,
): void {
  if (!entries || entries.length === 0) return;
  emitCapturedConsole(ctx, target, entries, sessionId);
}

function emitLoadExceptions(
  ctx: DispatchCtx,
  target: TargetState,
  entries: ExceptionEntry[] | undefined,
  sessionId: string | undefined,
): void {
  if (!entries || entries.length === 0) return;
  emitCapturedExceptions(ctx, target, entries, sessionId);
}

function emitLoadMutations(
  ctx: DispatchCtx,
  target: TargetState,
  mutations: CdpMutation[] | undefined,
): void {
  if (!mutations || mutations.length === 0) return;
  emitMutations(ctx, target, mutations);
}

function updateLoadNavigationPhases(
  target: TargetState,
  phases: LoadCompletion["phases"] | undefined,
): void {
  if (!phases) return;
  target.lastNavigatePhases = { ...(target.lastNavigatePhases ?? {}), ...phases };
}

async function reconcileLoadTools(ctx: DispatchCtx, target: TargetState): Promise<void> {
  try {
    await reconcileTools(ctx, target);
  } catch (err) {
    console.warn(
      "kitesurf: WebMCP reconcile failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

const backgroundDrainInFlight = new WeakSet<TargetState>();

export function pumpBackgroundEvents(ctx: DispatchCtx, target: TargetState): void {
  if (!canStartBackgroundDrain(target)) return;
  const pageScript = target.pageScript;
  if (!pageScript) return;
  backgroundDrainInFlight.add(target);
  const work = drainBackgroundEvents(ctx, target, pageScript, target.url);
  ctx.ctx.waitUntil(work);
}

function canStartBackgroundDrain(target: TargetState): boolean {
  if (target.type !== "page") return false;
  if (target.domEnabledSessions.size === 0) return false;
  return hasDrainConsole(target.pageScript) && !backgroundDrainInFlight.has(target);
}

function hasDrainConsole(pageScript: PageScriptStub | null | undefined): boolean {
  return !!pageScript && typeof pageScript.drainConsole === "function";
}

async function drainBackgroundEvents(
  ctx: DispatchCtx,
  target: TargetState,
  pageScript: PageScriptStub,
  urlAtSchedule: string,
): Promise<void> {
  try {
    const summary = await pageScript.drainConsole();
    if (!isCurrentBackgroundDrain(ctx, target, pageScript)) return;
    await emitBackgroundDrainSummary(ctx, target, summary, urlAtSchedule);
  } catch {
  } finally {
    backgroundDrainInFlight.delete(target);
  }
}

function isCurrentBackgroundDrain(
  ctx: DispatchCtx,
  target: TargetState,
  pageScript: PageScriptStub,
): boolean {
  return !ctx.browser.wsClosing && target.pageScript === pageScript;
}

async function emitBackgroundDrainSummary(
  ctx: DispatchCtx,
  target: TargetState,
  summary: Awaited<ReturnType<PageScriptStub["drainConsole"]>>,
  urlAtSchedule: string,
): Promise<void> {
  applyLoadSummaryCookies(ctx, target, summary.cookieWrites, urlAtSchedule);
  emitLoadConsole(ctx, target, summary.console, undefined);
  emitLoadExceptions(ctx, target, summary.exceptions, undefined);
  emitLoadMutations(ctx, target, summary.cdpMutations);
  if (!summary.documentReopened) return;
  const { replayReopenedLifecycle } = await import("./runtime.ts");
  replayReopenedLifecycle(ctx, target, summary, undefined);
}

const PUMP_TASKS_TIMEOUT_MS = 5_000;

interface PumpTasksResult {
  seq: number;
  animating: boolean;
  pumped: number;
  idle: boolean;
  nextRafDelayMs?: number;
}

async function pumpPageTasks(
  target: TargetState,
  timeoutMs: number = PUMP_TASKS_TIMEOUT_MS,
  armWakeAfterSeq?: number,
  frameIntervalMs?: number,
): Promise<PumpTasksResult | null> {
  const pageScript = target.pageScript;
  if (!pageScript) return null;
  try {
    const result = await withTimeout(
      stubQueryDom(pageScript, "pumpTasks", { armWakeAfterSeq, frameIntervalMs }),
      timeoutMs,
      "pumpTasks",
    );
    return normalizePumpTasksResult(result);
  } catch {
    return null;
  }
}

function normalizePumpTasksResult(result: QueryDomResult<"pumpTasks">): PumpTasksResult {
  return {
    seq: typeof result.seq === "number" ? result.seq : 0,
    animating: result.animating === true,
    pumped: typeof result.pumped === "number" ? result.pumped : 0,
    idle: result.idle === true,
    nextRafDelayMs: result.nextRafDelayMs,
  };
}

const DRIVE_IDLE_POLL_MS = 16;
const DRIVE_IDLE_STOP_MS = 1_000;
const DRIVE_MAX_MS = 15_000;

function drivePageTasks(ctx: DispatchCtx, target: TargetState, loaded: Promise<unknown>): void {
  const generation = target.navigateGeneration;
  let isLoaded = false;
  void loaded.finally(() => {
    isLoaded = true;
  });
  ctx.ctx.waitUntil(drivePageTaskLoop(ctx, target, generation, () => isLoaded));
}

async function drivePageTaskLoop(
  ctx: DispatchCtx,
  target: TargetState,
  generation: number,
  isLoaded: () => boolean,
): Promise<void> {
  const start = Date.now();
  let idleSince: number | null = null;
  while (Date.now() - start < DRIVE_MAX_MS) {
    if (pageTaskDriveIsStale(ctx.browser, target, generation)) return;
    const result = await pumpPageTasks(target);
    const step = pageTaskDriveStep(result, idleSince, isLoaded());
    if (step.kind === "stop") return;
    if (step.kind === "worked") {
      idleSince = null;
      continue;
    }
    idleSince = step.idleSince;
    await new Promise((resolve) => setTimeout(resolve, DRIVE_IDLE_POLL_MS));
  }
}

type PageTaskDriveStep =
  | { kind: "stop" }
  | { kind: "worked" }
  | { kind: "idle"; idleSince: number };

function pageTaskDriveStep(
  result: PumpTasksResult | null,
  idleSince: number | null,
  isLoaded: boolean,
): PageTaskDriveStep {
  if (!result) return { kind: "stop" };
  if (result.pumped < 0) return { kind: "stop" };
  if (result.pumped > 0) return { kind: "worked" };
  const nextIdleSince = markPageTaskIdle(idleSince);
  if (shouldStopAfterPageTaskIdle(isLoaded, nextIdleSince)) return { kind: "stop" };
  return { kind: "idle", idleSince: nextIdleSince };
}

function pageTaskDriveIsStale(
  browser: DispatchCtx["browser"],
  target: TargetState,
  generation: number,
): boolean {
  return browser.wsClosing || target.navigateGeneration !== generation;
}

function markPageTaskIdle(idleSince: number | null): number {
  return idleSince ?? Date.now();
}

function shouldStopAfterPageTaskIdle(isLoaded: boolean, idleSince: number): boolean {
  return isLoaded && Date.now() - idleSince >= DRIVE_IDLE_STOP_MS;
}

const NETWORK_IDLE_QUIET_MS = 500;
const NETWORK_IDLE_MAX_WAIT_MS = 5000;
const NETWORK_IDLE_POLL_MS = 50;

function scheduleNetworkIdleEmit(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
  sessions: ReadonlyArray<string | undefined>,
): void {
  const work = runNetworkIdleWait(ctx, target, frame.frameId, frame.loaderId, sessions);
  ctx.ctx.waitUntil(work);
}

interface NetworkIdleStep {
  quietSince: number | null;
  done: boolean;
}

async function runNetworkIdleWait(
  ctx: DispatchCtx,
  target: TargetState,
  frameId: string,
  loaderId: string,
  sessions: ReadonlyArray<string | undefined>,
): Promise<void> {
  const start = Date.now();
  let quietSince: number | null = null;
  while (Date.now() - start < NETWORK_IDLE_MAX_WAIT_MS) {
    const step = await pollNetworkIdle(ctx, target, quietSince, start);
    quietSince = step.quietSince;
    if (step.done) break;
  }
  if (ctx.browser.wsClosing) return;
  emitNetworkIdleLifecycle(ctx, frameId, loaderId, sessions);
}

async function pollNetworkIdle(
  ctx: DispatchCtx,
  target: TargetState,
  quietSince: number | null,
  start: number,
): Promise<NetworkIdleStep> {
  if (ctx.browser.wsClosing) return { quietSince, done: true };
  const leftMs = NETWORK_IDLE_MAX_WAIT_MS - (Date.now() - start);
  if (leftMs <= 0) return { quietSince, done: true };
  await pumpPageTasks(target, Math.min(leftMs, PUMP_TASKS_TIMEOUT_MS));
  if (ctx.browser.wsClosing) return { quietSince, done: true };
  const tracker = ctx.browser.networkEvents;
  tracker.drain();
  const step = advanceNetworkIdleQuietPeriod(tracker.getInFlight(), quietSince);
  if (step.done) return step;
  await new Promise((resolve) => setTimeout(resolve, NETWORK_IDLE_POLL_MS));
  return step;
}

function advanceNetworkIdleQuietPeriod(
  inFlight: number,
  quietSince: number | null,
): NetworkIdleStep {
  if (inFlight !== 0) return { quietSince: null, done: false };
  if (quietSince === null) return { quietSince: Date.now(), done: false };
  return {
    quietSince,
    done: Date.now() - quietSince >= NETWORK_IDLE_QUIET_MS,
  };
}

function emitNetworkIdleLifecycle(
  ctx: DispatchCtx,
  frameId: string,
  loaderId: string,
  sessions: ReadonlyArray<string | undefined>,
): void {
  const params: Protocol.Page.LifecycleEventEvent = {
    frameId,
    loaderId,
    name: "networkIdle",
    timestamp: Date.now() / MILLISECONDS_PER_SECOND,
  };
  emitLifecycleEvent(ctx, sessions, params);
}

function emitNavigationLifecycle(
  ctx: DispatchCtx,
  target: TargetState,
  sessionId: string | undefined,
): void {
  emitFrameStartedLoading(ctx, target, mainFrame(target), sessionId);
  emitFrameNavigated(ctx, target, mainFrame(target), sessionId);
  rebuildFrameTreeChildren(target);
  const childFrames = [...target.frames.values()].filter(
    (frame) => frame.parentFrameId !== null && frame.lifecycle === "init",
  );
  emitChildFrameAttachAndStart(ctx, childFrames, targetSessions(target, sessionId));
  for (const f of target.frames.values()) {
    if (f.parentFrameId === null) continue;
    f.readyState = "complete";
    emitChildFrameDclLoad(ctx, target, f, sessionId);
  }
  emitFrameDclComplete(ctx, target, mainFrame(target), sessionId);
  emitFrameLoadComplete(ctx, target, mainFrame(target), sessionId);
  emitDocumentUpdated(ctx, target, sessionId);
}

function emitDocumentUpdated(
  ctx: DispatchCtx,
  target: TargetState,
  sessionId: string | undefined,
): void {
  for (const s of targetSessions(target, sessionId)) {
    ctx.emit({
      method: "DOM.documentUpdated",
      sessionId: s,
    });
  }
}

function withoutPlumbingHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase().startsWith("x-kitesurf-")) continue;
    out[k] = v;
  }
  return out;
}

function readSetCookieHeaders(resp: Response): string[] {
  const h = resp.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") {
    try {
      return h.getSetCookie();
    } catch {}
  }
  const single = resp.headers.get("set-cookie");
  return single ? [single] : [];
}

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const SVG_BREAKOUT_META = /<meta\b[^>]*?\/?>/gi;
function svgRootStart(source: string): number {
  let at = 0;
  while (at < source.length) {
    const lt = source.indexOf("<", at);
    if (lt < 0) return -1;
    const token = inspectSvgStartToken(source, lt);
    if (token.kind === "root") return lt;
    if (token.kind === "invalid") return -1;
    at = token.next;
  }
  return -1;
}

type SvgStartKind = "comment" | "instruction" | "doctype" | "root" | "invalid";
type SvgStartToken = { kind: "root" } | { kind: "invalid" } | { kind: "skip"; next: number };

const SVG_START_PATTERNS: readonly { kind: SvgStartKind; pattern: RegExp }[] = [
  { kind: "comment", pattern: /^<!--/ },
  { kind: "instruction", pattern: /^<\?/ },
  { kind: "doctype", pattern: /^<!doctype\b/i },
  { kind: "root", pattern: /^<svg[\s>]/i },
  { kind: "invalid", pattern: /^<[a-z!?/]/i },
];

function inspectSvgStartToken(source: string, lt: number): SvgStartToken {
  const rest = source.slice(lt);
  const match = SVG_START_PATTERNS.find((entry) => entry.pattern.test(rest));
  return svgStartTokenForKind(match?.kind, source, lt);
}

function svgStartTokenForKind(
  kind: SvgStartKind | undefined,
  source: string,
  lt: number,
): SvgStartToken {
  switch (kind) {
    case "comment":
      return skippedSvgComment(source, lt);
    case "instruction":
      return skippedSvgInstruction(source, lt);
    case "doctype":
      return skippedSvgDoctype(source, lt);
    case "root":
      return { kind: "root" };
    case "invalid":
      return { kind: "invalid" };
    default:
      return { kind: "skip", next: lt + 1 };
  }
}

function skippedSvgComment(source: string, lt: number): SvgStartToken {
  const close = source.indexOf("-->", lt + 4);
  return close < 0 ? { kind: "invalid" } : { kind: "skip", next: close + 3 };
}

function skippedSvgInstruction(source: string, lt: number): SvgStartToken {
  const close = source.indexOf("?>", lt + 2);
  return close < 0 ? { kind: "invalid" } : { kind: "skip", next: close + 2 };
}

function skippedSvgDoctype(source: string, lt: number): SvgStartToken {
  const bracket = source.indexOf("[", lt);
  const gt = source.indexOf(">", lt);
  const next = svgDoctypeEnd(source, bracket, gt);
  return next === null ? { kind: "invalid" } : { kind: "skip", next };
}

function svgDoctypeEnd(source: string, bracket: number, gt: number): number | null {
  if (gt < 0) return null;
  if (bracket < 0 || bracket >= gt) return svgDoctypeWithoutSubset(gt);
  return svgDoctypeWithSubset(source, bracket);
}

function svgDoctypeWithoutSubset(gt: number): number {
  return gt + 1;
}

function svgDoctypeWithSubset(source: string, bracket: number): number | null {
  const closeBracket = source.indexOf("]", bracket);
  if (closeBracket < 0) return null;
  const gtAfter = source.indexOf(">", closeBracket);
  return gtAfter < 0 ? null : gtAfter + 1;
}

function svgDocumentHtml(svgSource: string, viewport: { width: number; height: number }): string {
  const rootStart = svgRootStart(svgSource);
  const originalSvg = rootStart >= 0 ? svgSource.slice(rootStart) : svgSource;
  const { svg: cleanedSvg, lifted } = liftSvgMetadata(originalSvg);
  const svg = addSvgViewport(cleanedSvg, viewport);
  const rootTag = svgRootTag(svg);
  const hasViewBox = svgHasViewBox(rootTag);

  return (
    "<!doctype html><html><head><style>" +
    "html,body{margin:0;padding:0}" +
    `body>svg{display:block;${svgAxisRule(rootTag, hasViewBox, "width", "vw")}${svgAxisRule(rootTag, hasViewBox, "height", "vh")}}` +
    "</style>" +
    lifted.join("") +
    "</head><body>" +
    svg +
    "</body></html>"
  );
}

function liftSvgMetadata(svg: string): { svg: string; lifted: string[] } {
  const lifted: string[] = [];
  const cleanedSvg = svg.replace(SVG_BREAKOUT_META, (match) => {
    lifted.push(match);
    return "";
  });
  return { svg: cleanedSvg, lifted };
}

function addSvgViewport(svg: string, viewport: { width: number; height: number }): string {
  const rootTag = svgRootTag(svg);
  if (svgHasViewBox(rootTag) || hasAbsoluteSvgDimensions(rootTag)) return svg;
  const viewBox = `viewBox="0 0 ${viewport.width} ${viewport.height}"`;
  return svg.replace("<svg", `<svg ${viewBox}`);
}

function svgRootTag(svg: string): string {
  return svg.slice(0, svg.indexOf(">") + 1 || undefined);
}

function svgHasViewBox(rootTag: string): boolean {
  return /[\s"']viewBox\s*=/i.test(rootTag);
}

function hasAbsoluteSvgDimensions(rootTag: string): boolean {
  return hasAbsoluteSvgSize(rootTag, "width") && hasAbsoluteSvgSize(rootTag, "height");
}

function hasAbsoluteSvgSize(rootTag: string, attr: string): boolean {
  const match = rootTag.match(new RegExp(`[\\s"']${attr}\\s*=\\s*["']?\\s*([^"'\\s>]+)`, "i"));
  return !!match && !/%$/.test(match[1] ?? "");
}

function svgAxisRule(
  rootTag: string,
  hasViewBox: boolean,
  attr: "width" | "height",
  unit: "vw" | "vh",
): string {
  const match = rootTag.match(new RegExp(`[\\s"']${attr}\\s*=\\s*["']?\\s*([^"'\\s>]+)`, "i"));
  if (!match) return svgDefaultAxisRule(hasViewBox, attr, unit);
  return svgPercentageAxisRule(match[1] ?? "", hasViewBox, attr, unit);
}

function svgDefaultAxisRule(
  hasViewBox: boolean,
  attr: "width" | "height",
  unit: "vw" | "vh",
): string {
  if (hasViewBox) return `${attr}:100${unit};`;
  return "";
}

function svgPercentageAxisRule(
  value: string,
  hasViewBox: boolean,
  attr: "width" | "height",
  unit: "vw" | "vh",
): string {
  const percentage = value.match(/^([\d.]+)%$/);
  if (!percentage) return "";
  if (!hasViewBox) return "";
  return `${attr}:${percentage[1]}${unit};`;
}

function jsonViewerHtml(text: string, url: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return `<html><head><title>${escapeHtml(url)}</title></head><body><pre>${escapeHtml(text)}</pre></body></html>`;
  }

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(url)}</title>
<style>
  :root { color-scheme: light; }
  html, body {
    margin: 0;
    background: #fff;
    color: #111;
    font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  }
  body { padding: 16px 24px 32px; }
  .json-toolbar {
    position: fixed;
    top: 12px;
    right: 20px;
    display: inline-flex;
    border: 1px solid #aaa;
    border-radius: 3px;
    overflow: hidden;
    background: linear-gradient(#fdfdfd, #dadada);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.22);
    z-index: 1;
  }
  .json-toolbar button {
    min-width: 70px;
    padding: 6px 14px;
    border: 0;
    border-left: 1px solid #aaa;
    background: transparent;
    color: #333;
    font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    cursor: pointer;
  }
  .json-toolbar button:first-child { border-left: 0; }
  .json-toolbar button.active { background: linear-gradient(#d8d8d8, #f5f5f5); }
  .json-panel { padding-right: 200px; }
  pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
   /* Reserve a gutter on every row so leaf text aligns with disclosure controls. */
  .json-row {
    position: relative;
    padding-left: 14px;
    white-space: pre;
    min-height: 1.4em;
  }
  .json-row > .json-toggle {
    position: absolute;
    left: 0;
    top: 0;
    width: 12px;
    color: #aaa;
    cursor: pointer;
    user-select: none;
    font-size: 10px;
    line-height: 1.4em;
  }
   /* Fixed indentation keeps child rows aligned regardless of key length. */
  .json-children { margin-left: 14px; }
  .json-collapsed > .json-children,
  .json-collapsed > .json-close { display: none; }
   /* Show the preview only while the row is collapsed. */
  .json-preview { color: #888; }
  .json-row:not(.json-collapsed) > .json-summary > .json-preview { display: none; }
  .json-key { color: #881391; }
  .json-string { color: #c41a16; }
  .json-number { color: #1a01cc; }
  .json-bool { color: #1a01cc; font-weight: 600; }
  .json-null { color: #808080; font-weight: 600; }
  .json-punct { color: #444; }
</style>
</head>
<body>
<div class="json-toolbar" role="tablist" aria-label="JSON view mode">
  <button type="button" class="active" data-view="parsed" role="tab" aria-selected="true">Parsed</button>
  <button type="button" data-view="raw" role="tab" aria-selected="false">Raw</button>
</div>
<main>
  <section id="json-parsed" class="json-panel">${renderJsonRoot(parsed)}</section>
  <section id="json-raw" class="json-panel" style="display:none"><pre>${escapeHtml(text)}</pre></section>
</main>
<script>
  (function () {
    var parsedPanel = document.getElementById("json-parsed");
    var rawPanel = document.getElementById("json-raw");
    var buttons = document.querySelectorAll(".json-toolbar button");
    // The DOM shim does not reflect hidden into paint; use style.display.
    function show(view) {
      parsedPanel.style.display = view === "parsed" ? "" : "none";
      rawPanel.style.display = view === "raw" ? "" : "none";
      buttons.forEach(function (button) {
        var active = button.getAttribute("data-view") === view;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", active ? "true" : "false");
      });
    }
    buttons.forEach(function (button) {
      button.addEventListener("click", function () {
        show(button.getAttribute("data-view"));
      });
    });
    parsedPanel.addEventListener("click", function (ev) {
      var summary = ev.target.closest && ev.target.closest(".json-summary");
      if (!summary) return;
      var row = summary.parentElement;
      if (!row || !row.classList.contains("json-collapsible")) return;
      row.classList.toggle("json-collapsed");
    });
  })();
</script>
</body>
</html>`;
}

function renderJsonRoot(value: unknown): string {
  return renderJsonRow(value, null, true);
}

function renderJsonRow(value: unknown, keyJson: string | null, last: boolean): string {
  const keyHtml =
    keyJson === null
      ? ""
      : `<span class="json-key">${escapeHtml(keyJson)}</span><span class="json-punct">: </span>`;
  const trailing = last ? "" : `<span class="json-punct">,</span>`;
  if (isJsonScalarValue(value)) return renderJsonScalarRow(value, keyHtml, trailing);
  if (Array.isArray(value)) return renderJsonArrayRow(value, keyHtml, trailing, last);
  return renderJsonObjectRow(value as Record<string, unknown>, keyHtml, trailing, last);
}

function isJsonScalarValue(value: unknown): boolean {
  return value === null || typeof value !== "object";
}

function renderJsonScalarRow(value: unknown, keyHtml: string, trailing: string): string {
  return `<div class="json-row">${keyHtml}${renderJsonScalar(value)}${trailing}</div>`;
}

function renderJsonArrayRow(
  value: unknown[],
  keyHtml: string,
  trailing: string,
  last: boolean,
): string {
  if (value.length === 0) {
    return `<div class="json-row">${keyHtml}<span class="json-punct">[]</span>${trailing}</div>`;
  }
  const children = value
    .map((item, index) => renderJsonRow(item, null, index === value.length - 1))
    .join("");
  return renderJsonContainerRow(keyHtml, trailing, last, "[", "]", children);
}

function renderJsonObjectRow(
  value: Record<string, unknown>,
  keyHtml: string,
  trailing: string,
  last: boolean,
): string {
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return `<div class="json-row">${keyHtml}<span class="json-punct">{}</span>${trailing}</div>`;
  }
  const children = entries
    .map(([key, item], index) =>
      renderJsonRow(item, JSON.stringify(key), index === entries.length - 1),
    )
    .join("");
  return renderJsonContainerRow(keyHtml, trailing, last, "{", "}", children);
}

function renderJsonContainerRow(
  keyHtml: string,
  trailing: string,
  last: boolean,
  open: "[" | "{",
  close: "]" | "}",
  children: string,
): string {
  const preview = `${open === "[" ? "…]" : "…}"}${last ? "" : ","}`;
  return (
    `<div class="json-row json-collapsible">` +
    `<span class="json-toggle" aria-hidden="true">\u25bc</span>` +
    `<span class="json-summary">${keyHtml}<span class="json-punct">${open}</span>` +
    `<span class="json-preview">${preview}</span></span>` +
    `<div class="json-children">${children}</div>` +
    `<div class="json-close"><span class="json-punct">${close}</span>${trailing}</div>` +
    `</div>`
  );
}

function renderJsonScalar(value: unknown): string {
  if (value === null) return `<span class="json-null">null</span>`;
  switch (typeof value) {
    case "string":
      return `<span class="json-string">${escapeHtml(JSON.stringify(value))}</span>`;
    case "number":
      return `<span class="json-number">${escapeHtml(JSON.stringify(value))}</span>`;
    case "boolean":
      return `<span class="json-bool">${value ? "true" : "false"}</span>`;
    default:
      return `<span class="json-null">null</span>`;
  }
}

const STYLE_CACHE_TTL_MS = 5 * 60 * 1000;

function readAttr(attributes: string[] | undefined, name: string): string | null {
  if (!attributes) return null;
  const lower = name.toLowerCase();
  for (let i = 0; i + 1 < attributes.length; i += 2) {
    const value = readAttributePairValue(attributes, i, lower);
    if (value !== undefined) return value;
  }
  return null;
}

function readAttributePairValue(
  attributes: string[],
  index: number,
  lowerName: string,
): string | undefined {
  if (attributes[index]?.toLowerCase() !== lowerName) return undefined;
  return attributes[index + 1];
}

interface ParsedNodeInfo {
  attributes?: string[];
  localName?: string;
  nodeName?: string;
}

function findStylesheetLinks(dom: DomHandle): Array<{ nodeId: number; href: string }> {
  const ids = queryNodeIds(dom, "link[rel='stylesheet']");
  if (!ids) return [];
  const out: Array<{ nodeId: number; href: string }> = [];
  for (const id of ids) {
    const link = stylesheetLinkForNode(dom, id);
    if (link) out.push(link);
  }
  return out;
}

function queryNodeIds(dom: DomHandle, selector: string): Int32Array | null {
  try {
    return dom.querySelectorAll(selector);
  } catch {
    return null;
  }
}

function stylesheetLinkForNode(
  dom: DomHandle,
  nodeId: number,
): { nodeId: number; href: string } | null {
  if (nodeId < 0) return null;
  const href = readAttr(safeNodeInfo(dom, nodeId)?.attributes, "href");
  return href ? { nodeId, href } : null;
}

interface IframeElementInfo {
  nodeId: number;
  src: string | null;
  name: string | null;
  loading: string | null;
}

function findIframes(dom: DomHandle): IframeElementInfo[] {
  const ids = queryNodeIds(dom, "iframe");
  if (!ids) return [];
  const out: IframeElementInfo[] = [];
  for (const id of ids) {
    const iframe = iframeInfoForNode(dom, id);
    if (iframe) out.push(iframe);
  }
  return out;
}

function iframeInfoForNode(dom: DomHandle, nodeId: number): IframeElementInfo | null {
  if (nodeId < 0) return null;
  const info = safeNodeInfo(dom, nodeId);
  if (!info) return null;
  return {
    nodeId,
    src: readAttr(info.attributes, "src"),
    name: readAttr(info.attributes, "name"),
    loading: readAttr(info.attributes, "loading"),
  };
}

function iframeDelaysLoadEvent(loading: string | null | undefined): boolean {
  return (loading ?? "").trim().toLowerCase() !== "lazy";
}

function discoverChildFramesFor(
  target: TargetState,
  parentFrame: FrameState,
  parentDom: DomHandle,
): FrameState[] {
  const baseUrl = parentFrame.url || target.url;
  const iframes = findIframes(parentDom);
  const registered: FrameState[] = [];
  for (const ifr of iframes) {
    const childFrame = makeDiscoveredChildFrame(target, parentFrame, ifr, baseUrl, ifr.nodeId);
    const childFrameId = childFrame.frameId;
    target.frames.set(childFrameId, childFrame);
    registered.push(childFrame);
  }
  return registered;
}

function makeDiscoveredChildFrame(
  target: TargetState,
  parentFrame: FrameState,
  iframe: Pick<IframeElementInfo, "src" | "loading">,
  baseUrl: string,
  ownerBackendNodeId: number,
): FrameState {
  const url = resolvedIframeUrl(iframe.src, baseUrl);
  return makeChildFrameState({
    frameId: mintFrameId(),
    parentFrameId: parentFrame.frameId,
    loaderId: mintLoaderId(),
    url,
    ownerBackendNodeId,
    isCrossOrigin: url !== "about:blank" && originOf(url) !== originOf(target.url),
    delaysLoadEvent: iframeDelaysLoadEvent(iframe.loading),
  });
}

function resolvedIframeUrl(src: string | null, baseUrl: string): string {
  if (!src) return "about:blank";
  try {
    return new URL(src, baseUrl || undefined).toString();
  } catch {
    return "about:blank";
  }
}

const OOPIF_POLL_TIMEOUT_MS = 10_000;

async function pollOopifFrames(ctx: DispatchCtx, target: TargetState): Promise<void> {
  const parentPs = target.pageScript;
  if (!parentPs) return;
  for (const frame of target.frames.values()) {
    await pollOopifFrameOrRetry(ctx, target, frame, parentPs);
  }
}

async function pollOopifFrameOrRetry(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
  parentPageScript: PageScriptStub,
): Promise<void> {
  const childPageScript = frame.pageScript;
  if (!childPageScript) {
    retryBlockedOopifSpawn(ctx, target, frame);
    return;
  }
  await pollOopifFrame(ctx, target, frame, childPageScript, parentPageScript);
}

function retryBlockedOopifSpawn(ctx: DispatchCtx, target: TargetState, frame: FrameState): void {
  if (!isOopifSpawnRetryable(ctx, frame)) return;
  ctx.ctx.waitUntil(spawnOopifPipeline(ctx, target, frame));
}

function isOopifSpawnRetryable(ctx: DispatchCtx, frame: FrameState): boolean {
  if (!frame.oopifBlocked) return false;
  if (frame.requestBlocked || frame.detached || frame.oopifSpawning) return false;
  return ctx.browser.workerBudget.canSpawnOopif();
}

const oopifPassInFlight = new WeakMap<TargetState, Promise<void>>();

function oopifPass(ctx: DispatchCtx, target: TargetState): Promise<void> {
  const existing = oopifPassInFlight.get(target);
  if (existing) return existing;
  const pass = (async () => {
    try {
      await pollOopifFrames(ctx, target);
    } finally {
      oopifPassInFlight.delete(target);
    }
  })();
  oopifPassInFlight.set(target, pass);
  return pass;
}

async function captureOopifFrames(
  ctx: DispatchCtx,
  target: TargetState,
  budgetMs: number,
): Promise<void> {
  const pass = oopifPass(ctx, target);
  if (budgetMs <= 0) {
    ctx.ctx.waitUntil(pass.catch(() => {}));
    return;
  }
  try {
    await withTimeout(pass, budgetMs, "oopif capture pass");
  } catch (err) {
    ctx.ctx.waitUntil(pass.catch(() => {}));
    console.warn(
      "[kitesurf-oopif] capture pass exceeded budget; capturing partial:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function pumpOopifFrames(ctx: DispatchCtx, target: TargetState): void {
  if (!target.pageScript) return;
  if (ctx.browser.wsClosing) return;
  if (oopifPassInFlight.has(target)) return;
  if (!hasOopifChild(target)) return;
  ctx.ctx.waitUntil(oopifPass(ctx, target).catch(() => {}));
}

function hasOopifChild(target: TargetState): boolean {
  for (const frame of target.frames.values()) {
    if (frame.pageScript) return true;
  }
  return false;
}

async function pollOopifFrame(
  ctx: DispatchCtx,
  target: TargetState,
  f: FrameState,
  child: PageScriptStub,
  parentPs: PageScriptStub,
): Promise<void> {
  try {
    const result = await renderOopifPollFrame(ctx, target, f, child);
    await applyOopifPollFrameResult(ctx, f, parentPs, result);
  } catch (err) {
    warnOopifPollFailure(f, err);
  }
}

type OopifRasterResult = Awaited<
  ReturnType<typeof import("../eval/oopif-render.ts").recordAndRasterizeFrame>
>;
type OopifRasterSuccess = Extract<OopifRasterResult, { ok: true }>;

async function renderOopifPollFrame(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
  child: PageScriptStub,
): Promise<OopifRasterResult> {
  const { recordAndRasterizeFrame } = await import("../eval/oopif-render.ts");
  const manager = getRendererManager(ctx, target);
  try {
    return await withTimeout(
      recordAndRasterizeFrame(manager, child, {
        raster: { format: "rgba", omitBackground: false },
        sinceSeq: frame.lastRenderSeq,
      }),
      OOPIF_POLL_TIMEOUT_MS,
      "oopif recordAndRasterizeFrame",
    );
  } catch (err) {
    manager.dispose("oopif poll timed out");
    throw err;
  }
}

async function applyOopifPollFrameResult(
  ctx: DispatchCtx,
  frame: FrameState,
  parentPs: PageScriptStub,
  result: OopifRasterResult,
): Promise<void> {
  if (!result.ok) {
    console.warn(`[kitesurf-oopif] poll re-render failed for ${frame.url}: ${result.error}`);
    return;
  }
  if (result.bytes.length === 0) return;
  const dimensions = oopifPollFrameDimensions(frame, result);
  if (!dimensions || ctx.browser.wsClosing) return;
  const rc = await withTimeout(
    parentPs.setFrameBitmap({
      ownerBackendNodeId: frame.ownerBackendNodeId,
      ...dimensions,
      rgba: result.bytes,
    }),
    OOPIF_POLL_TIMEOUT_MS,
    "oopif setFrameBitmap",
  );
  updateOopifPollSequence(frame, result, rc);
}

function oopifPollFrameDimensions(
  frame: FrameState,
  result: OopifRasterSuccess,
): { width: number; height: number } | null {
  if (typeof result.width === "number" && typeof result.height === "number") {
    return { width: result.width, height: result.height };
  }
  console.warn(`[kitesurf-oopif] poll re-render: rgba envelope missing dims for ${frame.url}`);
  return null;
}

function updateOopifPollSequence(
  frame: FrameState,
  result: OopifRasterSuccess,
  rc: Awaited<ReturnType<PageScriptStub["setFrameBitmap"]>>,
): void {
  if (rc.ok) {
    frame.lastRenderSeq = typeof result.seq === "number" ? result.seq : frame.lastRenderSeq;
    return;
  }
  console.warn(
    `[kitesurf-oopif] poll setFrameBitmap rc=${rc.rc} for ${frame.url}${rc.error ? ": " + rc.error : ""}`,
  );
}

function warnOopifPollFailure(frame: FrameState, error: unknown): void {
  console.warn(
    `[kitesurf-oopif] poll threw for ${frame.url}:`,
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * Refuses a host-blocked child frame before it takes a worker lease, so it never spawns
 * an isolate. The refusal is sticky: budget retries in pollOopifFrames skip it.
 */
function refuseBlockedFrame(ctx: DispatchCtx, target: TargetState, f: FrameState): boolean {
  if (f.requestBlocked) return true;
  const blocker = ctx.requestBlocker;
  if (!blocker) return false;
  const verdict = classifyRequest(blocker, f.url, parentHostForFrame(target, f), "Document");
  if (!verdict) return false;
  f.requestBlocked = true;
  f.oopifBlocked = false;
  recordBlockedFrameRequest(ctx, target, f);
  console.warn(`[kitesurf-oopif] ${verdict.reason}, ${f.url} renders blank`);
  return true;
}

function parentHostForFrame(target: TargetState, frame: FrameState): string {
  return hostnameFromOrigin(parentOriginUrl(target, frame));
}

function parentOriginUrl(target: TargetState, frame: FrameState): string {
  const parentFrameId = frame.parentFrameId;
  if (!parentFrameId || parentFrameId === target.frameId) return target.url;
  return target.frames.get(parentFrameId)?.url ?? target.url;
}

function hostnameFromOrigin(url: string): string {
  try {
    const origin = originOf(url);
    return origin ? new URL(origin).hostname : "";
  } catch {}
  return "";
}

function recordBlockedFrameRequest(ctx: DispatchCtx, target: TargetState, frame: FrameState): void {
  const tracker = ctx.browser.networkEvents;
  if (tracker && frame.loaderId && frame.frameId) {
    const requestId = tracker.beginRequest({
      url: frame.url,
      method: "GET",
      headers: {},
      type: "Document",
      initiator: { type: "parser", url: originOf(target.url) },
      loaderId: frame.loaderId,
      frameId: frame.frameId,
      sessionIds: targetSessionsNetwork(target, undefined),
    });
    tracker.failRequest(requestId, "net::ERR_BLOCKED_BY_CLIENT", "subresource-filter");
  }
}

function oopifSpawnArgs(ctx: DispatchCtx, target: TargetState, f: FrameState): RenderFrameArgs {
  const embedder =
    f.parentFrameId && f.parentFrameId !== target.frameId
      ? target.frames.get(f.parentFrameId)
      : undefined;
  ctx.browser.networkEvents.setTargetAttribution(
    f.frameId,
    f.loaderId,
    f.sessions.size > 0 ? Array.from(f.sessions) : targetSessionsNetwork(target, undefined),
  );
  return {
    connectionId: ctx.connectionId,
    sandboxOutbound: ctx.browser.sandboxOutbound,
    cookieKey: cookieKeyFor(ctx.connectionId, target.browserContextId),
    targetId: target.targetId,
    frameId: f.frameId,
    frameLoaderId: f.loaderId,
    frameUrl: f.url,
    parentOrigin: originOf(embedder ? embedder.url : target.url),
    attributionHeaders: ctx.browser.attributionHeaders,
    makeUpstreamHandler: ({ stub, url }) => {
      const workerOwner = ctx.browser.dedicatedWorkers.ownerFor(
        target,
        f.frameId,
        stub,
        url,
        f.loaderId,
      );
      return (event, params) => {
        if (event === "kitesurf.postMessage") {
          routePostMessageToParent(target, f.frameId, params);
        } else if (isWorkerUpstreamEvent(event)) {
          ctx.browser.dedicatedWorkers.handle(ctx, workerOwner, event, params);
        }
      };
    },
  };
}

const MAX_PRESPAWNS_PER_NAVIGATE = 3;

const prespawnQueues = new WeakMap<TargetState, { tail: Promise<unknown>; started: number }>();

function prespawnQueueFor(target: TargetState): { tail: Promise<unknown>; started: number } {
  let q = prespawnQueues.get(target);
  if (!q) {
    q = { tail: Promise.resolve(), started: 0 };
    prespawnQueues.set(target, q);
  }
  return q;
}

function resetPrespawnBudget(target: TargetState): void {
  prespawnQueueFor(target).started = 0;
}

function prespawnOopifFrame(ctx: DispatchCtx, target: TargetState, f: FrameState): void {
  const queue = prespawnQueueFor(target);
  if (!canPrespawnOopifFrame(ctx, target, f, queue)) return;
  const lease = ctx.browser.workerBudget.acquire("oopif");
  if (!lease) return;
  f.pageScriptLease = lease;
  const url = f.url;
  const args = oopifSpawnArgs(ctx, target, f);
  queue.started++;
  const promise = queue.tail.then(() => performOopifPrespawn(ctx, f, args, url));
  const settled = promise.then((pre) => {
    if (!pre) {
      lease.release();
      if (f.pageScriptLease === lease) f.pageScriptLease = null;
    }
    return pre;
  });
  queue.tail = settled.catch(() => null);
  f.oopifPrespawn = { url, promise: settled };
  ctx.ctx.waitUntil(promise.then(() => {}));
}

function canPrespawnOopifFrame(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
  queue: { tail: Promise<unknown>; started: number },
): boolean {
  if (!isAvailableForOopifPrespawn(frame)) return false;
  if (queue.started >= MAX_PRESPAWNS_PER_NAVIGATE) return false;
  if (!isPrespawnFrameUrl(frame.url)) return false;
  if (!frame.isCrossOrigin) return false;
  return !refuseBlockedFrame(ctx, target, frame);
}

function isAvailableForOopifPrespawn(frame: FrameState): boolean {
  return !frame.pageScript && !frame.oopifPrespawn && !frame.detached;
}

function isPrespawnFrameUrl(url: string): boolean {
  if (!url || url === "about:blank") return false;
  return /^(https?|data):/i.test(url);
}

async function performOopifPrespawn(
  ctx: DispatchCtx,
  frame: FrameState,
  args: RenderFrameArgs,
  url: string,
): Promise<PrespawnedFrame | null> {
  if (frame.detached || ctx.browser.wsClosing) return null;
  try {
    const pre = await prespawnFrameIsolate(ctx, args);
    if (!pre.ok) return warnOopifPrespawnFailure(url, pre.error);
    return pre;
  } catch (err) {
    return warnOopifPrespawnThrow(url, err);
  }
}

async function prespawnFrameIsolate(
  ctx: DispatchCtx,
  args: RenderFrameArgs,
): Promise<Awaited<ReturnType<typeof import("../eval/oopif-render.ts").prespawnFrameIsolate>>> {
  const { prespawnFrameIsolate: prespawn } = await import("../eval/oopif-render.ts");
  return prespawn(ctx.env, ctx.ctx, args);
}

function warnOopifPrespawnFailure(url: string, error: string): null {
  console.warn(`[kitesurf-oopif] prespawn failed for ${url}: ${error}`);
  return null;
}

function warnOopifPrespawnThrow(url: string, error: unknown): null {
  console.warn(
    `[kitesurf-oopif] prespawn threw for ${url}:`,
    error instanceof Error ? error.message : String(error),
  );
  return null;
}

async function takeOopifPrespawn(
  f: FrameState,
  currentUrl: string,
): Promise<PrespawnedFrame | null> {
  const entry = f.oopifPrespawn;
  if (!entry) return null;
  f.oopifPrespawn = undefined;
  const pre = await entry.promise;
  if (!pre) return null;
  if (entry.url !== currentUrl) {
    await discardOopifPrespawnResult(pre, "oopif prespawn stale: src changed");
    return null;
  }
  return pre;
}

async function discardOopifPrespawnResult(pre: PrespawnedFrame, reason: string): Promise<void> {
  try {
    const { discardPrespawnedFrame } = await import("../eval/oopif-render.ts");
    await discardPrespawnedFrame(pre, reason);
  } catch {}
}

function discardOopifPrespawn(f: FrameState, reason: string): void {
  const entry = f.oopifPrespawn;
  if (!entry) return;
  f.oopifPrespawn = undefined;
  if (!f.pageScript) {
    f.pageScriptLease?.release();
    f.pageScriptLease = null;
  }
  void entry.promise.then((pre) => (pre ? discardOopifPrespawnResult(pre, reason) : undefined));
}

interface OopifSpawnOperation {
  ctx: DispatchCtx;
  target: TargetState;
  frame: FrameState;
  parentPageScript: PageScriptStub;
  lease: NonNullable<FrameState["pageScriptLease"]>;
  generation: number;
  url: string;
}

async function spawnOopifPipeline(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
): Promise<void> {
  const parentPageScript = target.pageScript;
  if (!parentPageScript) return;
  if (!canStartOopifPipeline(ctx, target, frame)) return;
  const lease = acquireOopifSpawnLease(ctx, frame);
  if (!lease) return;
  const operation = beginOopifSpawn(ctx, target, frame, parentPageScript, lease);
  try {
    await runOopifSpawn(operation);
  } catch (err) {
    warnOopifSpawnFailure(frame, err);
  } finally {
    finishOopifSpawn(frame, lease);
  }
}

function canStartOopifPipeline(ctx: DispatchCtx, target: TargetState, frame: FrameState): boolean {
  if (!isAvailableForOopifSpawn(frame)) return false;
  if (!isPrespawnFrameUrl(frame.url)) return false;
  if (!needsOopifChild(frame)) return false;
  return !refuseBlockedFrame(ctx, target, frame);
}

function isAvailableForOopifSpawn(frame: FrameState): boolean {
  return !frame.pageScript && !frame.oopifSpawning && !frame.detached;
}

function needsOopifChild(frame: FrameState): boolean {
  return frame.isCrossOrigin || frame.hasScript;
}

function acquireOopifSpawnLease(
  ctx: DispatchCtx,
  frame: FrameState,
): NonNullable<FrameState["pageScriptLease"]> | null {
  const lease = frame.pageScriptLease ?? ctx.browser.workerBudget.acquire("oopif");
  if (lease) return lease;
  markOopifSpawnBlocked(ctx, frame);
  return null;
}

function markOopifSpawnBlocked(ctx: DispatchCtx, frame: FrameState): void {
  if (frame.oopifBlocked) return;
  frame.oopifBlocked = true;
  console.warn(
    `[kitesurf-oopif] budget full, ${frame.url} renders blank ` +
      `(${ctx.browser.workerBudget.describe()})`,
  );
}

function beginOopifSpawn(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
  parentPageScript: PageScriptStub,
  lease: NonNullable<FrameState["pageScriptLease"]>,
): OopifSpawnOperation {
  frame.oopifBlocked = false;
  frame.pageScriptLease = lease;
  frame.oopifSpawning = true;
  return {
    ctx,
    target,
    frame,
    parentPageScript,
    lease,
    generation: target.navigateGeneration,
    url: frame.url,
  };
}

function finishOopifSpawn(
  frame: FrameState,
  lease: NonNullable<FrameState["pageScriptLease"]>,
): void {
  if (!frame.pageScript) {
    lease.release();
    frame.pageScriptLease = null;
  }
  frame.oopifSpawning = false;
}

async function runOopifSpawn(operation: OopifSpawnOperation): Promise<void> {
  const oopifRenderer = await import("../eval/oopif-render.ts");
  const viewport = await readOopifViewport(operation.parentPageScript, operation.frame);
  if (!isCurrentOopifSpawn(operation)) return;
  const args = { ...oopifSpawnArgs(operation.ctx, operation.target, operation.frame), viewport };
  const spawn = await createOopifSpawn(operation, args, oopifRenderer);
  if (!spawn.ok) return failOopifSpawn(operation, spawn.error);
  // Keep validation and publication in one continuation so teardown cannot miss the worker lease.
  if (!isCurrentOopifSpawn(operation)) {
    await discardStaleOopifSpawn(operation, spawn);
    return;
  }
  if (operation.frame.url !== operation.url) {
    await discardChangedOopifSpawn(operation, spawn);
    return;
  }
  await attachOopifSpawn(operation, spawn, oopifRenderer);
}

async function readOopifViewport(
  pageScript: PageScriptStub,
  frame: FrameState,
): Promise<{ width: number; height: number } | undefined> {
  try {
    const response = await stubQueryDom(pageScript, "getRect", {
      nodeId: frame.ownerBackendNodeId,
    });
    return viewportFromOopifRect(response);
  } catch {
    return undefined;
  }
}

function viewportFromOopifRect(
  response: QueryDomResult<"getRect">,
): { width: number; height: number } | undefined {
  const rect = response?.rect;
  if (!rect) return undefined;
  return validOopifViewport(rect.width, rect.height);
}

function validOopifViewport(
  width: unknown,
  height: unknown,
): { width: number; height: number } | undefined {
  if (typeof width !== "number" || typeof height !== "number" || width < 1 || height < 1) {
    return undefined;
  }
  return { width, height };
}

function isCurrentOopifSpawn(operation: OopifSpawnOperation): boolean {
  const { ctx, target, frame, generation } = operation;
  return (
    !ctx.browser.wsClosing &&
    target.navigateGeneration === generation &&
    target.frames.get(frame.frameId) === frame &&
    !frame.detached
  );
}

type OopifSpawnResult = Awaited<
  ReturnType<typeof import("../eval/oopif-render.ts").spawnAndNavigateFrame>
>;

async function createOopifSpawn(
  operation: OopifSpawnOperation,
  args: RenderFrameArgs,
  renderer: typeof import("../eval/oopif-render.ts"),
): Promise<OopifSpawnResult> {
  const pre = await takeOopifPrespawn(operation.frame, operation.frame.url);
  if (pre) return renderer.navigatePrespawnedFrame(pre, args);
  return renderer.spawnAndNavigateFrame(operation.ctx.env, operation.ctx.ctx, args);
}

function failOopifSpawn(operation: OopifSpawnOperation, error: string): void {
  console.warn(`[kitesurf-oopif] spawn failed for ${operation.frame.url}: ${error}`);
  operation.lease.release();
  operation.frame.pageScriptLease = null;
}

async function discardStaleOopifSpawn(
  operation: OopifSpawnOperation,
  spawn: Extract<OopifSpawnResult, { ok: true }>,
): Promise<boolean> {
  if (isCurrentOopifSpawn(operation)) return false;
  await closeOopifSpawn(spawn, "oopif spawn superseded");
  operation.lease.release();
  operation.frame.pageScriptLease = null;
  return true;
}

async function discardChangedOopifSpawn(
  operation: OopifSpawnOperation,
  spawn: Extract<OopifSpawnResult, { ok: true }>,
): Promise<boolean> {
  const { ctx, target, frame, url } = operation;
  if (frame.url === url) return false;
  await closeOopifSpawn(spawn, "oopif spawn stale: src changed mid-spawn");
  operation.lease.release();
  frame.pageScriptLease = null;
  frame.oopifSpawning = false;
  if (isRetryableOopifUrl(frame)) await spawnOopifPipeline(ctx, target, frame);
  return true;
}

function isRetryableOopifUrl(frame: FrameState): boolean {
  if (!frame.url || frame.url === "about:blank") return false;
  return needsOopifChild(frame);
}

async function closeOopifSpawn(
  spawn: Extract<OopifSpawnResult, { ok: true }>,
  reason: string,
): Promise<void> {
  try {
    await spawn.stub.unload();
  } catch {}
  try {
    spawn.stub.close?.(reason);
  } catch {}
}

async function attachOopifSpawn(
  operation: OopifSpawnOperation,
  spawn: Extract<OopifSpawnResult, { ok: true }>,
  renderer: typeof import("../eval/oopif-render.ts"),
): Promise<void> {
  const { ctx, target, frame } = operation;
  frame.pageScript = spawn.stub;
  updateOopifFinalUrl(frame, spawn.finalUrl);
  routeQueuedPostMessages(target, frame);
  frame.execContextId = ctx.browser.execContextSeq++;
  const { emitOopifExecutionContext } = await import("./runtime.ts");
  emitOopifExecutionContext(ctx, frame);
  announceOopifTarget(ctx, frame);
  if (ctx.browser.skipSpeculativeRaster) return;
  await rasterizeAttachedOopif(operation, spawn, renderer);
}

function updateOopifFinalUrl(frame: FrameState, finalUrl: string): void {
  if (!finalUrl || finalUrl === frame.url) return;
  frame.url = finalUrl;
  frame.securityOrigin = originOf(finalUrl);
}

function routeQueuedPostMessages(target: TargetState, frame: FrameState): void {
  const queued = frame.pendingPostMessages;
  frame.pendingPostMessages = undefined;
  for (const params of queued ?? []) {
    routePostMessageToChild(target, params);
  }
}

async function rasterizeAttachedOopif(
  operation: OopifSpawnOperation,
  spawn: Extract<OopifSpawnResult, { ok: true }>,
  renderer: typeof import("../eval/oopif-render.ts"),
): Promise<void> {
  const { ctx, target, frame, parentPageScript, generation } = operation;
  const manager = getRendererManager(ctx, target);
  const result = await renderer.recordAndRasterizeFrame(manager, spawn.stub, {
    raster: { format: "rgba", omitBackground: false },
  });
  await applyInitialOopifRaster(ctx, target, frame, parentPageScript, generation, result);
}

async function applyInitialOopifRaster(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
  parentPageScript: PageScriptStub,
  generation: number,
  result: OopifRasterResult,
): Promise<void> {
  if (!result.ok) {
    console.warn(`[kitesurf-oopif] render failed for ${frame.url}: ${result.error}`);
    return;
  }
  const dimensions = oopifPollFrameDimensions(frame, result);
  if (!dimensions || !isCurrentOopifGeneration(ctx, target, generation)) return;
  const response = await parentPageScript.setFrameBitmap({
    ownerBackendNodeId: frame.ownerBackendNodeId,
    ...dimensions,
    rgba: result.bytes,
  });
  updateInitialOopifRenderSequence(frame, result, response);
}

function isCurrentOopifGeneration(
  ctx: DispatchCtx,
  target: TargetState,
  generation: number,
): boolean {
  return !ctx.browser.wsClosing && target.navigateGeneration === generation;
}

function updateInitialOopifRenderSequence(
  frame: FrameState,
  result: OopifRasterSuccess,
  response: Awaited<ReturnType<PageScriptStub["setFrameBitmap"]>>,
): void {
  if (response.ok) {
    frame.lastRenderSeq = typeof result.seq === "number" ? result.seq : -1;
    return;
  }
  console.warn(
    `[kitesurf-oopif] setFrameBitmap rc=${response.rc} for ${frame.url}${response.error ? ": " + response.error : ""}`,
  );
}

function warnOopifSpawnFailure(frame: FrameState, error: unknown): void {
  console.warn(
    `[kitesurf-oopif] pipeline threw for ${frame.url}:`,
    error instanceof Error ? error.message : String(error),
  );
}

export function teardownOopifStubs(target: TargetState, reason: string, ctx?: DispatchCtx): void {
  for (const f of target.frames.values()) {
    teardownOopifStubForFrame(target, f, reason, ctx);
    releaseFrameDom(f);
  }
}

function teardownOopifStubForFrame(
  target: TargetState,
  f: FrameState,
  reason: string,
  ctx?: DispatchCtx,
): void {
  discardOopifPrespawn(f, reason);
  teardownOopifFrameOwnership(ctx, target, f, reason);
  if (!f.pageScript) return;
  const destroyedCtxId = f.execContextId;
  f.lastRenderSeq = -1;
  f.execContextId = 0;
  void retireStub(f, "frameTeardown", `oopif teardown: ${reason}`, {
    budget: ctx?.browser.workerBudget,
  });
  if (ctx && destroyedCtxId > 0) {
    (async () => {
      const { emitOopifExecutionContextDestroyed } = await import("./runtime.ts");
      emitOopifExecutionContextDestroyed(ctx, destroyedCtxId);
    })();
  }
}

function teardownOopifFrameOwnership(
  ctx: DispatchCtx | undefined,
  target: TargetState,
  frame: FrameState,
  reason: string,
): void {
  if (!ctx || frame.parentFrameId === null) return;
  ctx.browser.dedicatedWorkers.terminateFrame(target.targetId, frame.frameId, reason);
  if (shouldDestroyOopifTarget(ctx, frame)) {
    destroyOopifTarget(ctx, frame);
  } else {
    ctx.browser.networkEvents.deleteTargetAttribution(frame.frameId);
  }
}

function shouldDestroyOopifTarget(ctx: DispatchCtx, frame: FrameState): boolean {
  return ctx.browser.connectionMode === "browser" || frame.sessions.size > 0;
}

function rebuildFrameTreeChildren(target: TargetState): void {
  if (target.docScan) {
    discoverChildFramesFromScan(target, mainFrame(target), target.docScan);
    return;
  }
  if (!target.dom) return;
  discoverChildFramesFor(target, mainFrame(target), target.dom);
}

function discoverChildFramesFromScan(
  target: TargetState,
  parentFrame: FrameState,
  scan: DocScan,
): FrameState[] {
  const baseUrl = parentFrame.url || target.url;
  const registered: FrameState[] = [];
  for (const iframe of scan.iframes) {
    const childFrame = makeDiscoveredChildFrame(target, parentFrame, iframe, baseUrl, -1);
    const childFrameId = childFrame.frameId;
    target.frames.set(childFrameId, childFrame);
    registered.push(childFrame);
  }
  return registered;
}

async function backfillIframeOwnerNodeIds(target: TargetState): Promise<void> {
  const ps = target.pageScript;
  if (!ps) return;
  const frames = framesMissingOwnerNodeIds(target);
  if (frames.length === 0) return;
  const ids = await queryIframeNodeIds(ps);
  if (!ids) return;
  applyIframeOwnerNodeIds(frames, ids);
}

async function queryIframeNodeIds(ps: PageScriptStub): Promise<unknown[] | null> {
  try {
    const r = await stubQueryDom(ps, "querySelectorAll", {
      selector: "iframe",
    });
    return Array.isArray(r?.nodeIds) ? r.nodeIds : [];
  } catch {
    return null;
  }
}

function applyIframeOwnerNodeIds(frames: FrameState[], ids: unknown[]): void {
  const count = Math.min(frames.length, ids.length);
  for (let i = 0; i < count; i++) {
    backfillIframeOwnerNodeId(frames[i], ids[i]);
  }
}

function framesMissingOwnerNodeIds(target: TargetState): FrameState[] {
  const mainFrameId = mainFrame(target).frameId;
  return [...target.frames.values()].filter(
    (frame) => frame.parentFrameId === mainFrameId && frame.ownerBackendNodeId === -1,
  );
}

function backfillIframeOwnerNodeId(frame: FrameState | undefined, nodeId: unknown): void {
  if (frame && typeof nodeId === "number") frame.ownerBackendNodeId = nodeId;
}

const MAX_IFRAME_DEPTH = 8;

const IFRAME_DOC_WALK_BUDGET_MS = 15_000;

const SHEET_WALK_BUDGET_MS = 15_000;

function isSameOriginPathChange(from: string, to: string): boolean {
  try {
    const f = new URL(from);
    const t = new URL(to);
    if (f.origin !== t.origin) return false;
    if (f.pathname !== t.pathname) return true;
    if (f.search !== t.search) return true;
    return false;
  } catch {
    return false;
  }
}

export function installUpstreamEventHandler(
  ctx: DispatchCtx,
  target: TargetState,
  stub: PageScriptStub,
  generation: number,
  url: string,
): void {
  if (typeof stub.setUpstreamEventHandler !== "function") return;
  const workerOwner = ctx.browser.dedicatedWorkers.ownerFor(
    target,
    target.frameId,
    stub,
    url,
    target.loaderId,
  );
  stub.setUpstreamEventHandler((event, params) =>
    handleTargetUpstreamEvent(ctx, target, workerOwner, generation, event, params),
  );
}

function handleTargetUpstreamEvent(
  ctx: DispatchCtx,
  target: TargetState,
  workerOwner: ReturnType<DispatchCtx["browser"]["dedicatedWorkers"]["ownerFor"]>,
  generation: number,
  event: UpstreamEventName,
  params: ReceivedUpstreamParams,
): void {
  if (!isCurrentUpstreamGeneration(ctx, target, generation)) return;
  if (handleUpstreamSignalEvent(ctx, target, event, params)) return;
  if (handleWorkerEvent(ctx, workerOwner, event, params)) return;
  handleUpstreamFrameEvent(ctx, target, undefined, event, params);
}

function isCurrentUpstreamGeneration(
  ctx: DispatchCtx,
  target: TargetState,
  generation: number,
): boolean {
  return target.navigateGeneration === generation && !ctx.browser.wsClosing;
}

function handleUpstreamSignalEvent(
  ctx: DispatchCtx,
  target: TargetState,
  event: UpstreamEventName,
  params: ReceivedUpstreamParams,
): boolean {
  if (event === "kitesurf.diag") {
    target.diagSpans?.handle(params);
    return true;
  }
  if (event === "kitesurf.insertedScriptRan") {
    handleInsertedScriptEvent(ctx, target, params);
    return true;
  }
  if (event === "kitesurf.paintDirty") {
    handlePaintDirtyEvent(ctx, target);
    return true;
  }
  return false;
}

function handleInsertedScriptEvent(
  ctx: DispatchCtx,
  target: TargetState,
  params: ReceivedUpstreamParams,
): void {
  const inserted = recordableInsertedScript(params, target.url);
  if (!inserted) return;
  recordInsertedScript(
    ctx.browser.learnedInsertedScripts,
    inserted.pageUrl,
    inserted.url,
    inserted.bytes,
    inserted.run,
    target.browserContextId,
  );
}

interface RecordableInsertedScript {
  pageUrl: string;
  url: string;
  bytes: number;
  run: "baked" | "stale" | "boa";
}

function recordableInsertedScript(
  params: ReceivedUpstreamParams,
  pageUrl: string,
): RecordableInsertedScript | null {
  const inserted = params as { url?: unknown; bytes?: unknown; run?: unknown };
  if (typeof inserted.url !== "string" || typeof inserted.bytes !== "number" || !pageUrl)
    return null;
  return {
    pageUrl,
    url: inserted.url,
    bytes: inserted.bytes,
    run: insertedScriptRunKind(inserted.run),
  };
}

function insertedScriptRunKind(run: unknown): RecordableInsertedScript["run"] {
  if (run === "baked" || run === "stale") return run;
  return "boa";
}

function handlePaintDirtyEvent(ctx: DispatchCtx, target: TargetState): void {
  wakeSceneStream(ctx.browser, target.targetId);
  const screencast = ctx.browser.screencasts.get(target.targetId);
  if (!screencast) return;
  screencast.paintDirty = true;
  screencast.wake?.();
}

function handleWorkerEvent(
  ctx: DispatchCtx,
  workerOwner: ReturnType<DispatchCtx["browser"]["dedicatedWorkers"]["ownerFor"]>,
  event: UpstreamEventName,
  params: ReceivedUpstreamParams,
): boolean {
  if (!isWorkerUpstreamEvent(event)) return false;
  ctx.browser.dedicatedWorkers.handle(ctx, workerOwner, event, params);
  return true;
}

export function installIsolateLimitSurface(
  ctx: DispatchCtx,
  target: TargetState,
  generation: number,
  scriptName: string,
): void {
  const caps = pageIsolateCaps(ctx.env, ctx.browser.isolateCapOverrides);
  registerIsolateLimitListener(scriptName, (notice) =>
    handleIsolateLimitNotice(ctx, target, generation, caps, notice),
  );
}

function handleIsolateLimitNotice(
  ctx: DispatchCtx,
  target: TargetState,
  generation: number,
  caps: ReturnType<typeof pageIsolateCaps>,
  notice: IsolateLimitNotice,
): void {
  if (target.navigateGeneration !== generation) return;
  if (target.isolateLimitReportedGen === generation) return;
  target.isolateLimitReportedGen = generation;
  ctx.browser.dedicatedWorkers.terminateTarget(target.targetId, `page isolate ${notice.kind}`);
  queueIsolateLimitEvents(ctx, target, caps, notice);
}

function queueIsolateLimitEvents(
  ctx: DispatchCtx,
  target: TargetState,
  caps: ReturnType<typeof pageIsolateCaps>,
  notice: IsolateLimitNotice,
): void {
  const events = isolateLimitEvents(target, isolateLimitText(caps, notice));
  for (const event of events) ctx.browser.networkEvents.queueRaw(event);
  if (!notice.fromTail) ctx.browser.networkEvents.drain();
}

function isolateLimitText(
  caps: ReturnType<typeof pageIsolateCaps>,
  notice: IsolateLimitNotice,
): string {
  if (notice.kind === "gone") {
    return "Kitesurf: the page isolate was reclaimed by the platform and the page was terminated. Reload to continue.";
  }
  if (notice.kind === "crashed") {
    return `Kitesurf: the page's engine crashed (${notice.detail ?? "unknown trap"}) and the page was terminated. Reload to continue.`;
  }
  const capMs = notice.kind === "cpu" ? caps.cpuMs : notice.capMs;
  return `Kitesurf: page exceeded its ${isolateLimitDescription(notice.kind, capMs)} and was terminated.`;
}

function isolateLimitDescription(kind: IsolateLimitNotice["kind"], capMs: number): string {
  if (kind === "cpu") return `CPU time limit (${capMs} ms)`;
  if (kind === "wall") return `wall-clock time limit (${capMs} ms)`;
  return "memory limit";
}

function isolateLimitEvents(target: TargetState, text: string): CdpEvent[] {
  const events: CdpEvent[] = [];
  for (const sessionId of targetSessions(target, undefined)) {
    events.push(isolateLimitConsoleEvent(target, sessionId, text));
    events.push(isolateLimitTargetEvent(target, sessionId));
  }
  for (const sessionId of target.sessions) {
    events.push({ method: "Inspector.targetCrashed", params: {}, sessionId });
  }
  return events;
}

function isolateLimitConsoleEvent(
  target: TargetState,
  sessionId: string | undefined,
  text: string,
): CdpEvent {
  return {
    method: "Runtime.consoleAPICalled",
    params: {
      type: "error",
      args: [{ type: "string", value: text } as Protocol.Runtime.RemoteObject],
      executionContextId: target.defaultContextId || 1,
      timestamp: Date.now(),
      stackTrace: { callFrames: [] },
    },
    sessionId,
  };
}

function isolateLimitTargetEvent(target: TargetState, sessionId: string | undefined): CdpEvent {
  return {
    method: "Target.targetCrashed",
    params: { targetId: target.targetId, status: "crashed", errorCode: 1 },
    sessionId,
  };
}

function postMessageOriginAllowed(
  targetOrigin: string,
  senderOrigin: string,
  recipientOrigin: string,
): boolean {
  if (targetOrigin === "*") return true;
  if (targetOrigin === "/") return recipientOrigin === senderOrigin;
  return originOf(targetOrigin) === recipientOrigin;
}

function routePostMessageToChild(target: TargetState, params: ReceivedUpstreamParams): void {
  const ownerId = typeof params.toFrameOwnerId === "number" ? params.toFrameOwnerId : -1;
  if (ownerId <= 0) return;
  const frame = findPostMessageChild(target, ownerId);
  if (frame) routePostMessageToFrame(frame, params);
}

function findPostMessageChild(target: TargetState, ownerId: number): FrameState | undefined {
  for (const frame of target.frames.values()) {
    if (frame.ownerBackendNodeId === ownerId && frame.parentFrameId !== null) return frame;
  }
}

function routePostMessageToFrame(frame: FrameState, params: ReceivedUpstreamParams): void {
  const pageScript = frame.pageScript;
  if (!pageScript) {
    queuePostMessageForChild(frame, params);
    return;
  }
  deliverPostMessageToChild(pageScript, frame, params);
}

function deliverPostMessageToChild(
  pageScript: PageScriptStub,
  frame: FrameState,
  params: ReceivedUpstreamParams,
): void {
  const senderOrigin = String(params.sourceOrigin ?? "");
  const targetOrigin = String(params.targetOrigin ?? "*");
  if (!postMessageOriginAllowed(targetOrigin, senderOrigin, originOf(frame.url))) return;
  void pageScript
    .deliverMessage({
      dataJson: String(params.dataJson ?? "null"),
      origin: senderOrigin,
      fromParent: true,
    })
    .catch(() => {});
}

function queuePostMessageForChild(frame: FrameState, params: ReceivedUpstreamParams): void {
  if (frame.detached) return;
  const queue = (frame.pendingPostMessages ??= []);
  if (queue.length < MAX_PENDING_CHILD_POST_MESSAGES) queue.push(params);
}

function routePostMessageToParent(
  target: TargetState,
  fromFrameId: string,
  params: ReceivedUpstreamParams,
): void {
  const f = target.frames.get(fromFrameId);
  if (!f || f.detached) return;
  const senderOrigin = String(params.sourceOrigin ?? "");
  const recipient = postMessageParentRecipient(target, f);
  if (!recipient) return;
  deliverPostMessageToRecipient(recipient, f, senderOrigin, params);
}

function deliverPostMessageToRecipient(
  recipient: PostMessageRecipient,
  frame: FrameState,
  senderOrigin: string,
  params: ReceivedUpstreamParams,
): void {
  const targetOrigin = String(params.targetOrigin ?? "*");
  if (!postMessageOriginAllowed(targetOrigin, senderOrigin, recipient.origin)) return;
  void recipient.pageScript
    .deliverMessage({
      dataJson: String(params.dataJson ?? "null"),
      origin: senderOrigin,
      sourceFrameOwnerId: frame.ownerBackendNodeId,
    })
    .catch(() => {});
}

interface PostMessageRecipient {
  pageScript: PageScriptStub;
  origin: string;
}

function postMessageParentRecipient(
  target: TargetState,
  frame: FrameState,
): PostMessageRecipient | null {
  if (isMainFrameParent(target, frame)) return pageScriptRecipient(target.pageScript, target.url);
  return parentFrameRecipient(target, frame.parentFrameId);
}

function isMainFrameParent(target: TargetState, frame: FrameState): boolean {
  return !frame.parentFrameId || frame.parentFrameId === target.frameId;
}

function parentFrameRecipient(
  target: TargetState,
  parentFrameId: string | null,
): PostMessageRecipient | null {
  if (!parentFrameId) return null;
  const parent = target.frames.get(parentFrameId);
  if (!parent) return null;
  return pageScriptRecipient(parent.pageScript, parent.url);
}

function pageScriptRecipient(
  pageScript: PageScriptStub | null,
  url: string,
): PostMessageRecipient | null {
  if (!pageScript) return null;
  return { pageScript, origin: originOf(url) };
}

function handleUpstreamFrameEvent(
  ctx: DispatchCtx,
  target: TargetState,
  sessionId: string | undefined,
  event: UpstreamEventName,
  params: ReceivedUpstreamParams,
): void {
  if (handleBindingCalledEvent(ctx, target, sessionId, event, params)) return;
  if (handleChildPostMessageEvent(target, event, params)) return;
  if (handleNavigationAndToolsEvents(ctx, target, sessionId, event, params)) return;
  handleFrameUpstreamEvent(ctx, target, sessionId, event, params);
}

function handleNavigationAndToolsEvents(
  ctx: DispatchCtx,
  target: TargetState,
  sessionId: string | undefined,
  event: UpstreamEventName,
  params: ReceivedUpstreamParams,
): boolean {
  if (handleFormSubmitNavigationEvent(ctx, target, sessionId, event, params)) return true;
  if (handleModelContextToolsEvent(ctx, target, event, params)) return true;
  return handleDocumentNavigationEvent(ctx, target, sessionId, event, params);
}

function handleBindingCalledEvent(
  ctx: DispatchCtx,
  target: TargetState,
  sessionId: string | undefined,
  event: UpstreamEventName,
  params: ReceivedUpstreamParams,
): boolean {
  if (event !== "kitesurf.bindingCalled") return false;
  const binding = pendingBindingEvent(ctx, params);
  if (!binding) return true;
  emitBindingCalled(ctx, target, sessionId, binding);
  return true;
}

interface PendingBindingEvent {
  name: string;
  payload: string;
}

function pendingBindingEvent(
  ctx: DispatchCtx,
  params: ReceivedUpstreamParams,
): PendingBindingEvent | null {
  const name = readStringValue(params.name);
  if (!name || !ctx.browser.pendingBindings.has(name)) return null;
  return { name, payload: readStringValue(params.payload) };
}

function emitBindingCalled(
  ctx: DispatchCtx,
  target: TargetState,
  sessionId: string | undefined,
  binding: PendingBindingEvent,
): void {
  for (const targetSessionId of targetSessions(target, sessionId)) {
    ctx.emit({
      method: "Runtime.bindingCalled",
      params: {
        name: binding.name,
        payload: binding.payload,
        executionContextId: target.defaultContextId || 1,
      },
      sessionId: targetSessionId,
    });
  }
}

function readStringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readStringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function handleChildPostMessageEvent(
  target: TargetState,
  event: UpstreamEventName,
  params: ReceivedUpstreamParams,
): boolean {
  if (event !== "kitesurf.postMessage") return false;
  routePostMessageToChild(target, params);
  return true;
}

function handleFormSubmitNavigationEvent(
  ctx: DispatchCtx,
  target: TargetState,
  sessionId: string | undefined,
  event: UpstreamEventName,
  params: ReceivedUpstreamParams,
): boolean {
  if (event !== "kitesurf.formSubmitNavigate") return false;
  const navigation = formSubmitNavigation(params);
  if (navigation) startFormSubmitNavigation(ctx, target, sessionId, navigation);
  return true;
}

interface FormSubmitNavigation {
  url: string;
  postData: string | null;
  contentType: string;
}

function formSubmitNavigation(params: ReceivedUpstreamParams): FormSubmitNavigation | null {
  const url = readStringValue(params.url);
  if (!url) return null;
  return {
    url,
    postData: typeof params.postData === "string" ? params.postData : null,
    contentType: readStringOr(params.postContentType, "application/x-www-form-urlencoded"),
  };
}

function startFormSubmitNavigation(
  ctx: DispatchCtx,
  target: TargetState,
  sessionId: string | undefined,
  navigation: FormSubmitNavigation,
): void {
  void dispatchInternalPageNavigate(
    ctx,
    target,
    sessionId,
    navigation.url,
    navigation.postData,
    navigation.contentType,
  ).catch(warnFormSubmitNavigateFailure);
}

function warnFormSubmitNavigateFailure(error: unknown): void {
  console.warn(
    "kitesurf: form-submit Page.navigate failed:",
    error instanceof Error ? error.message : String(error),
  );
}

function dispatchInternalPageNavigate(
  ctx: DispatchCtx,
  target: TargetState,
  sessionId: string | undefined,
  url: string,
  postData: string | null,
  postContentType: string,
): Promise<void> {
  return import("./dispatch.ts").then(async ({ dispatch }) => {
    const params: Protocol.Page.NavigateRequest = { url, _kitesurfInternal: true };
    if (postData !== null) {
      params._kitesurfPostData = postData;
      params._kitesurfPostContentType = postContentType;
    }
    await dispatch(ctx, {
      id: -1,
      method: "Page.navigate",
      params,
      sessionId: targetSessionsNetwork(target, sessionId)[0],
    });
  });
}

function handleModelContextToolsEvent(
  ctx: DispatchCtx,
  target: TargetState,
  event: UpstreamEventName,
  params: ReceivedUpstreamParams,
): boolean {
  if (event === "kitesurf.modelContextToolsAdded") {
    if (Array.isArray(params.tools)) {
      emitToolsAdded(ctx, target, params.tools as Parameters<typeof emitToolsAdded>[2]);
    }
    return true;
  }
  if (event === "kitesurf.modelContextToolsRemoved") {
    if (Array.isArray(params.names)) {
      emitToolsRemoved(ctx, target, params.names as string[]);
    }
    return true;
  }
  return false;
}

interface DocumentNavigationEvent {
  url: string;
  navigationType: "fragment" | "historyApi" | "other";
  kind: string;
  previousUrl: string;
}

function handleDocumentNavigationEvent(
  ctx: DispatchCtx,
  target: TargetState,
  sessionId: string | undefined,
  event: UpstreamEventName,
  params: ReceivedUpstreamParams,
): boolean {
  if (event !== "kitesurf.navigatedWithinDocument") return false;
  const navigation = parseDocumentNavigation(params);
  if (!navigation) return true;
  if (shouldSuppressAutoReload(target, navigation)) return true;
  if (shouldRefetchDocumentNavigation(target, navigation)) {
    void dispatchInternalPageNavigate(ctx, target, sessionId, navigation.url, null, "").catch(
      (error: unknown) => warnEscalatedNavigationFailure(navigation.kind, error),
    );
    return true;
  }
  updateDocumentNavigationHistory(target, navigation);
  emitDocumentNavigation(ctx, target, sessionId, navigation);
  return true;
}

function parseDocumentNavigation(params: ReceivedUpstreamParams): DocumentNavigationEvent | null {
  const url = readStringValue(params.url);
  if (!url) return null;
  return {
    url,
    navigationType: normalizedDocumentNavigationType(readStringValue(params.navigationType)),
    kind: readStringValue(params.kind),
    previousUrl: readStringValue(params.previousUrl),
  };
}

function normalizedDocumentNavigationType(
  value: string,
): DocumentNavigationEvent["navigationType"] {
  if (value === "fragment" || value === "historyApi") return value;
  return "other";
}

function shouldSuppressAutoReload(
  target: TargetState,
  navigation: DocumentNavigationEvent,
): boolean {
  if (navigation.kind !== "navigate") return false;
  updateAutoReloadCounter(target, navigation.url);
  if (target.autoReloadCount <= MAX_CONSECUTIVE_AUTO_RELOADS) return false;
  console.warn(
    `kitesurf: suppressing self-reload #${target.autoReloadCount} to ` +
      `${navigation.url}; ${MAX_CONSECUTIVE_AUTO_RELOADS} consecutive reloads ` +
      `fired within ${AUTO_RELOAD_SETTLED_MS}ms of load — reload loop`,
  );
  return true;
}

function updateAutoReloadCounter(target: TargetState, url: string): void {
  const settled = target.lastLoadAt > 0 && Date.now() - target.lastLoadAt > AUTO_RELOAD_SETTLED_MS;
  const consecutive = target.autoReloadUrl === url && !settled;
  target.autoReloadCount = consecutive ? target.autoReloadCount + 1 : 1;
  target.autoReloadUrl = url;
}

function shouldRefetchDocumentNavigation(
  target: TargetState,
  navigation: DocumentNavigationEvent,
): boolean {
  if (navigation.kind === "navigate") return true;
  return shouldRefetchHistoryApiNavigation(target, navigation);
}

function shouldRefetchHistoryApiNavigation(
  target: TargetState,
  navigation: DocumentNavigationEvent,
): boolean {
  if (!target.refetchOnPushState) return false;
  if (navigation.kind !== "pushState" && navigation.kind !== "replaceState") return false;
  if (!navigation.previousUrl) return false;
  return isSameOriginPathChange(navigation.previousUrl, navigation.url);
}

function warnEscalatedNavigationFailure(kind: string, error: unknown): void {
  console.warn(
    `kitesurf: escalated ${kind} Page.navigate failed:`,
    error instanceof Error ? error.message : String(error),
  );
}

function updateDocumentNavigationHistory(
  target: TargetState,
  navigation: DocumentNavigationEvent,
): void {
  target.url = navigation.url;
  if (navigation.kind === "replaceState") {
    const live = target.navigationHistory[target.navigationHistoryIndex];
    if (live) {
      live.url = navigation.url;
      live.userTypedURL = navigation.url;
    }
  } else if (navigation.kind === "hash" || navigation.kind === "pushState") {
    recordNavigationHistory(target, navigation.url, "link");
  }
}

function emitDocumentNavigation(
  ctx: DispatchCtx,
  target: TargetState,
  sessionId: string | undefined,
  navigation: DocumentNavigationEvent,
): void {
  const sessions = targetSessions(target, sessionId);
  for (const targetSessionId of sessions) {
    ctx.emit({
      method: "Page.navigatedWithinDocument",
      params: {
        frameId: target.frameId,
        url: navigation.url,
        navigationType: navigation.navigationType,
      },
      sessionId: targetSessionId,
    });
  }
}

function handleFrameUpstreamEvent(
  ctx: DispatchCtx,
  target: TargetState,
  sessionId: string | undefined,
  event: UpstreamEventName,
  params: ReceivedUpstreamParams,
): void {
  const frameId = typeof params.frameId === "string" ? params.frameId : null;
  if (!frameId) return;
  if (handleUpstreamFrameAttachedEvent(ctx, target, sessionId, event, frameId, params)) return;
  handleExistingUpstreamFrameEvent(ctx, target, sessionId, event, frameId, params);
}

function handleUpstreamFrameAttachedEvent(
  ctx: DispatchCtx,
  target: TargetState,
  sessionId: string | undefined,
  event: UpstreamEventName,
  frameId: string,
  params: ReceivedUpstreamParams,
): boolean {
  if (event !== "kitesurf.frameAttached") return false;
  attachUpstreamFrame(ctx, target, sessionId, frameId, params);
  return true;
}

function handleExistingUpstreamFrameEvent(
  ctx: DispatchCtx,
  target: TargetState,
  sessionId: string | undefined,
  event: UpstreamEventName,
  frameId: string,
  params: ReceivedUpstreamParams,
): void {
  const frame = target.frames.get(frameId);
  if (!frame) return;
  if (!isFrameEventAllowed(frame, event)) return;
  if (event === "kitesurf.frameNavigated") {
    navigateUpstreamFrame(ctx, target, frame, sessionId, params);
    return;
  }
  if (handleFrameLifecycleEvent(ctx, target, frame, sessionId, event, params)) return;
  console.warn(`[kitesurf-iframe] unknown upstream event: ${event}`);
}

function isFrameEventAllowed(frame: FrameState, event: UpstreamEventName): boolean {
  return !frame.detached || event === "kitesurf.frameNavigated";
}

function attachUpstreamFrame(
  ctx: DispatchCtx,
  target: TargetState,
  sessionId: string | undefined,
  frameId: string,
  params: ReceivedUpstreamParams,
): void {
  if (target.frames.has(frameId)) return;
  const frame = createAttachedUpstreamFrame(target, frameId, params);
  target.frames.set(frameId, frame);
  emitUpstreamFrameAttached(ctx, target, sessionId, frame);
}

function createAttachedUpstreamFrame(
  target: TargetState,
  frameId: string,
  params: ReceivedUpstreamParams,
): FrameState {
  const url = upstreamFrameUrl(params);
  return makeChildFrameState({
    frameId,
    parentFrameId: target.frameId,
    loaderId: mintLoaderId(),
    url,
    ownerBackendNodeId: upstreamFrameOwnerId(params),
    isCrossOrigin: url !== "about:blank" && originOf(url) !== originOf(target.url),
    delaysLoadEvent: iframeDelaysLoadEvent(readStringOrNull(params.loading)),
  });
}

function upstreamFrameUrl(params: ReceivedUpstreamParams): string {
  const url = readStringValue(params.url);
  return url || "about:blank";
}

function upstreamFrameOwnerId(params: ReceivedUpstreamParams): number {
  return typeof params.ownerBackendNodeId === "number" ? params.ownerBackendNodeId : -1;
}

function readStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function emitUpstreamFrameAttached(
  ctx: DispatchCtx,
  target: TargetState,
  sessionId: string | undefined,
  frame: FrameState,
): void {
  const sessions = targetSessions(target, sessionId);
  emitFrameAttached(ctx, sessions, frame, target.frameId);
  emitFrameTarget(ctx, frame);
  emitFrameStartedLoading(ctx, target, frame, sessionId);
  emitFrameNavigated(ctx, target, frame, sessionId);
  emitUpstreamFrameInitLifecycle(ctx, sessions, frame);
}

function emitFrameAttached(
  ctx: DispatchCtx,
  sessions: ReadonlyArray<string | undefined>,
  frame: FrameState,
  parentFrameId: string,
): void {
  for (const targetSessionId of sessions) {
    ctx.emit({
      method: "Page.frameAttached",
      params: { frameId: frame.frameId, parentFrameId },
      sessionId: targetSessionId,
    });
  }
}

function emitUpstreamFrameInitLifecycle(
  ctx: DispatchCtx,
  sessions: ReadonlyArray<string | undefined>,
  frame: FrameState,
): void {
  const timestamp = Date.now() / MILLISECONDS_PER_SECOND;
  const params: Protocol.Page.LifecycleEventEvent = {
    frameId: frame.frameId,
    loaderId: frame.loaderId,
    name: "init",
    timestamp,
  };
  emitLifecycleEvent(ctx, sessions, params);
}

function navigateUpstreamFrame(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
  sessionId: string | undefined,
  params: ReceivedUpstreamParams,
): void {
  const revived = reviveUpstreamFrame(frame);
  const urlChanged = updateUpstreamFrameUrl(target, frame, params);
  emitFrameNavigated(ctx, target, frame, sessionId);
  if (urlChanged && !revived) teardownOopifStubForFrame(target, frame, "iframe src changed", ctx);
  emitFrameTargetIfNavigationChanged(ctx, frame, urlChanged, revived);
  maybeStartUpstreamFrameOopif(ctx, target, frame);
}

function reviveUpstreamFrame(frame: FrameState): boolean {
  if (!frame.detached) return false;
  frame.detached = false;
  frame.lifecycle = "init";
  return true;
}

function updateUpstreamFrameUrl(
  target: TargetState,
  frame: FrameState,
  params: ReceivedUpstreamParams,
): boolean {
  const url = typeof params.url === "string" && params.url ? params.url : frame.url;
  if (url === frame.url) return false;
  frame.url = url;
  frame.securityOrigin = originOf(url);
  frame.isCrossOrigin = !matchesAboutBlank(url) && originOf(url) !== originOf(target.url);
  return true;
}

function emitFrameTargetIfNavigationChanged(
  ctx: DispatchCtx,
  frame: FrameState,
  urlChanged: boolean,
  revived: boolean,
): void {
  if (urlChanged || revived) emitFrameTarget(ctx, frame);
}

function maybeStartUpstreamFrameOopif(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
): void {
  if (frame.pageScript || frame.oopifSpawning || !needsOopifChild(frame)) return;
  ctx.ctx.waitUntil(spawnOopifPipeline(ctx, target, frame).catch(() => {}));
}

function handleFrameLifecycleEvent(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
  sessionId: string | undefined,
  event: UpstreamEventName,
  params: ReceivedUpstreamParams,
): boolean {
  if (event === "kitesurf.frameLifecycle") {
    emitUpstreamFrameLifecycle(ctx, target, frame, sessionId, params);
    return true;
  }
  if (event === "kitesurf.frameStoppedLoading") {
    emitUpstreamFrameStoppedLoading(ctx, target, frame, sessionId);
    return true;
  }
  if (event === "kitesurf.frameDetached") {
    detachUpstreamFrame(ctx, target, frame, sessionId);
    return true;
  }
  return false;
}

function emitUpstreamFrameLifecycle(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
  sessionId: string | undefined,
  params: ReceivedUpstreamParams,
): void {
  const name = frameLifecycleName(params.name);
  if (!name) return;
  const sessions = targetSessions(target, sessionId);
  const lifecycle: Protocol.Page.LifecycleEventEvent = {
    frameId: frame.frameId,
    loaderId: frame.loaderId,
    name,
    timestamp: Date.now() / MILLISECONDS_PER_SECOND,
  };
  emitLifecycleEvent(ctx, sessions, lifecycle);
  frame.lifecycle = frameLifecycleState(name);
  if (name === "load") emitFrameStoppedLoading(ctx, sessions, frame.frameId);
}

function frameLifecycleName(value: unknown): "DOMContentLoaded" | "load" | null {
  if (value === "DOMContentLoaded" || value === "load") return value;
  return null;
}

function frameLifecycleState(name: "DOMContentLoaded" | "load"): "dcl" | "load" {
  return name === "DOMContentLoaded" ? "dcl" : "load";
}

function emitUpstreamFrameStoppedLoading(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
  sessionId: string | undefined,
): void {
  if (frame.lifecycle === "load") return;
  emitFrameStoppedLoading(ctx, targetSessions(target, sessionId), frame.frameId);
}

function detachUpstreamFrame(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
  sessionId: string | undefined,
): void {
  frame.detached = true;
  teardownOopifStubForFrame(target, frame, "iframe removed from DOM", ctx);
  releaseFrameDom(frame);
  emitUpstreamFrameDetached(ctx, targetSessions(target, sessionId), frame.frameId);
}

function emitUpstreamFrameDetached(
  ctx: DispatchCtx,
  sessions: ReadonlyArray<string | undefined>,
  frameId: string,
): void {
  for (const targetSessionId of sessions) {
    ctx.emit({
      method: "Page.frameDetached",
      params: { frameId, reason: "remove" },
      sessionId: targetSessionId,
    });
  }
}

function emitChildFrameDclLoad(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
  sessionId: string | undefined,
): void {
  if (!shouldEmitChildFrameLoad(frame)) return;
  const sessions = targetSessions(target, sessionId);
  const ts = Date.now() / MILLISECONDS_PER_SECOND;
  emitChildLifecycleEvents(ctx, frame, sessions, ts);
  emitFrameStoppedLoading(ctx, sessions, frame.frameId);
  frame.lifecycle = "load";
}

function shouldEmitChildFrameLoad(frame: FrameState): boolean {
  return frame.parentFrameId !== null && frame.lifecycle !== "load";
}

function emitChildLifecycleEvents(
  ctx: DispatchCtx,
  frame: FrameState,
  sessions: ReadonlyArray<string | undefined>,
  timestamp: number,
): void {
  emitChildLifecycleEvent(ctx, frame, sessions, timestamp, "DOMContentLoaded");
  emitChildLifecycleEvent(ctx, frame, sessions, timestamp, "load");
}

function emitChildLifecycleEvent(
  ctx: DispatchCtx,
  frame: FrameState,
  sessions: ReadonlyArray<string | undefined>,
  timestamp: number,
  name: "DOMContentLoaded" | "load",
): void {
  const params: Protocol.Page.LifecycleEventEvent = {
    frameId: frame.frameId,
    loaderId: frame.loaderId,
    name,
    timestamp,
  };
  emitLifecycleEvent(ctx, sessions, params);
}

type ChildFrameFetchHop = Parameters<Parameters<typeof walkRedirects>[0]["fetchHop"]>[0];
type ChildFrameHopFetcher = (request: ChildFrameFetchHop) => Promise<Response>;
type SuccessfulChildFrameWalk = Extract<Awaited<ReturnType<typeof walkRedirects>>, { ok: true }>;

interface ChildFrameDocumentResponse {
  response: Response;
  contentType: string;
}

async function loadChildFrame(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
  sessionId: string | undefined,
  depth: number = 1,
  ancestorUrls: ReadonlySet<string> = new Set(),
): Promise<void> {
  const entryUrl = frame.url;
  const fetched = await fetchChildFrameDocument(ctx, target, frame, sessionId);
  if (!fetched) return;
  if (!(await readAndParseChildFrame(target, frame, fetched))) return;
  await loadChildFrameGrandchildren(ctx, target, frame, sessionId, depth, ancestorUrls, entryUrl);
  frame.readyState = "complete";
}

async function readAndParseChildFrame(
  target: TargetState,
  frame: FrameState,
  fetched: ChildFrameDocumentResponse,
): Promise<boolean> {
  const html = await readChildFrameHtml(frame, fetched.response, fetched.contentType);
  if (html === null) return false;
  if (!isCurrentChildFrame(target, frame)) {
    frame.readyState = "complete";
    return false;
  }
  parseChildFrameHtml(frame, html);
  return true;
}

async function fetchChildFrameDocument(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
  sessionId: string | undefined,
): Promise<ChildFrameDocumentResponse | null> {
  const outbound = childFrameDocumentOutbound(ctx, target, frame);
  const walk = await walkChildFrameRedirects(frame, (request) => outbound.fetch(request));
  if (!walk) return null;
  const { response, finalUrl } = walk;
  if (!response.ok) {
    console.warn(`[kitesurf-iframe] fetch ${response.status} for ${frame.url}`);
    frame.readyState = "complete";
    return null;
  }
  if (await updateChildFrameRedirect(ctx, target, frame, sessionId, response, finalUrl))
    return null;
  const contentType = response.headers.get("content-type") ?? "";
  updateChildFrameResponseMetadata(frame, response, contentType);
  return { response, contentType };
}

function childFrameDocumentOutbound(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
): ReturnType<DispatchCtx["browser"]["sandboxOutbound"]["parent"]> {
  const docPageOrigin = originOf(frame.url);
  const embedder = childFrameEmbedder(target, frame);
  // Child requests inherit the embedding document's URL and referrer policy.
  const childDocProps: Omit<OutboundProps, "externalOutbound"> = {
    pageOrigin: docPageOrigin,
    // The embedder's URL and policy give the Referer a browser sends;
    // page-script reports the same value as the frame's document.referrer.
    pageUrl: childFramePageUrl(embedder, target),
    referrerPolicy: childFrameReferrerPolicy(embedder, target) ?? undefined,
    mainFrameId: frame.frameId,
    mainLoaderId: frame.loaderId,
    allowDocumentBypass: true,
    walksOwnRedirects: true,
  };
  return ctx.browser.sandboxOutbound.parent(childDocProps);
}

function childFrameEmbedder(target: TargetState, frame: FrameState): FrameState | undefined {
  return frame.parentFrameId && frame.parentFrameId !== target.frameId
    ? target.frames.get(frame.parentFrameId)
    : undefined;
}

function childFramePageUrl(embedder: FrameState | undefined, target: TargetState): string {
  return embedder ? embedder.url : target.url;
}

function childFrameReferrerPolicy(
  embedder: FrameState | undefined,
  target: TargetState,
): string | null | undefined {
  return embedder ? embedder.referrerPolicy : target.docReferrerPolicy;
}

async function walkChildFrameRedirects(
  frame: FrameState,
  fetchHop: ChildFrameHopFetcher,
): Promise<SuccessfulChildFrameWalk | null> {
  const walkAbort = new AbortController();
  const walkTimer = setTimeout(
    () => walkAbort.abort(new Error("kitesurf: iframe document walk timeout")),
    IFRAME_DOC_WALK_BUDGET_MS,
  );
  try {
    const walk = await walkRedirects({
      url: frame.url,
      signal: walkAbort.signal,
      fetchHop,
      headers: {
        "x-kitesurf-allow-cross-origin": "1",
        "x-kitesurf-resource-type": "Document",
        "x-kitesurf-frame-id": frame.frameId,
        "x-kitesurf-initiator": "parser",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "sec-fetch-dest": "iframe",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "same-origin",
      },
    });
    if (walk.ok) return walk;
    console.warn(`[kitesurf-iframe] too many redirects for ${frame.url}`);
    frame.readyState = "complete";
    return null;
  } catch (err) {
    console.warn(
      `[kitesurf-iframe] fetch failed for ${frame.url}:`,
      err instanceof Error ? err.message : String(err),
    );
    frame.readyState = "complete";
    return null;
  } finally {
    clearTimeout(walkTimer);
  }
}

async function updateChildFrameRedirect(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
  sessionId: string | undefined,
  response: Response,
  finalUrl: string,
): Promise<boolean> {
  if (finalUrl === frame.url) return false;
  frame.url = finalUrl;
  frame.securityOrigin = originOf(finalUrl);
  frame.isCrossOrigin = originOf(finalUrl) !== originOf(target.url);
  if (!frame.isCrossOrigin) return false;
  try {
    await response.body?.cancel();
  } catch {}
  frame.readyState = "complete";
  emitFrameNavigated(ctx, target, frame, sessionId);
  return true;
}

function updateChildFrameResponseMetadata(
  frame: FrameState,
  response: Response,
  contentType: string,
): void {
  const mimeType = contentType.split(";")[0]?.trim();
  if (mimeType) frame.mimeType = mimeType;
  // Read before the grandchildren below are discovered and fetched.
  frame.referrerPolicy = response.headers.get("referrer-policy");
}

async function readChildFrameHtml(
  frame: FrameState,
  response: Response,
  contentType: string,
): Promise<string | null> {
  try {
    const read = await readCappedBytes(response, MAX_DOCUMENT_BYTES);
    if (!read.ok) {
      console.warn(`[kitesurf-iframe] body read refused (${read.failure}) for ${frame.url}`);
      frame.readyState = "complete";
      return null;
    }
    return decodeHtmlBytes(read.bytes, contentType).html;
  } catch (err) {
    console.warn(
      `[kitesurf-iframe] body read failed for ${frame.url}:`,
      err instanceof Error ? err.message : String(err),
    );
    frame.readyState = "complete";
    return null;
  }
}

function isCurrentChildFrame(target: TargetState, frame: FrameState): boolean {
  return !frame.detached && target.frames.get(frame.frameId) === frame;
}

function parseChildFrameHtml(frame: FrameState, html: string): void {
  const strip = stripIframeScripts(html, frame.url);
  const parsedHtml = normalizeChildFrameHtml(frame, strip.html);
  try {
    frame.dom = createDom(parsedHtml, frame.url);
    frame.readyState = "interactive";
    frame.hasScript = strip.count > 0;
  } catch (err) {
    console.warn(
      `[kitesurf-iframe] parse failed for ${frame.url}:`,
      err instanceof Error ? err.message : String(err),
    );
    frame.dom = null;
    frame.hasScript = true;
  }
}

const XML_CHILD_FRAME_MIME_TYPES = new Set([
  "text/xml",
  "application/xml",
  "application/xhtml+xml",
  "image/svg+xml",
]);

function normalizeChildFrameHtml(frame: FrameState, html: string): string {
  if (!frame.mimeType || !XML_CHILD_FRAME_MIME_TYPES.has(frame.mimeType.toLowerCase())) return html;
  return html.replace(/\s+$/, "");
}

async function loadChildFrameGrandchildren(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
  sessionId: string | undefined,
  depth: number,
  ancestorUrls: ReadonlySet<string>,
  entryUrl: string,
): Promise<void> {
  const dom = frame.dom;
  if (!dom || depth >= MAX_IFRAME_DEPTH) return;
  const nextAncestors = childFrameAncestorUrls(ancestorUrls, frame.url, entryUrl);
  const grandchildren = discoverChildFramesFor(target, frame, dom);
  if (grandchildren.length === 0) {
    warnChildFrameDepthLimit(frame, dom, depth);
    return;
  }
  const attachable = grandchildren.filter(
    (child) => child.parentFrameId !== null && child.lifecycle === "init",
  );
  emitChildFrameAttachAndStart(ctx, attachable, targetSessions(target, sessionId));
  await loadChildFrameGrandchildrenTogether(
    ctx,
    target,
    grandchildren,
    sessionId,
    depth + 1,
    nextAncestors,
  );
}

function childFrameAncestorUrls(
  ancestorUrls: ReadonlySet<string>,
  frameUrl: string,
  entryUrl: string,
): Set<string> {
  const nextAncestors = new Set(ancestorUrls);
  nextAncestors.add(frameUrl);
  nextAncestors.add(entryUrl);
  return nextAncestors;
}

function warnChildFrameDepthLimit(frame: FrameState, dom: DomHandle, depth: number): void {
  if (depth + 1 < MAX_IFRAME_DEPTH || findIframes(dom).length === 0) return;
  console.warn(
    `[kitesurf-iframe] MAX_IFRAME_DEPTH=${MAX_IFRAME_DEPTH} reached at ${frame.url}; nested iframes not discovered`,
  );
}

async function loadChildFrameGrandchildrenTogether(
  ctx: DispatchCtx,
  target: TargetState,
  grandchildren: FrameState[],
  sessionId: string | undefined,
  depth: number,
  ancestorUrls: ReadonlySet<string>,
): Promise<void> {
  const waits: Promise<void>[] = [];
  for (const child of grandchildren) {
    if (shouldSkipChildFrameLoad(child, ancestorUrls)) {
      child.readyState = "complete";
      child.pendingLoad = Promise.resolve();
      continue;
    }
    const pending = loadChildFrame(ctx, target, child, sessionId, depth, ancestorUrls);
    child.pendingLoad = pending;
    waits.push(pending);
  }
  if (waits.length > 0) await Promise.all(waits);
}

function shouldSkipChildFrameLoad(child: FrameState, ancestorUrls: ReadonlySet<string>): boolean {
  const cycled = ancestorUrls.has(child.url);
  if (cycled) console.warn(`[kitesurf-iframe] cycle detected, skipping fetch for ${child.url}`);
  return child.isCrossOrigin || child.url === "about:blank" || child.url === "" || cycled;
}

function stripIframeScripts(html: string, url: string): { html: string; count: number } {
  let count = 0;
  const stripped = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, () => {
    count++;
    return "";
  });
  if (count > 0) {
    console.warn(
      `[kitesurf-iframe] stripped ${count} <script> tag(s) from ${url} ` +
        `(parent-side contentDocument stays script-free; OOPIF handles frame scripts)`,
    );
  }
  return { html: stripped, count };
}

function findBaseHref(dom: DomHandle): string | null {
  const ids = queryNodeIds(dom, "base[href]");
  if (!ids) return null;
  for (const id of ids) {
    const href = baseHrefForNode(dom, id);
    if (href) return href;
  }
  return null;
}

function baseHrefForNode(dom: DomHandle, nodeId: number): string | null {
  if (nodeId < 0) return null;
  return readAttr(safeNodeInfo(dom, nodeId)?.attributes, "href");
}

function safeNodeInfo(dom: DomHandle, id: number): ParsedNodeInfo | null {
  try {
    return dom.nodeInfo(id) as ParsedNodeInfo;
  } catch {
    return null;
  }
}

function resolveBaseUrl(dom: DomHandle, pageUrl: string): string {
  const base = findBaseHref(dom);
  if (base) {
    try {
      return new URL(base, pageUrl).toString();
    } catch {}
  }
  return pageUrl;
}

interface InlineStylesheetTask {
  nodeId: number;
  href: string;
  resolved: string;
  css?: string;
}

type InlineStylesheetOutbound = ReturnType<SandboxOutboundOverride["parent"]>;

interface InlineStylesheetContext {
  dom: DomHandle;
  pageUrl: string;
  pageOrigin: string;
  outbound: InlineStylesheetOutbound;
  cache?: Map<string, { css: string; fetchedAt: number }>;
  tracker?: NetworkEventTracker;
  loaderId?: string;
  frameId?: string;
}

async function inlineStylesheets(
  dom: DomHandle,
  pageUrl: string,
  sandboxOutbound: SandboxOutboundOverride,
  cache?: Map<string, { css: string; fetchedAt: number }>,
  tracker?: NetworkEventTracker,
  loaderId?: string,
  frameId?: string,
): Promise<void> {
  const links = findStylesheetLinks(dom);
  if (links.length === 0) return;
  const baseUrl = resolveBaseUrl(dom, pageUrl);
  const pageOrigin = stylesheetPageOrigin(pageUrl);
  const context: InlineStylesheetContext = {
    dom,
    pageUrl,
    pageOrigin,
    outbound: sandboxOutbound.parent({
      pageOrigin,
      mainFrameId: frameId ?? "",
      mainLoaderId: loaderId ?? "",
    }),
    cache,
    tracker,
    loaderId,
    frameId,
  };
  const tasks = resolveInlineStylesheetTasks(links, baseUrl);
  if (tasks.length === 0) return;
  const fetchedAt = Date.now();
  const fetchTasks = useCachedStylesheets(context, tasks, fetchedAt);
  await Promise.all(fetchTasks.map((task) => fetchStylesheetTask(context, task, fetchedAt)));
  applyInlineStylesheetTasks(dom, tasks);
}

function stylesheetPageOrigin(pageUrl: string): string {
  try {
    return new URL(pageUrl).origin;
  } catch {
    return "";
  }
}

function resolveInlineStylesheetTasks(
  links: Array<{ nodeId: number; href: string }>,
  baseUrl: string,
): InlineStylesheetTask[] {
  const tasks: InlineStylesheetTask[] = [];
  for (const { nodeId, href } of links) {
    try {
      tasks.push({ nodeId, href, resolved: new URL(href, baseUrl).toString() });
    } catch {
      continue;
    }
  }
  return tasks;
}

function useCachedStylesheets(
  context: InlineStylesheetContext,
  tasks: InlineStylesheetTask[],
  now: number,
): InlineStylesheetTask[] {
  const fetchTasks: InlineStylesheetTask[] = [];
  for (const task of tasks) {
    const hit = context.cache?.get(task.resolved);
    if (hit && now - hit.fetchedAt < STYLE_CACHE_TTL_MS) {
      task.css = hit.css;
      recordCachedStylesheet(context, task, hit.css);
    } else {
      fetchTasks.push(task);
    }
  }
  return fetchTasks;
}

function recordCachedStylesheet(
  context: InlineStylesheetContext,
  task: InlineStylesheetTask,
  css: string,
): void {
  const reqId = beginStylesheetRequest(context, task, { accept: "text/css,*/*;q=0.1" });
  if (reqId === null || !context.tracker) return;
  context.tracker.completeRequest(reqId, {
    url: task.resolved,
    status: 200,
    statusText: "OK",
    headers: { "content-type": "text/css" },
    mimeType: "text/css",
    bodyLength: css.length,
    body: css,
    bodyBase64Encoded: false,
    fromDiskCache: true,
  });
}

function beginStylesheetRequest(
  context: InlineStylesheetContext,
  task: InlineStylesheetTask,
  headers: Record<string, string>,
): string | null {
  const { tracker, loaderId, frameId } = context;
  if (!tracker || !loaderId || !frameId) return null;
  return tracker.beginRequest({
    url: task.resolved,
    method: "GET",
    headers,
    type: "Stylesheet",
    initiator: { type: "parser", url: context.pageUrl },
    loaderId,
    frameId,
  });
}

async function fetchStylesheetTask(
  context: InlineStylesheetContext,
  task: InlineStylesheetTask,
  fetchedAt: number,
): Promise<void> {
  const headers = stylesheetRequestHeaders(context.pageOrigin);
  const reqId = beginStylesheetRequest(context, task, headers);
  try {
    const walk = await walkRedirects({
      url: task.resolved,
      headers,
      signal: AbortSignal.timeout(SHEET_WALK_BUDGET_MS),
      fetchHop: (hopReq) => context.outbound.fetch(hopReq),
    });
    if (!walk.ok) {
      failStylesheetRequest(context, reqId, "net::ERR_TOO_MANY_REDIRECTS");
      return;
    }
    await completeStylesheetFetch(context, task, reqId, walk.response, fetchedAt);
  } catch (err) {
    failStylesheetRequest(context, reqId, err instanceof Error ? err.message : String(err));
  }
}

function stylesheetRequestHeaders(pageOrigin: string): Record<string, string> {
  return {
    accept: "text/css,*/*;q=0.1",
    "x-kitesurf-page-origin": pageOrigin,
    "user-agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  };
}

function failStylesheetRequest(
  context: InlineStylesheetContext,
  reqId: string | null,
  error: string,
): void {
  if (reqId === null || !context.tracker) return;
  context.tracker.failRequest(reqId, error);
}

async function completeStylesheetFetch(
  context: InlineStylesheetContext,
  task: InlineStylesheetTask,
  reqId: string | null,
  response: Response,
  fetchedAt: number,
): Promise<void> {
  if (response.status >= 200 && response.status < 300) {
    await readStylesheetResponse(context, task, reqId, response, fetchedAt);
    return;
  }
  completeStylesheetWithoutBody(context, task, reqId, response);
}

async function readStylesheetResponse(
  context: InlineStylesheetContext,
  task: InlineStylesheetTask,
  reqId: string | null,
  response: Response,
  fetchedAt: number,
): Promise<void> {
  const read = await readCappedText(response, MAX_STYLESHEET_BYTES);
  if (!read.ok) {
    console.warn(`[kitesurf-css] stylesheet read refused (${read.failure}): ${task.resolved}`);
    failStylesheetRequest(context, reqId, cappedErrorText(read.failure));
    return;
  }
  const css = read.text;
  task.css = css;
  context.cache?.set(task.resolved, { css, fetchedAt });
  completeStylesheetWithBody(context, task, reqId, response, css);
}

function completeStylesheetWithBody(
  context: InlineStylesheetContext,
  task: InlineStylesheetTask,
  reqId: string | null,
  response: Response,
  css: string,
): void {
  if (reqId === null || !context.tracker) return;
  context.tracker.completeRequest(reqId, {
    url: task.resolved,
    status: response.status,
    statusText: response.statusText,
    headers: headersToRecord(response.headers),
    mimeType: response.headers.get("content-type") ?? "text/css",
    bodyLength: css.length,
    body: css,
    bodyBase64Encoded: false,
  });
}

function completeStylesheetWithoutBody(
  context: InlineStylesheetContext,
  task: InlineStylesheetTask,
  reqId: string | null,
  response: Response,
): void {
  if (reqId === null || !context.tracker) return;
  context.tracker.completeRequest(reqId, {
    url: task.resolved,
    status: response.status,
    statusText: response.statusText,
    headers: headersToRecord(response.headers),
    mimeType: response.headers.get("content-type") ?? "text/css",
    bodyLength: 0,
  });
}

function applyInlineStylesheetTasks(dom: DomHandle, tasks: InlineStylesheetTask[]): void {
  for (const task of tasks) {
    try {
      applyInlineStylesheetTask(dom, task);
    } catch (err) {
      console.warn(
        "kitesurf: inlineStylesheets mutation failed for",
        task.href,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

function applyInlineStylesheetTask(dom: DomHandle, task: InlineStylesheetTask): void {
  if (task.css === undefined) {
    dom.removeNode(task.nodeId);
    return;
  }
  const styleId = dom.createElement("style");
  dom.applyOps(
    JSON.stringify([
      {
        kind: "setAttribute",
        node: styleId,
        name: "data-cs-inlined-from",
        value: task.href,
      },
    ]),
  );
  const textId = dom.createTextNode(task.css);
  dom.appendChildNode(styleId, textId);
  dom.replaceChildNode(styleId, task.nodeId);
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const n = Math.floor(v);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

const POLL_INTERVAL_MS = 33;
const IDLE_SCREENCAST_WAKE_MS = 1000;
const RENDER_FAILURE_LIMIT = 20;
const NO_DOCUMENT_YET = "no document loaded";
const NO_DOCUMENT_BACKOFF_MS = 1_000;
const ACK_TIMEOUT_MS = 30_000;

interface InFlightRender {
  promise: ReturnType<typeof renderViaPageRenderer>;
  isCurrent: () => boolean;
  seq: number;
  settled: boolean;
}

type ScreencastRenderResult = Awaited<ReturnType<typeof renderViaPageRenderer>>;
type FailedScreencastRender = Extract<ScreencastRenderResult, { failed: string }>;
type SuccessfulScreencastRender = Exclude<ScreencastRenderResult, FailedScreencastRender>;
type ScreencastPumpResult = Awaited<ReturnType<typeof pumpPageTasks>>;

interface ScreencastLoop {
  ctx: DispatchCtx;
  target: TargetState;
  state: ScreencastState;
  now: ReturnType<typeof makeWallClock>;
  loopStartedAt: number;
  exitReason: string;
  skipCounter: number;
  placeholderConfigurationVersion: number;
  noDocPlaceholderSent: boolean;
  inFlight: InFlightRender | null;
  seqGeneration: number;
  targetPeriod: number;
  ackPollCap: number;
  pacingConfigurationVersion: number;
  nextFrameDue: number;
  idleUntil: number;
}

async function screencastLoop(
  ctx: DispatchCtx,
  target: TargetState,
  state: ScreencastState,
): Promise<void> {
  const loop = createScreencastLoop(ctx, target, state);
  try {
    while (!state.stopped) {
      if (!(await runScreencastIteration(loop))) break;
    }
  } finally {
    await finishScreencastLoop(loop);
  }
}

function createScreencastLoop(
  ctx: DispatchCtx,
  target: TargetState,
  state: ScreencastState,
): ScreencastLoop {
  console.log(
    `[kitesurf-screencast] loop start target=${target.targetId} ` +
      `format=${state.format} quality=${state.quality} ` +
      `maxWidth=${state.maxWidth} maxHeight=${state.maxHeight} ` +
      `everyNthFrame=${state.everyNthFrame}`,
  );
  const now = makeWallClock(ctx.env);
  const targetPeriod = state.pollIntervalMs;
  return {
    ctx,
    target,
    state,
    now,
    loopStartedAt: now(),
    exitReason: "unknown",
    skipCounter: 0,
    placeholderConfigurationVersion: -1,
    noDocPlaceholderSent: false,
    inFlight: null,
    seqGeneration: target.navigateGeneration,
    targetPeriod,
    ackPollCap: screencastAckPollInterval(targetPeriod),
    pacingConfigurationVersion: state.appliedConfigurationVersion,
    nextFrameDue: 0,
    idleUntil: 0,
  };
}

function screencastAckPollInterval(targetPeriod: number): number {
  return Math.max(MIN_ACK_POLL_INTERVAL_MS, Math.min(MAX_ACK_POLL_INTERVAL_MS, targetPeriod));
}

async function runScreencastIteration(loop: ScreencastLoop): Promise<boolean> {
  if (!(await beginScreencastIteration(loop))) return false;
  if (await waitForScheduledScreencastFrame(loop)) return true;
  if (await handleScreencastWithoutPageScriptIfNeeded(loop)) return true;
  loop.placeholderConfigurationVersion = -1;
  const pump = await pumpScreencastPageTasks(loop);
  if (loop.state.stopped) return false;
  updateScreencastPumpState(loop, pump);
  await dispatchScreencastRender(loop, pump);
  return true;
}

async function beginScreencastIteration(loop: ScreencastLoop): Promise<boolean> {
  await waitForScreencastTick(loop);
  loop.idleUntil = 0;
  if (loop.state.stopped) return false;
  updateScreencastPacing(loop);
  loop.ctx.browser.networkEvents.drain();
  return !stopScreencastAfterAckTimeout(loop);
}

async function waitForScheduledScreencastFrame(loop: ScreencastLoop): Promise<boolean> {
  if (await settleRenderBeforeFrameDue(loop)) return true;
  if (!advanceScreencastFrameDeadline(loop)) return true;
  return !isScreencastConfigurationApplied(loop);
}

async function handleScreencastWithoutPageScriptIfNeeded(loop: ScreencastLoop): Promise<boolean> {
  if (loop.target.pageScript) return false;
  await handleScreencastWithoutPageScript(loop);
  return true;
}

async function waitForScreencastTick(loop: ScreencastLoop): Promise<void> {
  const currentTime = loop.now();
  const untilFrame = loop.nextFrameDue - currentTime;
  const delay =
    loop.idleUntil > currentTime
      ? loop.idleUntil - currentTime
      : untilFrame > 0
        ? Math.min(untilFrame, loop.ackPollCap)
        : 1;
  await napScreencastLoop(loop, delay);
}

function napScreencastLoop(loop: ScreencastLoop, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      if (loop.state.wake === wake) loop.state.wake = undefined;
      resolve();
    };
    let timer = setTimeout(done, ms);
    const wake = (): void => {
      clearTimeout(timer);
      timer = setTimeout(done, 0);
    };
    loop.state.wake = wake;
  });
}

function updateScreencastPacing(loop: ScreencastLoop): void {
  const { state } = loop;
  if (
    state.configurationVersion !== state.appliedConfigurationVersion ||
    state.appliedConfigurationVersion === loop.pacingConfigurationVersion
  ) {
    return;
  }
  loop.pacingConfigurationVersion = state.appliedConfigurationVersion;
  loop.targetPeriod = state.pollIntervalMs;
  loop.ackPollCap = screencastAckPollInterval(loop.targetPeriod);
  loop.nextFrameDue = 0;
}

function stopScreencastAfterAckTimeout(loop: ScreencastLoop): boolean {
  const { state } = loop;
  if (state.pendingAckSessionId === null) return false;
  const elapsed = loop.now() - state.pendingAckSetAt;
  if (elapsed <= ACK_TIMEOUT_MS) return false;
  autoStopScreencastForAck(loop, `after ${elapsed} ms with no ack`);
  return true;
}

function autoStopScreencastForAck(loop: ScreencastLoop, reason: string): void {
  console.warn(`kitesurf: screencast auto-stop ${reason}`);
  loop.state.stopped = true;
  loop.ctx.browser.screencasts.delete(loop.target.targetId);
  stopAndRemoveWheelQueue(
    loop.ctx.browser,
    loop.target.targetId,
    loop.state.ownerSessionId,
    loop.state.wheelQueue,
  );
}

async function settleRenderBeforeFrameDue(loop: ScreencastLoop): Promise<boolean> {
  const pending = takeSettledRenderBeforeFrameDue(loop);
  if (!pending) return false;
  await settleScreencastRender(loop, pending);
  return true;
}

function takeSettledRenderBeforeFrameDue(loop: ScreencastLoop): InFlightRender | null {
  const pending = loop.inFlight;
  if (!pending || !pending.settled) return null;
  if (loop.now() >= loop.nextFrameDue) return null;
  if (loop.state.frameSeq - loop.state.lastAckedSeq >= loop.state.maxInFlight) return null;
  loop.inFlight = null;
  return pending;
}

function advanceScreencastFrameDeadline(loop: ScreencastLoop): boolean {
  const now = loop.now();
  if (now < loop.nextFrameDue) return false;
  loop.nextFrameDue =
    loop.nextFrameDue === 0 || now - loop.nextFrameDue > loop.targetPeriod
      ? now + loop.targetPeriod
      : loop.nextFrameDue + loop.targetPeriod;
  return true;
}

function isScreencastConfigurationApplied(loop: ScreencastLoop): boolean {
  return loop.state.configurationVersion === loop.state.appliedConfigurationVersion;
}

async function handleScreencastWithoutPageScript(loop: ScreencastLoop): Promise<void> {
  await sendScreencastPlaceholderIfNeeded(loop);
  const stale = loop.inFlight;
  if (!stale) return;
  loop.inFlight = null;
  await stale.promise.catch(() => {});
}

async function pumpScreencastPageTasks(loop: ScreencastLoop): Promise<ScreencastPumpResult> {
  const { ctx, target, state } = loop;
  pumpOopifFrames(ctx, target);
  const canIdle = screencastCanIdle(loop);
  state.paintDirty = false;
  return pumpPageTasks(
    target,
    PUMP_TASKS_TIMEOUT_MS,
    canIdle ? state.lastRenderedMutationSeq : undefined,
    loop.targetPeriod,
  );
}

function screencastCanIdle(loop: ScreencastLoop): boolean {
  return (
    loop.seqGeneration === loop.target.navigateGeneration &&
    !loop.inFlight &&
    ![...loop.target.frames.values()].some((frame) => frame.pageScript)
  );
}

function updateScreencastPumpState(loop: ScreencastLoop, pump: ScreencastPumpResult): void {
  updateScreencastRafDeadline(loop, pump);
  updateScreencastIdleDeadline(loop, pump);
  resetScreencastSequenceAfterNavigation(loop);
}

function updateScreencastRafDeadline(loop: ScreencastLoop, pump: ScreencastPumpResult): void {
  if (pump?.nextRafDelayMs !== undefined && pump.nextRafDelayMs > 0) {
    loop.nextFrameDue = Math.min(loop.nextFrameDue, loop.now() + pump.nextRafDelayMs);
  }
}

function updateScreencastIdleDeadline(loop: ScreencastLoop, pump: ScreencastPumpResult): void {
  if (pump?.idle && !loop.inFlight && !loop.state.paintDirty) {
    loop.idleUntil = loop.now() + IDLE_SCREENCAST_WAKE_MS;
  }
}

function resetScreencastSequenceAfterNavigation(loop: ScreencastLoop): void {
  if (loop.seqGeneration !== loop.target.navigateGeneration) {
    loop.seqGeneration = loop.target.navigateGeneration;
    loop.state.lastRenderedMutationSeq = -1;
  }
}

async function dispatchScreencastRender(
  loop: ScreencastLoop,
  pump: ScreencastPumpResult,
): Promise<void> {
  const next = shouldDispatchScreencastRender(loop, pump)
    ? createScreencastRender(loop, pump)
    : null;
  const pending = loop.inFlight;
  loop.inFlight = next;
  if (!pending) return;
  await settleScreencastRender(loop, pending);
}

function shouldDispatchScreencastRender(loop: ScreencastLoop, pump: ScreencastPumpResult): boolean {
  if (shouldHoldScreencastRender(loop, pump)) return false;
  return !shouldSkipNthScreencastFrame(loop);
}

function shouldHoldScreencastRender(loop: ScreencastLoop, pump: ScreencastPumpResult): boolean {
  if (loop.state.maxInFlight > 1) return false;
  if (!pump) return true;
  return pump.seq <= renderedOrInFlightScreencastSeq(loop) && !pump.animating;
}

function renderedOrInFlightScreencastSeq(loop: ScreencastLoop): number {
  const pending = loop.inFlight;
  const pendingSeq = pending?.isCurrent() ? pending.seq : -1;
  return Math.max(loop.state.lastRenderedMutationSeq, pendingSeq);
}

function shouldSkipNthScreencastFrame(loop: ScreencastLoop): boolean {
  if (loop.state.everyNthFrame <= 1) return false;
  loop.skipCounter += 1;
  if (loop.skipCounter < loop.state.everyNthFrame) return true;
  loop.skipCounter = 0;
  return false;
}

function createScreencastRender(
  loop: ScreencastLoop,
  pump: ScreencastPumpResult,
): InFlightRender | null {
  const { ctx, target, state } = loop;
  const renderGeneration = target.navigateGeneration;
  const renderPageScript = target.pageScript;
  if (!renderPageScript) return null;
  const renderConfigurationVersion = state.configurationVersion;
  const isCurrent = (): boolean =>
    isScreencastActive(loop) &&
    isScreencastNavigationCurrent(loop, renderGeneration, renderPageScript) &&
    isScreencastConfigurationCurrent(loop, renderConfigurationVersion);
  if (!isCurrent()) return null;
  const render: InFlightRender = {
    seq: pump?.seq ?? -1,
    settled: false,
    promise: renderViaPageRenderer(ctx, target, {
      format: state.format,
      quality: state.quality,
      omitBackground: false,
      sinceSeq: state.lastRenderedMutationSeq,
      partialKey: partialKeyFor(ctx, target),
    }),
    isCurrent,
  };
  render.promise.then(
    () => markScreencastRenderSettled(loop, render),
    () => markScreencastRenderSettled(loop, render),
  );
  return render;
}

function isScreencastActive(loop: ScreencastLoop): boolean {
  return (
    !loop.state.stopped &&
    !loop.ctx.browser.wsClosing &&
    loop.ctx.browser.screencasts.get(loop.target.targetId) === loop.state
  );
}

function isScreencastNavigationCurrent(
  loop: ScreencastLoop,
  generation: number,
  pageScript: PageScriptStub,
): boolean {
  return loop.target.navigateGeneration === generation && loop.target.pageScript === pageScript;
}

function isScreencastConfigurationCurrent(loop: ScreencastLoop, version: number): boolean {
  return (
    loop.state.configurationVersion === version &&
    loop.state.appliedConfigurationVersion === version
  );
}

function markScreencastRenderSettled(loop: ScreencastLoop, render: InFlightRender): void {
  render.settled = true;
  loop.state.wake?.();
}

async function settleScreencastRender(
  loop: ScreencastLoop,
  pending: InFlightRender,
): Promise<void> {
  const result = await pending.promise;
  if (!pending.isCurrent()) return;
  if ("failed" in result) {
    await handleFailedScreencastRender(loop, result);
    return;
  }
  await handleSuccessfulScreencastRender(loop, pending, result);
}

async function handleFailedScreencastRender(
  loop: ScreencastLoop,
  result: FailedScreencastRender,
): Promise<void> {
  loop.state.lastRenderError = result.failed;
  loop.state.framesDropped += 1;
  if (result.stage !== "record") return;
  if (result.failed.includes(NO_DOCUMENT_YET)) {
    await handleMissingScreencastDocument(loop);
    return;
  }
  loop.state.consecutiveRenderFailures += 1;
  if (loop.state.consecutiveRenderFailures >= RENDER_FAILURE_LIMIT) {
    retireAfterPersistentScreencastFailure(loop, result);
  }
}

async function handleMissingScreencastDocument(loop: ScreencastLoop): Promise<void> {
  if (!loop.noDocPlaceholderSent && (await sendScreencastPlaceholder(loop))) {
    loop.noDocPlaceholderSent = true;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, NO_DOCUMENT_BACKOFF_MS));
}

function retireAfterPersistentScreencastFailure(
  loop: ScreencastLoop,
  result: FailedScreencastRender,
): void {
  const { ctx, target, state } = loop;
  console.warn(
    "kitesurf: screencast record failed " +
      `${state.consecutiveRenderFailures}x (${result.failed})` +
      " — placeholder until next navigate.",
  );
  ctx.browser.dedicatedWorkers.terminateTarget(target.targetId, "render failure");
  void retireStub(target, "renderFailure", "screencast: persistent record failure", {
    budget: ctx.browser.workerBudget,
  });
  loop.placeholderConfigurationVersion = -1;
  state.consecutiveRenderFailures = 0;
}

async function handleSuccessfulScreencastRender(
  loop: ScreencastLoop,
  pending: InFlightRender,
  result: SuccessfulScreencastRender,
): Promise<void> {
  loop.state.consecutiveRenderFailures = 0;
  loop.state.lastRenderError = null;
  loop.noDocPlaceholderSent = false;
  if (result.unchanged) {
    advanceUnchangedScreencastSequence(loop, result.seq);
    return;
  }
  if (!result.bytes || result.bytes.length === 0) return;
  await waitForScreencastAckCapacity(loop, pending);
  if (!pending.isCurrent()) return;
  emitScreencastFrame(loop, result.bytes, result.seq, result.scrollX, result.scrollY);
}

function advanceUnchangedScreencastSequence(loop: ScreencastLoop, seq: number): void {
  if (seq > loop.state.lastRenderedMutationSeq) loop.state.lastRenderedMutationSeq = seq;
}

async function waitForScreencastAckCapacity(
  loop: ScreencastLoop,
  pending: InFlightRender,
): Promise<void> {
  while (loop.state.frameSeq - loop.state.lastAckedSeq >= loop.state.maxInFlight) {
    if (!pending.isCurrent()) break;
    if (screencastAckHasExpired(loop)) {
      autoStopScreencastForAck(loop, "waiting for ack before emit");
      break;
    }
    await napScreencastLoop(loop, loop.ackPollCap);
  }
}

function screencastAckHasExpired(loop: ScreencastLoop): boolean {
  return (
    loop.state.pendingAckSessionId !== null &&
    loop.now() - loop.state.pendingAckSetAt > ACK_TIMEOUT_MS
  );
}

function emitScreencastFrame(
  loop: ScreencastLoop,
  bytes: Uint8Array,
  mutationSeq: number,
  scrollX = 0,
  scrollY = 0,
): void {
  const { ctx, state } = loop;
  state.lastRenderedMutationSeq = mutationSeq;
  state.frameSeq += 1;
  const sid = state.frameSeq;
  if (state.pendingAckSessionId === null) {
    state.pendingAckSessionId = sid;
    state.pendingAckSetAt = loop.now();
  }
  ctx.emit({
    method: "Page.screencastFrame",
    params: {
      data: bytesToBase64(bytes),
      metadata: {
        offsetTop: 0,
        pageScaleFactor: 1,
        deviceWidth: state.maxWidth,
        deviceHeight: state.maxHeight,
        scrollOffsetX: scrollX,
        scrollOffsetY: scrollY,
        timestamp: loop.now() / MILLISECONDS_PER_SECOND,
      },
      sessionId: sid,
    },
    sessionId: state.ownerSessionId,
  });
}

async function sendScreencastPlaceholder(loop: ScreencastLoop): Promise<boolean> {
  try {
    const { renderHtmlToImage } = await import("../wasm.ts");
    const { state } = loop;
    const bytes = renderHtmlToImage(
      PLACEHOLDER_HTML,
      "https://kitesurf.local/",
      state.maxWidth,
      state.maxHeight,
      state.format,
      state.quality,
    );
    if (!canSendScreencastPlaceholder(loop, bytes)) return false;
    emitScreencastFrame(loop, bytes, -1);
    return true;
  } catch (err) {
    console.warn("kitesurf: placeholder frame render threw", err);
    return false;
  }
}

function canSendScreencastPlaceholder(loop: ScreencastLoop, bytes: Uint8Array): boolean {
  const { ctx, target, state } = loop;
  return (
    bytes.length > 0 &&
    !state.stopped &&
    !ctx.browser.wsClosing &&
    ctx.browser.screencasts.get(target.targetId) === state &&
    state.configurationVersion === state.appliedConfigurationVersion
  );
}

async function sendScreencastPlaceholderIfNeeded(loop: ScreencastLoop): Promise<void> {
  if (
    loop.placeholderConfigurationVersion === loop.state.appliedConfigurationVersion ||
    loop.state.frameSeq - loop.state.lastAckedSeq >= loop.state.maxInFlight
  ) {
    return;
  }
  if (await sendScreencastPlaceholder(loop)) {
    loop.placeholderConfigurationVersion = loop.state.appliedConfigurationVersion;
  }
}

async function finishScreencastLoop(loop: ScreencastLoop): Promise<void> {
  if (loop.inFlight) await loop.inFlight.promise.catch(() => {});
  loop.exitReason = loop.state.stopped ? "state.stopped" : loop.exitReason;
  const elapsed = loop.now() - loop.loopStartedAt;
  console.log(
    `[kitesurf-screencast] loop end target=${loop.target.targetId} ` +
      `reason=${loop.exitReason} elapsedMs=${elapsed} ` +
      `frameSeq=${loop.state.frameSeq} ` +
      `pendingAck=${loop.state.pendingAckSessionId}`,
  );
}

const PLACEHOLDER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>kitesurf</title>
<style>
  html,body{margin:0;padding:0;background:#1e1e1e;color:#bbb;font:14px sans-serif;height:100%}
  body{display:flex;align-items:center;justify-content:center;height:100vh}
  .panel{text-align:center}
  .panel .title{color:#eee;font-size:18px;margin-bottom:8px}
  .panel .sub{font-size:13px;color:#888}
</style></head>
<body><div class="panel">
  <div class="title">kitesurf</div>
  <div class="sub">waiting for navigation…</div>
</div></body></html>`;
