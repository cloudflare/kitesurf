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
import { traceSpan, redactUrl } from "../tracing.ts";
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
import type { StyleCache } from "./style-cache.ts";
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
  type PageScriptStub,
} from "../eval/page-script.ts";
import { registerIsolateLimitListener, type IsolateLimitNotice } from "../eval/limit-registry.ts";
import {
  disposeStub,
  publishStub,
  retireStub,
  type GenerationDeps,
} from "./page-script-generation.ts";
import { emitSessionStart } from "../observability.ts";
import type { CallerOutboundProps, SandboxOutboundOverride } from "../eval/outbound.ts";
import { getOutboundInflight } from "../eval/outbound.ts";
import { walkRedirects } from "../eval/redirect-walk.ts";
import { siteKey } from "../public-suffix.ts";
import { PageRendererManager, withTimeout } from "../eval/page-renderer.ts";
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

// The renderer's resource cache is keyed by hashes that the page itself reports, so it serves
// one top-level document, with its frames, and is dropped when the scope changes.
function renderScope(target: TargetState): string {
  return `${target.targetId}:${target.navigateGeneration}`;
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

/** The URL's tuple origin, or null when it has none (opaque or unparsable). */
export function initiatorOriginOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

/** Caller extra headers for a document fetch. Credentials the caller set for the page it
 *  drives stay with that origin: a page-started navigation elsewhere does not carry them. */
export function navigationExtraHeaders(
  extra: Record<string, string>,
  initiatorOrigin: string | null,
  url: string,
): Record<string, string> {
  if (initiatorOrigin === null || initiatorOrigin === initiatorOriginOf(url)) return extra;
  const kept: Record<string, string> = {};
  for (const [k, v] of Object.entries(extra)) {
    if (!CREDENTIAL_HEADERS.has(k.toLowerCase())) kept[k] = v;
  }
  return kept;
}

function getRendererManager(ctx: DispatchCtx, target?: TargetState): PageRendererManager {
  if (!ctx.browser.rendererManager) {
    ctx.browser.rendererManager = new PageRendererManager(
      ctx.env,
      ctx.ctx,
      ctx.connectionId,
      ctx.browser.attributionHeaders,
      ctx.browser.workerBudget,
      {
        width: target?.viewportWidth ?? DEFAULT_VIEWPORT_WIDTH,
        height: target?.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT,
      },
    );
  }
  return ctx.browser.rendererManager;
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
    manager.renderFrame(ps, { ...opts, scope: renderScope(target), traced }),
  );
  if (res.ok && res.unchanged === true) {
    return {
      unchanged: true,
      seq: res.seq,
      scrollX: res.scrollX,
      scrollY: res.scrollY,
    };
  }
  if (!res.ok || !res.bytes || res.bytes.length === 0) {
    const reason = res.error ?? "unknown render failure";
    console.warn("kitesurf: pageRenderer renderFrame failed:", reason);
    return {
      failed: reason,
      stage: res.stage === "record" ? "record" : "rasterize",
    };
  }
  return {
    bytes: res.bytes,
    seq: res.seq,
    scrollX: res.scrollX,
    scrollY: res.scrollY,
  };
}

function recordNavigationHistory(target: TargetState, url: string, transitionType: string): void {
  if (transitionType === "back_forward") return;
  if (transitionType === "reload") {
    const live = target.navigationHistory[target.navigationHistoryIndex];
    if (live) {
      live.url = url;
      live.userTypedURL = url;
    }
    return;
  }
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return;
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) return;

  const widthPt = finitePdfNumber(parsed.widthPt);
  const heightPt = finitePdfNumber(parsed.heightPt);
  const ptToCssPx = 96 / 72;
  if (
    preferCSSPageSize &&
    parsed.hasSize === true &&
    widthPt !== undefined &&
    widthPt !== 0 &&
    heightPt !== undefined &&
    heightPt !== 0
  ) {
    layout.width = Math.round(widthPt * ptToCssPx);
    layout.height = Math.round(heightPt * ptToCssPx);
    layout.cssPageSize = true;
  }
  if (parsed.hasMargin === true) {
    const marginPx = (point: unknown): number => {
      const value = finitePdfNumber(point);
      return value !== undefined && value > 0 ? value * ptToCssPx : 0;
    };
    layout.marginTopPx = marginPx(parsed.marginTopPt);
    layout.marginRightPx = marginPx(parsed.marginRightPt);
    layout.marginBottomPx = marginPx(parsed.marginBottomPt);
    layout.marginLeftPx = marginPx(parsed.marginLeftPt);
  }
}

async function restorePdfState(
  target: TargetState,
  previousMedia: TargetState["emulatedMedia"],
  backgroundSuppressed: boolean,
): Promise<void> {
  if (backgroundSuppressed && target.pageScript) {
    try {
      await stubQueryDom(target.pageScript, "setSuppressBackgrounds", { enabled: false });
    } catch {}
  }
  if (previousMedia !== "print" && target.pageScript) {
    try {
      await stubQueryDom(target.pageScript, "setMediaType", {
        media: previousMedia,
        quiet: true,
      });
      target.emulatedMedia = previousMedia;
    } catch {}
  }
}

function consoleArgumentText(value: unknown): string {
  if (typeof value !== "object" || value === null) return String(value);
  const description = "description" in value ? value.description : undefined;
  if (typeof description === "string" && description) return description;
  const valueJson = "valueJson" in value ? value.valueJson : undefined;
  if (typeof valueJson === "string" && valueJson) {
    try {
      const parsed: unknown = JSON.parse(valueJson);
      return typeof parsed === "string" ? parsed : (JSON.stringify(parsed) ?? "");
    } catch {
      return valueJson;
    }
  }
  return JSON.stringify(value) ?? "";
}

function firstConsoleWarningOrError(entries: ConsoleEntry[] | undefined): string | null {
  for (const entry of entries ?? []) {
    if (entry.level !== "error" && entry.level !== "warning") continue;
    const args: unknown[] = Array.isArray(entry.args) ? entry.args : [];
    return args.map(consoleArgumentText).join(" ").slice(0, MAX_FIRST_ERROR_CHARS);
  }
  return null;
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

export async function handlePage(
  ctx: DispatchCtx,
  req: CdpRequest | InternalHistoryNavigateRequest,
): Promise<unknown> {
  const target = resolveTarget(ctx, req.sessionId);

  switch (req.method) {
    case "Page.enable":
    case "Page.disable":
    case "Page.setLifecycleEventsEnabled":
    case "Page.setInterceptFileChooserDialog":
      return {};

    case "Page.getFrameTree": {
      return { frameTree: buildFrameTree(target) };
    }

    case "Page.getResourceTree": {
      return { frameTree: buildFrameResourceTree(target) };
    }

    case "Page.getNavigationHistory": {
      const live = target.navigationHistory[target.navigationHistoryIndex];
      if (live) live.title = target.title;
      return {
        currentIndex: target.navigationHistoryIndex,
        entries: target.navigationHistory.map((e) => ({ ...e })),
      };
    }

    case "Page.getLayoutMetrics": {
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

    case "Page.navigateToHistoryEntry": {
      const entryId: unknown = req.params?.entryId;
      if (typeof entryId !== "number") {
        throw new Error("Page.navigateToHistoryEntry: entryId (integer) is required");
      }
      const newIndex = target.navigationHistory.findIndex((e) => e.id === entryId);
      if (newIndex < 0) {
        throw new Error(`Page.navigateToHistoryEntry: no entry with id ${entryId}`);
      }
      if (newIndex === target.navigationHistoryIndex) return {};
      const dest = target.navigationHistory[newIndex]!;
      target.navigationHistoryIndex = newIndex;
      const navReq = {
        ...req,
        method: "Page.navigate",
        params: {
          url: dest.url,
          transitionType: "back_forward",
          _kitesurfInternal: true,
        },
      } satisfies InternalHistoryNavigateRequest;
      await handlePage(ctx, navReq);
      return {};
    }

    case "Page.reload": {
      const params = req.params || {};
      if (typeof params.loaderId === "string" && params.loaderId !== target.loaderId) {
        throw new Error(
          "Page.reload: loaderId mismatch (target navigated since the loaderId was issued)",
        );
      }
      const reloadUrl = target.url || "about:blank";
      if (ctx.browser.cdpDebug) {
        console.log(
          `[kitesurf-nav] Page.reload received id=${req.id} ` +
            `sessionId=${JSON.stringify(req.sessionId)} url=${reloadUrl} ` +
            `gen=${target.navigateGeneration}`,
        );
      }
      const reloadReq: CdpRequest = {
        ...req,
        method: "Page.navigate",
        params: { url: reloadUrl, transitionType: "reload", _kitesurfInternal: true },
      };
      return await handlePage(ctx, reloadReq);
    }

    case "Page.navigate": {
      let url = req.params?.url ?? "about:blank";
      const ksParams = req.params;
      const ksPostData =
        typeof ksParams?._kitesurfPostData === "string" ? ksParams._kitesurfPostData : null;
      const ksPostContentType =
        typeof ksParams?._kitesurfPostContentType === "string"
          ? ksParams._kitesurfPostContentType
          : "application/x-www-form-urlencoded";
      if (ctx.browser.cdpDebug) {
        console.log(
          `[kitesurf-nav] Page.navigate received id=${req.id} ` +
            `sessionId=${JSON.stringify(req.sessionId)} url=${url} ` +
            `prevTargetUrl=${JSON.stringify(target.url)} ` +
            `gen=${target.navigateGeneration}`,
        );
      }
      if (url !== "about:blank" && url !== "") {
        try {
          new URL(url);
        } catch {
          throw new Error("Cannot navigate to invalid URL");
        }
      }
      // Abort the previous signal so its redirect walk and egress request can stop.
      target.pendingNavAbort?.abort();
      const navAbort = new AbortController();
      target.pendingNavAbort = navAbort;
      // An input-started navigation announced its loader in Page.frameStartedNavigating.
      target.loaderId =
        ksParams?._kitesurfInternal === true && typeof ksParams._kitesurfLoaderId === "string"
          ? ksParams._kitesurfLoaderId
          : makeTargetId();
      const loaderId = target.loaderId;

      try {
        const parsedNavUrl = new URL(url);
        target.refetchOnPushState =
          parsedNavUrl.searchParams.get("ks_refetch_on_pushstate") === "1";
        if (parsedNavUrl.searchParams.has("ks_refetch_on_pushstate")) {
          parsedNavUrl.searchParams.delete("ks_refetch_on_pushstate");
          url = parsedNavUrl.toString();
        }
        if (
          ksParams?._kitesurfInternal !== true &&
          applyTtyNavParams(parsedNavUrl.searchParams, ctx.browser)
        ) {
          url = parsedNavUrl.toString();
        }
      } catch {}
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
      target.frames.set(
        target.frameId,
        makeMainFrameState({ frameId: target.frameId, loaderId, url }),
      );

      ctx.browser.networkEvents.setTargetAttribution(
        target.frameId,
        loaderId,
        targetSessionsNetwork(target, req.sessionId),
      );
      ctx.browser.networkEvents.dropStaleLoaderBodies(target.frameId);

      if (url === "about:blank" || url === "") {
        const html = "<html><head></head><body></body></html>";
        target.html = html;
        const blitzUrl = sanitizeBaseUrl(url);
        try {
          target.dom = createDom(html, blitzUrl);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn("kitesurf: navigate(about:blank) createDom trap:", msg);
          target.dom = null;
          return navigateReply(
            target.frameId,
            loaderId,
            `navigate: wasm trap during parse: ${msg}`,
          );
        }
        const {
          console: capturedConsole,
          cdpMutations,
          exceptions,
        } = await pushNavigateToPageScript(ctx, target, html, blitzUrl);
        recordNavigationHistory(target, url, req.params?.transitionType ?? "typed");
        emitNavigationLifecycle(ctx, target, req.sessionId);
        emitExecutionContextCreated(ctx, target, req.sessionId);
        emitCapturedConsole(ctx, target, capturedConsole, req.sessionId);
        emitCapturedExceptions(ctx, target, exceptions, req.sessionId);
        emitMutations(ctx, target, cdpMutations);
        clearPendingNavAbort(target, navAbort);
        return navigateReply(target.frameId, loaderId);
      }

      emitFrameStartedLoading(ctx, target, mainFrame(target), req.sessionId);

      try {
        const reqHeaders: Record<string, string> = {
          "user-agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        };
        // A page-started navigation carries the initiating document's host,
        // so SameSite=Strict is withheld on a cross-site top-level navigation
        // just as it is in a browser. CDP-started navigations have no
        // initiator and keep the existing same-site behavior.
        const ksInitiatorOrigin =
          typeof ksParams?._kitesurfInitiatorOrigin === "string"
            ? ksParams._kitesurfInitiatorOrigin
            : null;
        const ksInitiatorHost = ksInitiatorOrigin ? hostOfUrl(ksInitiatorOrigin) : null;
        const navExtraHeaders = navigationExtraHeaders(
          effectiveExtraHeaders(target),
          ksInitiatorOrigin,
          url,
        );
        const cookieHeader = jarForTarget(ctx, target).cookieHeaderForUrl(
          url,
          ksInitiatorHost ? { initiatorHost: ksInitiatorHost, topLevel: true } : undefined,
        );
        if (cookieHeader) reqHeaders.cookie = cookieHeader;

        const navReferrer: unknown = req.params?.referrer;
        if (typeof navReferrer === "string" && navReferrer) {
          reqHeaders.referer = navReferrer;
        }

        for (const [k, v] of Object.entries(navExtraHeaders)) {
          reqHeaders[k] = v;
        }
        target.docReferrer =
          Object.entries(reqHeaders).find(([k]) => k.toLowerCase() === "referer")?.[1] ?? null;

        if (ksPostData !== null) {
          reqHeaders["content-type"] = ksPostContentType;
        }
        const requestId = ctx.browser.networkEvents.beginRequest({
          url,
          method: ksPostData !== null ? "POST" : "GET",
          headers: reqHeaders,
          type: "Document",
          initiator: { type: "other" },
          loaderId,
          frameId: target.frameId,
          requestId: loaderId,
        });
        // Flush requestWillBeSent before egress can complete the document request.
        ctx.browser.networkEvents.drain();

        let docPageOrigin = "";
        try {
          docPageOrigin = new URL(url).origin;
        } catch {}
        const docProps: CallerOutboundProps = {
          pageOrigin: docPageOrigin,
          // A navigation the page started names its initiating document; one the CDP client
          // started has none, so Private Network Access leaves it alone.
          privateNetworkInitiator: ksInitiatorOrigin ?? undefined,
          mainFrameId: target.frameId,
          mainLoaderId: target.loaderId,
          interceptConnectionId: ctx.connectionId,
          cookieKey: cookieKeyFor(ctx.connectionId, target.browserContextId),
          allowDocumentBypass: true,
          skipRequestBlocker: true,
          topLevelDocument: true,
          walksOwnRedirects: true,
          extraHeaders: navExtraHeaders,
        };
        const docOutbound = ctx.browser.sandboxOutbound.parent(docProps);
        let resp: Response;
        const abortP = new Promise<never>((_, rej) => {
          navAbort.signal.addEventListener("abort", () =>
            rej(new DOMException("navigation replaced", "AbortError")),
          );
        });
        abortP.catch(() => {});
        let currentUrl = url;
        const initialHost = hostOfUrl(url);
        let chainLeftSite =
          ksInitiatorHost !== null &&
          initialHost !== null &&
          siteKey(ksInitiatorHost) !== siteKey(initialHost);
        let hopBody: Uint8Array | undefined;
        if (ksPostData !== null) {
          hopBody = new Uint8Array(ksPostData.length);
          for (let i = 0; i < ksPostData.length; i++) {
            hopBody[i] = ksPostData.charCodeAt(i) & 0xff;
          }
        }
        try {
          const walk = await walkRedirects({
            url,
            method: ksPostData !== null ? "POST" : "GET",
            body: hopBody,
            signal: navAbort.signal,
            headers: {
              ...reqHeaders,
              "x-kitesurf-resource-type": "Document",
              "x-kitesurf-initiator": "parser",
              "x-kitesurf-allow-cross-origin": "1",
              "x-kitesurf-page-origin": docPageOrigin,
              "x-kitesurf-network-id": loaderId,
            },
            cookieHeaderFor: (hopUrl) =>
              jarForTarget(ctx, target).cookieHeaderForUrl(
                hopUrl,
                chainLeftSite ? { initiatorHost: null, topLevel: true } : undefined,
              ),
            onSetCookie: (hopUrl, hopResp) => {
              for (const sc of readSetCookieHeaders(hopResp)) {
                jarForTarget(ctx, target).setFromHeader(hopUrl, sc);
              }
            },
            onRedirect: (hop) => {
              if (!chainLeftSite) {
                const from = hostOfUrl(hop.fromUrl);
                const to = hostOfUrl(hop.newUrl);
                if (from === null || to === null || siteKey(from) !== siteKey(to)) {
                  chainLeftSite = true;
                }
              }
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
            },
            fetchHop: (hopReq) => {
              const fetchP = traceSpan(
                ctx.env.HOST_TRACER,
                "navigate.fetch_document",
                () => docOutbound.fetch(hopReq),
                { url: redactUrl(hopReq.url) },
              );
              fetchP.catch(() => {});
              return Promise.race([fetchP, abortP]);
            },
          });
          if (!walk.ok) {
            ctx.browser.networkEvents.failRequest(requestId, "net::ERR_TOO_MANY_REDIRECTS");
            return navigateReply(target.frameId, loaderId, "net::ERR_TOO_MANY_REDIRECTS");
          }
          resp = walk.response;
          currentUrl = walk.finalUrl;
          // A cross-origin hop cuts the Referer down to its origin, so the
          // terminal hop's value replaces the one the first request sent.
          target.docReferrer = walk.referrer || null;
        } catch (fetchErr) {
          const errorText = navErrorText(fetchErr, navAbort.signal.aborted);
          ctx.browser.networkEvents.failRequest(
            requestId,
            errorText ?? (fetchErr instanceof Error ? fetchErr.message : String(fetchErr)),
          );
          if (errorText) {
            return navigateReply(target.frameId, loaderId, errorText);
          }
          throw fetchErr;
        }
        const docKind = documentKind(resp.headers);
        if (resp.status === 204 || resp.status === 205 || docKind === "blocked") {
          void resp.body?.cancel().catch(() => {});
          ctx.browser.networkEvents.completeRequest(requestId, {
            url: currentUrl,
            status: resp.status,
            statusText: resp.statusText,
            headers: headersToRecord(resp.headers),
            mimeType: (resp.headers.get("content-type")?.split(";")[0] ?? "").trim() || "text/html",
            bodyLength: 0,
            errorText: "net::ERR_ABORTED",
          });
          ctx.browser.networkEvents.drain();
          clearPendingNavAbort(target, navAbort);
          return navigateReply(target.frameId, loaderId, "net::ERR_ABORTED");
        }
        const finalUrl = currentUrl;
        target.url = finalUrl;
        target.docReferrerPolicy = resp.headers.get("referrer-policy");
        target.docCsp = resp.headers.get("content-security-policy");
        target.docCspReportOnly = resp.headers.get("content-security-policy-report-only");
        recordNavigationHistory(target, finalUrl, req.params?.transitionType ?? "typed");

        const setCookies = readSetCookieHeaders(resp);
        for (const sc of setCookies) {
          jarForTarget(ctx, target).setFromHeader(finalUrl, sc);
        }

        const ct = resp.headers.get("content-type") ?? "text/html";
        let pageHtml: string;
        let networkBody: { body: string; length: number } | null = null;
        if (docKind === "html") {
          const read = await traceSpan(ctx.env.HOST_TRACER, "navigate.read_document_body", () =>
            readCappedBytes(resp, MAX_DOCUMENT_BYTES, ctx.connectionId),
          );
          if (!read.ok) {
            const errorText = cappedErrorText(read.failure);
            ctx.browser.networkEvents.failRequest(requestId, errorText);
            clearPendingNavAbort(target, navAbort);
            return navigateReply(target.frameId, loaderId, errorText);
          }
          const buf = read.bytes;
          const decoded = decodeHtmlBytes(buf, ct);
          let html = decoded.html;
          target.docCharset = decoded.charset;
          const sniffHead = html.replace(/^\uFEFF?\s*/, "");
          if (ct.includes("application/xhtml") && sniffHead.startsWith("<html")) {
            html = '<?xml version="1.0" encoding="UTF-8"?>\n' + sniffHead;
          }
          target.html = html;
          releaseTargetDom(target);
          target.docScan = traceSpan(
            ctx.env.HOST_TRACER,
            "navigate.scan_document",
            () => scanDocument(html),
            { bytes: html.length },
          );
          target.title = target.docScan.title;
          pageHtml = html;
        } else {
          const read = await readCappedBytes(resp, MAX_DOCUMENT_BYTES, ctx.connectionId);
          if (!read.ok) {
            const errorText = cappedErrorText(read.failure);
            ctx.browser.networkEvents.failRequest(requestId, errorText);
            clearPendingNavAbort(target, navAbort);
            return navigateReply(target.frameId, loaderId, errorText);
          }
          let wrapper: string;
          if (docKind === "image") {
            const base64 = bytesToBase64(read.bytes);
            wrapper = imageDocumentHtml(read.bytes, base64, ct, finalUrl);
            networkBody = { body: base64, length: read.bytes.byteLength };
          } else {
            const text = new TextDecoder().decode(read.bytes);
            wrapper =
              docKind === "json"
                ? jsonViewerHtml(text, finalUrl)
                : docKind === "svg"
                  ? svgDocumentHtml(text, {
                      width: target.viewportWidth ?? DEFAULT_VIEWPORT_WIDTH,
                      height: target.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT,
                    })
                  : `<html><head></head><body><pre>${escapeHtml(text)}</pre></body></html>`;
          }
          releaseTargetDom(target);
          target.docScan = scanDocument(wrapper);
          target.html = wrapper;
          pageHtml = wrapper;
        }

        ctx.browser.networkEvents.completeRequest(requestId, {
          url: finalUrl,
          status: resp.status,
          statusText: resp.statusText,
          headers: headersToRecord(resp.headers),
          mimeType: (ct.split(";")[0] ?? "").trim() || "text/html",
          bodyLength: networkBody?.length ?? pageHtml.length,
          body: networkBody?.body ?? pageHtml,
          bodyBase64Encoded: networkBody !== null,
        });
        // Drain Network completion before Page.frameNavigated for the main frame.
        ctx.browser.networkEvents.drain();

        {
          const mf = mainFrame(target);
          mf.url = finalUrl;
          mf.securityOrigin = originOf(finalUrl);
        }
        emitFrameNavigated(ctx, target, mainFrame(target), req.sessionId);

        let inlinedPageHtml = pageHtml;
        if (target.docScan) {
          inlinedPageHtml = pageHtml.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, "");
        }

        rebuildFrameTreeChildren(target);
        const childFrames = [...target.frames.values()].filter(
          (frame) => frame.parentFrameId !== null && frame.lifecycle === "init",
        );
        emitChildFrameAttachAndStart(
          ctx,
          target.frames,
          childFrames,
          targetSessions(target, req.sessionId),
        );
        resetPrespawnBudget(target);
        for (const f of target.frames.values()) {
          if (f.parentFrameId === null) continue;
          if (f.lifecycle !== "init") continue;
          if (f.isCrossOrigin || f.url === "about:blank" || f.url === "") {
            f.readyState = "complete";
            f.pendingLoad = Promise.resolve();
            prespawnOopifFrame(ctx, target, f);
            continue;
          }
          f.pendingLoad = loadChildFrame(ctx, target, f, req.sessionId);
        }

        const armedIframeGate = navigateOwesIframeInstalls(target);
        const {
          console: capturedConsole,
          cdpMutations,
          exceptions,
        } = await pushNavigateToPageScript(ctx, target, inlinedPageHtml, finalUrl, armedIframeGate);
        if (target.pageScript) releaseTargetDom(target);
        await backfillIframeOwnerNodeIds(target);
        emitFrameDclComplete(ctx, target, mainFrame(target), req.sessionId);
        scheduleLoadCompleteEmit(ctx, target, req.sessionId, armedIframeGate);
        emitExecutionContextCreated(ctx, target, req.sessionId);
        // Reset the DOM domain before delivering mutations from the new generation.
        emitDocumentUpdated(ctx, target, req.sessionId);
        emitCapturedConsole(ctx, target, capturedConsole, req.sessionId);
        emitCapturedExceptions(ctx, target, exceptions, req.sessionId);
        emitMutations(ctx, target, cdpMutations);
        if (target.pendingNavAbort === navAbort) target.pendingNavAbort = null;
        return navigateReply(target.frameId, loaderId);
      } catch (err) {
        const errorText = err instanceof Error ? err.message : String(err);
        return navigateReply(target.frameId, loaderId, errorText);
      }
    }

    case "Page.addScriptToEvaluateOnNewDocument": {
      const id = crypto.randomUUID();
      const source = typeof req.params?.source === "string" ? req.params.source : "";
      if (source) {
        ctx.browser.preNavScripts.set(id, source);
      }
      return { identifier: id };
    }

    case "Page.removeScriptToEvaluateOnNewDocument": {
      const id = typeof req.params?.identifier === "string" ? req.params.identifier : null;
      if (id) ctx.browser.preNavScripts.delete(id);
      return {};
    }

    case "Page.createIsolatedWorld": {
      const targetForIsoWorld = (() => {
        try {
          return resolveTarget(ctx, req.sessionId);
        } catch {
          return null;
        }
      })();
      const worldName = req.params?.worldName ?? "";
      const frameId = req.params?.frameId ?? targetForIsoWorld?.frameId ?? "";
      const existing = targetForIsoWorld?.isolatedWorlds?.find(
        (w) => w.name === worldName && w.frameId === frameId,
      );
      if (existing && existing.id > 0) {
        return { executionContextId: existing.id };
      }
      const id = ctx.browser.execContextSeq++;
      if (existing) {
        existing.id = id;
      } else if (targetForIsoWorld) {
        (targetForIsoWorld.isolatedWorlds ??= []).push({
          name: worldName,
          frameId,
          id,
        });
      }
      ctx.emit({
        method: "Runtime.executionContextCreated",
        params: {
          context: {
            id,
            origin: targetForIsoWorld ? originOf(targetForIsoWorld.url) : "",
            name: worldName,
            uniqueId: `cs-iso-${targetForIsoWorld?.targetId ?? "?"}-${id}`,
            auxData: {
              isDefault: false,
              type: "isolated",
              frameId,
            },
          },
        },
        sessionId: req.sessionId,
      });
      return { executionContextId: id };
    }

    case "Page.setBypassCSP":
    case "Page.stopLoading":
    case "Page.bringToFront":
    case "Page.handleJavaScriptDialog":
      return {};

    case "Page.setDocumentContent": {
      if (target.type !== "page") {
        return { error: "setDocumentContent requires a page target" };
      }
      const html = req.params?.html ?? "";
      const requestedUrl = target.url || "about:blank";
      const url = sanitizeBaseUrl(requestedUrl);
      target.url = url;
      target.html = html;
      releaseTargetDom(target);
      target.docCsp = null;
      target.docCspReportOnly = null;
      target.docCharset = null;
      // Scan every document, synthetic origin included: the scan is what puts its scripts
      // through the script gate and into the bundle.
      target.docScan = scanDocument(html);
      target.title = target.docScan.title;
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
      emitNavigationLifecycle(ctx, target, req.sessionId);
      emitExecutionContextCreated(ctx, target, req.sessionId);
      emitCapturedConsole(ctx, target, capturedConsole, req.sessionId);
      emitCapturedExceptions(ctx, target, exceptions, req.sessionId);
      emitMutations(ctx, target, cdpMutations);
      if (target.pageScript) releaseTargetDom(target);
      return {};
    }

    case "Page.captureScreenshot": {
      try {
        const reqFormat = req.params?.format;
        const format: "png" | "jpeg" | "webp" =
          reqFormat === "jpeg" ? "jpeg" : reqFormat === "webp" ? "webp" : "png";
        const reqQuality = req.params?.quality;
        const quality =
          typeof reqQuality === "number" && reqQuality >= 1 && reqQuality <= MAX_IMAGE_QUALITY
            ? reqQuality
            : DEFAULT_IMAGE_QUALITY;
        const omitBackground = req.params?.omitBackground === true;
        const clip = req.params?.clip;

        const pageUrl = target.url || "https://kitesurf.local/";
        if (target.pageScript) {
          const ps = target.pageScript;
          const __drainStart = Date.now();
          let drainInfo: Record<string, unknown> | null = null;
          let __graceTimer: ReturnType<typeof setTimeout> | null = null;
          const __clipRect = (() => {
            if (!clip || typeof clip !== "object") return null;
            const { x, y, width, height } = clip;
            return typeof x === "number" &&
              typeof y === "number" &&
              typeof width === "number" &&
              typeof height === "number"
              ? { x, y, width, height }
              : null;
          })();
          try {
            const drain = stubQueryDom(ps, "awaitPendingResources", {
              timeoutMs: RENDER_DRAIN_TIMEOUT_MS,
              scope: __clipRect
                ? {
                    mode: "rect",
                    x: __clipRect.x,
                    y: __clipRect.y,
                    w: __clipRect.width,
                    h: __clipRect.height,
                  }
                : { mode: "viewport" },
            }).catch(() => null);
            const drainResult = await traceSpan(
              ctx.env.HOST_TRACER,
              "screenshot.drain_resources",
              () =>
                Promise.race([
                  drain,
                  new Promise((resolve) => {
                    __graceTimer = setTimeout(
                      () => resolve({ raced: true }),
                      RENDER_DRAIN_TIMEOUT_MS + RENDER_DRAIN_GRACE_MS,
                    );
                  }),
                ]),
            );
            drainInfo = isRecord(drainResult) && !Array.isArray(drainResult) ? drainResult : null;
          } catch {
          } finally {
            clearTimerIfSet(__graceTimer);
          }
          const __drainMs = Date.now() - __drainStart;
          await captureOopifFrames(
            ctx,
            target,
            __drainStart + RENDER_DRAIN_TIMEOUT_MS + RENDER_DRAIN_GRACE_MS - Date.now(),
          );
          const __rpcStart = Date.now();
          const viaRenderer = await renderViaPageRenderer(ctx, target, {
            format,
            quality,
            omitBackground,
            ...(clip ? { clip } : {}),
            ...(ctx.browser.screencasts.has(target.targetId)
              ? {}
              : { partialKey: partialKeyFor(ctx, target) }),
          });
          const __rpcMs = Date.now() - __rpcStart;
          const __drainDetail =
            drainInfo &&
            (drainInfo.raced === true || drainInfo.timedOut === true || __drainMs > 2_000)
              ? ` drainDetail=${JSON.stringify(drainInfo)}`
              : "";
          if (ctx.browser.cdpDebug || __drainDetail !== "" || __drainMs + __rpcMs > 1_000) {
            console.log(
              `[screenshot] phases: drain=${__drainMs}ms render=${__rpcMs}ms url=${target.url ?? "?"}${__drainDetail}`,
            );
          }
          if ("failed" in viaRenderer) {
            throw new Error(`Page.captureScreenshot failed: ${viaRenderer.failed}`);
          }
          if (viaRenderer.bytes && viaRenderer.bytes.length > 0) {
            return { data: bytesToBase64(viaRenderer.bytes) };
          }
          throw new Error("Page.captureScreenshot failed: renderer returned no bytes");
        }

        let html: string | null = null;
        const leased = ensureTargetDom(target);
        if (leased) {
          const epochAtLease = target.domEpoch;
          target.dom = null;
          try {
            await inlineStylesheets(
              leased,
              pageUrl,
              ctx.browser.sandboxOutbound,
              ctx.connectionId,
              {
                cache: ctx.browser.styleCache,
                tracker: ctx.browser.networkEvents,
                loaderId: target.loaderId,
                frameId: target.frameId,
              },
            );
            html = leased.outerHTML(0);
          } finally {
            returnScreenshotDomLease(target, leased, epochAtLease);
          }
        }
        if (!html) {
          return { data: TINY_TRANSPARENT_PNG_B64 };
        }
        const width = target.viewportWidth ?? DEFAULT_VIEWPORT_WIDTH;
        const height = target.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT;
        const { renderHtmlToImage } = await import("../wasm.ts");
        const bytes = renderHtmlToImage(html, pageUrl, width, height, format, quality);
        if (bytes.length === 0) {
          return {
            data: TINY_TRANSPARENT_PNG_B64,
            error: "renderHtmlToImage returned empty",
          };
        }
        return { data: bytesToBase64(bytes) };
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Page.captureScreenshot failed:")) {
          throw err;
        }
        return {
          data: TINY_TRANSPARENT_PNG_B64,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    case "Page.printToPDF": {
      try {
        const inchToPx = 96;
        const paperWidthIn =
          typeof req.params?.paperWidth === "number" && req.params.paperWidth > 0
            ? req.params.paperWidth
            : DEFAULT_PDF_PAPER_WIDTH_INCHES;
        const paperHeightIn =
          typeof req.params?.paperHeight === "number" && req.params.paperHeight > 0
            ? req.params.paperHeight
            : DEFAULT_PDF_PAPER_HEIGHT_INCHES;
        const landscape = req.params?.landscape === true;
        const preferCSSPageSize = req.params?.preferCSSPageSize === true;
        const omitBackground = req.params?.omitBackground === true;
        const readMarginIn = (v: unknown) =>
          typeof v === "number" && Number.isFinite(v) && v > 0
            ? Math.min(v, MAX_PDF_MARGIN_INCHES) * inchToPx
            : 0;
        const printBackground = req.params?.printBackground === true;
        const pdfLayout: PdfPageLayout = {
          width: Math.round(paperWidthIn * inchToPx),
          height: Math.round(paperHeightIn * inchToPx),
          cssPageSize: false,
          marginTopPx: readMarginIn(req.params?.marginTop),
          marginRightPx: readMarginIn(req.params?.marginRight),
          marginBottomPx: readMarginIn(req.params?.marginBottom),
          marginLeftPx: readMarginIn(req.params?.marginLeft),
        };

        if (!target.pageScript) {
          return {
            data: EMPTY_PDF_B64,
            error: "no PageScript for target (PDF requires live paint dom)",
          };
        }
        const pdfPs = target.pageScript;
        const prevMedia = target.emulatedMedia;
        if (prevMedia !== "print") {
          try {
            await stubQueryDom(pdfPs, "setMediaType", {
              media: "print",
              quiet: true,
            });
            target.emulatedMedia = "print";
          } catch {}
        }
        try {
          const pbResp = await stubQueryDom(pdfPs, "pageBoxJson", {});
          if (pbResp?.ok && typeof pbResp.json === "string") {
            applyPdfPageBoxJson(pbResp.json, preferCSSPageSize, pdfLayout);
          }
        } catch {}
        if (landscape && !pdfLayout.cssPageSize) {
          const tmp = pdfLayout.width;
          pdfLayout.width = pdfLayout.height;
          pdfLayout.height = tmp;
        }
        {
          let pdfGraceTimer: ReturnType<typeof setTimeout> | null = null;
          try {
            await traceSpan(ctx.env.HOST_TRACER, "pdf.drain_resources", () =>
              Promise.race([
                stubQueryDom(pdfPs, "awaitPendingResources", {
                  timeoutMs: RENDER_DRAIN_TIMEOUT_MS,
                  upgradeFonts: true,
                }).catch(() => null),
                new Promise((resolve) => {
                  pdfGraceTimer = setTimeout(
                    () => resolve(null),
                    RENDER_DRAIN_TIMEOUT_MS + RENDER_DRAIN_GRACE_MS,
                  );
                }),
              ]),
            );
          } catch {
          } finally {
            clearTimerIfSet(pdfGraceTimer);
          }
        }
        let bgSuppressed = false;
        if (!printBackground) {
          try {
            const r = await stubQueryDom(pdfPs, "setSuppressBackgrounds", {
              enabled: true,
            });
            bgSuppressed = r?.ok === true;
          } catch {}
        }
        try {
          const manager = getRendererManager(ctx, target);
          const viaRenderer = await traceSpan(ctx.env.HOST_TRACER, "render.pdf", () =>
            manager.renderPdf(pdfPs, {
              paperWidth: pdfLayout.width,
              paperHeight: pdfLayout.height,
              omitBackground,
              marginTop: pdfLayout.marginTopPx,
              marginRight: pdfLayout.marginRightPx,
              marginBottom: pdfLayout.marginBottomPx,
              marginLeft: pdfLayout.marginLeftPx,
              scope: renderScope(target),
            }),
          );
          if (viaRenderer.ok && viaRenderer.bytes && viaRenderer.bytes.length > 0) {
            return { data: bytesToBase64(viaRenderer.bytes) };
          }
          return {
            data: EMPTY_PDF_B64,
            error: viaRenderer.error ?? "pageRenderer returned no bytes",
          };
        } catch (err) {
          return {
            data: EMPTY_PDF_B64,
            error: err instanceof Error ? err.message : String(err),
          };
        } finally {
          await restorePdfState(target, prevMedia, bgSuppressed);
        }
      } catch (err) {
        return {
          data: EMPTY_PDF_B64,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    case "Page.startScreencast": {
      const existing = ctx.browser.screencasts.get(target.targetId);
      const reqFormat = req.params?.format;
      const format: "png" | "jpeg" =
        reqFormat === "png" || reqFormat === "jpeg" ? reqFormat : "jpeg";
      const quality = clampInt(req.params?.quality, 1, MAX_IMAGE_QUALITY, DEFAULT_IMAGE_QUALITY);
      const { width: maxWidth, height: maxHeight } = clampViewport(
        clampInt(req.params?.maxWidth, MIN_SCREENCAST_DIMENSION, MAX_SIDE, DEFAULT_VIEWPORT_WIDTH),
        clampInt(
          req.params?.maxHeight,
          MIN_SCREENCAST_DIMENSION,
          MAX_SIDE,
          DEFAULT_VIEWPORT_HEIGHT,
        ),
      );
      const everyNthFrame = clampInt(
        req.params?.everyNthFrame,
        1,
        MAX_SCREENCAST_EVERY_NTH_FRAME,
        1,
      );
      const minFrameIntervalMs = clampInt(
        req.params?.minFrameIntervalMs,
        MIN_SCREENCAST_FRAME_INTERVAL_MS,
        MAX_SCREENCAST_FRAME_INTERVAL_MS,
        POLL_INTERVAL_MS,
      );
      const maxInFlight = clampInt(
        req.params?.maxFramesInFlight ?? req.params?.maxInFlight,
        1,
        MAX_SCREENCAST_FRAMES_IN_FLIGHT,
        1,
      );
      const nextOwner = req.sessionId || undefined;
      const configurationVersion = ++target.screencastConfigurationVersion;
      const state: ScreencastState = existing ?? {
        format,
        quality,
        maxWidth,
        maxHeight,
        everyNthFrame,
        pollIntervalMs: minFrameIntervalMs,
        maxInFlight,
        wheelQueue: getWheelQueue(ctx.browser, target.targetId, nextOwner),
        ownerSessionId: nextOwner,
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

      let formerDrain: Promise<unknown> | null = null;
      if (existing && existing.ownerSessionId !== nextOwner) {
        const formerOwner = existing.ownerSessionId;
        const formerQueues = [...findWheelQueues(ctx.browser, target.targetId, formerOwner)];
        for (const formerQueue of formerQueues) {
          moveWheelQueue(ctx.browser, target.targetId, formerOwner, nextOwner, formerQueue);
        }
        const drains = formerQueues.map((formerQueue) =>
          formerQueue.stop().then(() => {
            removeWheelQueue(ctx.browser, target.targetId, nextOwner, formerQueue);
          }),
        );
        existing.ownerSessionId = nextOwner;
        existing.wheelQueue = getWheelQueue(ctx.browser, target.targetId, nextOwner);
        existing.lastAckedSeq = existing.frameSeq;
        existing.pendingAckSessionId = null;
        existing.pendingAckSetAt = 0;
        const drainBarrier = Promise.all(drains);
        setWheelHandoffDrain(ctx.browser, target.targetId, formerOwner, drainBarrier);
        formerDrain = drainBarrier;
      }

      const previousConfiguration = target.screencastConfigurationBarrier;
      let releaseConfiguration!: () => void;
      target.screencastConfigurationBarrier = new Promise<void>((resolve) => {
        releaseConfiguration = resolve;
      });
      await previousConfiguration;
      try {
        if (
          state.stopped ||
          ctx.browser.wsClosing ||
          ctx.browser.targets.get(target.targetId) !== target ||
          ctx.browser.screencasts.get(target.targetId) !== state
        )
          return {};
        if (target.screencastConfigurationVersion !== configurationVersion) {
          if (formerDrain) await formerDrain;
          return {};
        }

        target.viewportWidth = maxWidth;
        target.viewportHeight = maxHeight;
        if (target.pageScript) {
          try {
            await stubQueryDom(target.pageScript, "setViewport", {
              width: maxWidth,
              height: maxHeight,
            });
          } catch {}
        }
        if (formerDrain) await formerDrain;
        if (
          state.stopped ||
          ctx.browser.wsClosing ||
          ctx.browser.targets.get(target.targetId) !== target ||
          ctx.browser.screencasts.get(target.targetId) !== state ||
          target.screencastConfigurationVersion !== configurationVersion
        )
          return {};

        state.format = format;
        state.quality = quality;
        state.maxWidth = maxWidth;
        state.maxHeight = maxHeight;
        state.everyNthFrame = everyNthFrame;
        state.pollIntervalMs = minFrameIntervalMs;
        state.maxInFlight = maxInFlight;
        state.lastRenderedMutationSeq = -1;
        state.appliedConfigurationVersion = configurationVersion;
        state.wake?.();

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

    case "Page.stopScreencast": {
      const state = ctx.browser.screencasts.get(target.targetId);
      if (state && state.ownerSessionId === (req.sessionId || undefined)) {
        state.stopped = true;
        state.wake?.();
        stopAndRemoveWheelQueue(
          ctx.browser,
          target.targetId,
          state.ownerSessionId,
          state.wheelQueue,
        );
        ctx.browser.screencasts.delete(target.targetId);
      }
      return {};
    }

    case "Page.screencastFrameAck": {
      const state = ctx.browser.screencasts.get(target.targetId);
      if (!state) return {};
      const rawAckId = req.params?.sessionId ?? -1;
      const ackId =
        typeof rawAckId === "number" && Number.isInteger(rawAckId)
          ? Math.min(rawAckId, state.frameSeq)
          : -1;
      target.screencastAckCount = (target.screencastAckCount ?? 0) + 1;
      if (target.screencastAckCount % 5 === 1) {
        console.log(
          `[kitesurf-screencast] ack #${target.screencastAckCount} ` +
            `ackId=${ackId} pendingAck=${state.pendingAckSessionId} ` +
            `frameSeq=${state.frameSeq}`,
        );
      }
      if (state.pendingAckSessionId !== null && ackId >= state.pendingAckSessionId) {
        state.pendingAckSessionId = null;
        state.pendingAckSetAt = 0;
      }
      if (ackId > state.lastAckedSeq) state.lastAckedSeq = ackId;
      state.wake?.();
      return {};
    }

    default:
      return {};
  }
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
  target.wheelTeardownDepth += 1;
  const consoleAcc: ConsoleEntry[] = [];
  try {
    await cancelAndRemoveTargetWheelQueues(ctx.browser, target.targetId);

    if (target.pageScript) {
      const harvest = await retireStub(target, "navigate", "Page.navigate: generation bump", {
        budget: ctx.browser.workerBudget,
      });
      for (const e of harvest?.console ?? []) consoleAcc.push(e);
      if (target.pageScriptUrl) {
        for (const raw of harvest?.cookieWrites ?? []) {
          jarForTarget(ctx, target).setFromDocumentCookie(target.pageScriptUrl, raw);
        }
      }
    }
  } finally {
    target.wheelTeardownDepth -= 1;
  }

  // Invalidate late-result checks before clearing per-document state.
  target.navigateGeneration += 1;
  const generation = target.navigateGeneration;
  const currentStream = ctx.browser.screencasts.get(target.targetId);
  if (currentStream && !currentStream.wheelQueue.isAccepting) {
    currentStream.wheelQueue = getWheelQueue(
      ctx.browser,
      target.targetId,
      currentStream.ownerSessionId,
    );
  }
  target.lastLoadAt = 0;
  dropTargetImages(ctx.connectionId, target.targetId);
  target.compiledScripts.length = 0;
  clearStyleSheetsForNavigate(ctx, target);
  clearToolsForNavigate(ctx, target);

  const raPreSpawnWaitMs = ctx.analytics.sessionAgeMs();
  const raBakeStart = ctx.analytics.now();
  let scriptDescriptors: ParentScriptDescriptor[] = [];
  let scriptBundle: ScriptBundle | null = null;
  let wasmBake: WasmBake | null = null;
  try {
    const raw = target.docScan
      ? target.docScan.scripts
      : extractScriptDescriptorsFromDom(target.dom);
    const preNav: ParentScriptDescriptor[] = [];
    if (ctx.browser.preNavScripts.size > 0) {
      for (const source of ctx.browser.preNavScripts.values()) {
        preNav.push({
          src: null,
          kind: "classic",
          defer: false,
          async: false,
          body: source,
          injected: true,
        });
      }
    }
    const rawWithPreNav = preNav.length > 0 ? [...preNav, ...raw] : raw;
    const scriptGate = documentGateContext(url, {
      csp: target.docCsp,
      cspReportOnly: target.docCspReportOnly,
      scan: target.docScan,
    });
    const scriptBaseUrl = documentBaseUrl(url, target.docScan?.baseHref);
    const gatedDescriptors = await traceSpan(ctx.env.HOST_TRACER, "navigate.script_gate", () =>
      applyPreFetchScriptGate(rawWithPreNav, scriptGate, scriptBaseUrl),
    );
    for (const d of gatedDescriptors) {
      if (!d.blocked) continue;
      console.warn(
        `[kitesurf-csp] blocked (${d.blocked.reason}) ${d.src ?? "inline"}: ` + d.blocked.message,
      );
    }
    const learnedUrls = learnedScriptsFor(
      ctx.browser.learnedInsertedScripts,
      url,
      target.browserContextId,
    );
    const afterClassicPrefetch = await traceSpan(
      ctx.env.HOST_TRACER,
      "navigate.prefetch_scripts",
      () =>
        prefetchExternalScripts({
          descriptors: gatedDescriptors,
          pageUrl: url,
          connectionId: ctx.connectionId,
          mainFrameId: target.frameId,
          mainLoaderId: target.loaderId,
          extraHeaders: effectiveExtraHeaders(target),
          cookieKey: cookieKeyFor(ctx.connectionId, target.browserContextId),
          baseUrl: scriptBaseUrl,
          sandboxOutbound: ctx.browser.sandboxOutbound,
          gate: scriptGate,
        }),
    );
    const routeChunkUrls = nextRouteChunkUrls(afterClassicPrefetch, url).filter(
      (u) => !learnedUrls.includes(u),
    );
    const speculativeUrls = [...learnedUrls, ...routeChunkUrls];
    const speculativePrefetch =
      speculativeUrls.length === 0
        ? Promise.resolve<ParentScriptDescriptor[]>([])
        : traceSpan(ctx.env.HOST_TRACER, "navigate.prefetch_speculative", () =>
            applyPreFetchScriptGate(
              speculativeUrls.map((src) => ({
                src,
                kind: "classic",
                defer: false,
                async: false,
                body: "",
              })),
              scriptGate,
              scriptBaseUrl,
            ).then((gated) =>
              prefetchBestEffort(
                gated.filter(
                  (d) => !d.blocked && maySpeculate(ctx.connectionId, d.resolvedSrc ?? d.src ?? ""),
                ),
                (d, signal) =>
                  prefetchExternalScripts({
                    descriptors: [d],
                    pageUrl: url,
                    connectionId: "",
                    mainFrameId: target.frameId,
                    mainLoaderId: target.loaderId,
                    extraHeaders: effectiveExtraHeaders(target),
                    cookieKey: "",
                    baseUrl: scriptBaseUrl,
                    sandboxOutbound: ctx.browser.sandboxOutbound,
                    signal,
                    gate: scriptGate,
                  }).then((fetched) => fetched[0] ?? d),
              ),
            ),
          ).catch((): ParentScriptDescriptor[] => []);
    const importMaps = await applyImportMapGate(target.docScan?.importMaps ?? [], scriptGate, url);
    const walkResult = await traceSpan(ctx.env.HOST_TRACER, "navigate.walk_module_graph", () =>
      walkModuleGraph({
        descriptors: afterClassicPrefetch,
        pageUrl: url,
        connectionId: ctx.connectionId,
        mainFrameId: target.frameId,
        mainLoaderId: target.loaderId,
        extraHeaders: effectiveExtraHeaders(target),
        cookieKey: cookieKeyFor(ctx.connectionId, target.browserContextId),
        options: {
          baseUrl: scriptBaseUrl,
          gate: scriptGate,
          importMaps,
          moduleSeeds: astroIslandModuleUrls(html, scriptBaseUrl),
          preloadSeeds: modulePreloadSeeds(html, scriptBaseUrl),
          documentHtml: html,
        },
        sandboxOutbound: ctx.browser.sandboxOutbound,
      }),
    );
    scriptDescriptors = walkResult.descriptors;
    const speculativeFetched = await speculativePrefetch;
    const learnedSet = new Set(learnedUrls);
    for (const d of speculativeFetched) {
      if (d.src && learnedSet.has(d.src) && (d.prefetchError || d.blocked)) {
        forgetLearnedScript(
          ctx.browser.learnedInsertedScripts,
          url,
          d.src,
          target.browserContextId,
        );
      }
    }
    const insertedBake = speculativeFetched.filter(
      (d) => typeof d.prefetchedSource === "string" && !d.prefetchError && !d.blocked,
    );
    if (ctx.browser.cdpDebug && speculativeUrls.length > 0) {
      console.log(
        `[kitesurf-nav] speculative scripts baked ${insertedBake.length}/${speculativeUrls.length}`,
      );
    }
    const insertedDigests = await insertedSourceDigests(insertedBake);
    scriptBundle = traceSpan(ctx.env.HOST_TRACER, "navigate.build_bundle", () =>
      buildScriptBundle(scriptDescriptors, {
        cdpDebug: ctx.browser.cdpDebug,
        additionalModules: walkResult.additionalModules,
        importMapModuleSource: walkResult.importMapModuleSource,
        insertedBake,
        insertedDigests,
      }),
    );
    try {
      const wasmScanSources: Array<{ body: string; baseUrl: string }> = [];
      for (const d of scriptDescriptors) {
        if (!d.src && d.body) {
          wasmScanSources.push({ body: d.body, baseUrl: url });
        } else if (d.src && d.prefetchedSource) {
          wasmScanSources.push({
            body: d.prefetchedSource,
            baseUrl: d.resolvedSrc ?? url,
          });
        }
      }
      for (const [modUrl, baked] of Object.entries(walkResult.additionalModules)) {
        if (typeof baked === "string") {
          wasmScanSources.push({ body: baked, baseUrl: modUrl });
        }
      }
      const wasmUrls = traceSpan(
        ctx.env.HOST_TRACER,
        "navigate.scan_wasm_literals",
        () => scanForWasmUrls(wasmScanSources),
        { sources: wasmScanSources.length },
      );
      const inlineWasm = traceSpan(ctx.env.HOST_TRACER, "navigate.scan_inline_wasm", () =>
        scanForInlineWasm(wasmScanSources),
      );
      if (wasmUrls.length > 0 || inlineWasm.length > 0) {
        const prefetchedWasmBake = await traceSpan(
          ctx.env.HOST_TRACER,
          "navigate.prefetch_wasm",
          () =>
            prefetchWasmModules({
              urls: wasmUrls,
              pageUrl: url,
              connectionId: ctx.connectionId,
              mainFrameId: target.frameId,
              mainLoaderId: target.loaderId,
              extraHeaders: effectiveExtraHeaders(target),
              cookieKey: cookieKeyFor(ctx.connectionId, target.browserContextId),
              sandboxOutbound: ctx.browser.sandboxOutbound,
            }),
          { count: wasmUrls.length },
        );
        wasmBake = prefetchedWasmBake;
        if (inlineWasm.length > 0) {
          await traceSpan(
            ctx.env.HOST_TRACER,
            "navigate.bake_inline_wasm",
            () => bakeInlineWasm(inlineWasm, prefetchedWasmBake),
            { count: inlineWasm.length },
          );
        }
        const okCount = Object.keys(prefetchedWasmBake.modules).length;
        const errs = Object.entries(prefetchedWasmBake.errors)
          .map(([u, e]) => `${u}: ${e.slice(0, MAX_NAVIGATION_ERROR_PREVIEW_CHARS)}`)
          .slice(0, MAX_NAVIGATION_ERROR_SAMPLES);
        console.log(
          `[kitesurf-nav] wasm bake: discovered=${wasmUrls.length} ` +
            `inline=${inlineWasm.length} baked=${okCount}` +
            (errs.length ? ` errors=[${errs.join(" | ")}]` : ""),
        );
      }
    } catch (err) {
      console.warn(
        "[kitesurf-nav] wasm bake threw (non-fatal):",
        err instanceof Error ? err.message : String(err),
      );
      wasmBake = null;
    }
    traceSpan(ctx.env.HOST_TRACER, "navigate.register_bundle", () =>
      registerBundleScripts(ctx, target, scriptBundle),
    );
  } catch (err) {
    console.warn(
      "[kitesurf-nav] script descriptor extraction/prefetch threw:",
      err instanceof Error ? err.message : String(err),
    );
    scriptDescriptors = [];
    scriptBundle = null;
  }

  try {
    let totalScripts = scriptDescriptors.length;
    let inlineScripts = 0;
    let externalOk = 0;
    let externalErr = 0;
    const errSamples: string[] = [];
    for (const d of scriptDescriptors) {
      if (!d.src) {
        inlineScripts++;
        continue;
      }
      if (d.prefetchError) {
        externalErr++;
        if (errSamples.length < MAX_NAVIGATION_ERROR_SAMPLES) {
          errSamples.push(
            `${d.src}: ${d.prefetchError.slice(0, MAX_NAVIGATION_ERROR_PREVIEW_CHARS)}`,
          );
        }
        continue;
      }
      if (d.prefetchedSource) externalOk++;
    }
    const errsSuffix = externalErr > 0 ? ` errors=[${errSamples.join(" | ")}]` : "";
    console.log(
      `[kitesurf-nav] url=${url} scripts: total=${totalScripts} inline=${inlineScripts} ext-ok=${externalOk} ext-err=${externalErr}${errsSuffix}`,
    );
    if (ctx.browser.cdpDebug) {
      for (let i = 0; i < scriptDescriptors.length; i++) {
        const d = scriptDescriptors[i];
        if (!d) continue;
        const srcLen = d.prefetchedSource ? d.prefetchedSource.length : 0;
        const bodyLen = d.body ? d.body.length : 0;
        const errSnippet = d.prefetchError
          ? d.prefetchError.slice(0, MAX_CDP_DEBUG_ERROR_PREVIEW_CHARS)
          : "";
        console.log(
          `[kitesurf-nav] script #${i}: src=${JSON.stringify(d.src)} ` +
            `kind=${d.kind} defer=${d.defer} async=${d.async} ` +
            `srcLen=${srcLen} bodyLen=${bodyLen}` +
            (errSnippet ? ` err="${errSnippet}"` : ""),
        );
      }
      console.log(
        `[kitesurf-nav] htmlPreview length=${target.html.length} ` +
          `first200=${JSON.stringify(target.html.slice(0, 200))}`,
      );
    }
    if (scriptBundle) {
      const reg = scriptBundle.classicRegularSource?.length ?? 0;
      const asy = scriptBundle.classicAsyncSource?.length ?? 0;
      const mods = scriptBundle.moduleScriptUrls?.length ?? 0;
      const extra = Object.keys(scriptBundle.additionalModules ?? {}).length;
      console.log(
        `[kitesurf-nav] bundle: regular=${reg}chars async=${asy}chars ` +
          `modules=${mods} (${extra} baked)`,
      );
    } else {
      console.log("[kitesurf-nav] bundle: null (extraction/prefetch failed)");
    }
  } catch (err) {
    console.warn(
      "[kitesurf-nav] log-summary threw (non-fatal):",
      err instanceof Error ? err.message : String(err),
    );
  }

  // The bundle and prefetch awaits above can outlast the connection or be overtaken by a newer
  // navigate; either way, load no isolate for this one.
  if (ctx.browser.wsClosing || target.navigateGeneration !== generation) {
    return { console: consoleAcc };
  }
  const raInitTimings: PageScriptInitTimings = {};
  let pendingPageScript: ReturnType<typeof getOrCreatePageScript> | null;
  try {
    pendingPageScript = traceSpan(
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
          startupInput: {
            html,
            url,
            cookies: jarForTarget(ctx, target).documentCookieString(url),
            scriptDescriptors,
            scriptBundle,
            wasmBake,
            cdpDebug: ctx.browser.cdpDebug,
            pixelFree: ctx.browser.skipSpeculativeRaster,
            fontDefer: ctx.browser.fontDefer,
            userAgent: target.userAgentOverride || null,
            referrerPolicy: target.docReferrerPolicy ?? null,
            referrer: target.docReferrer ?? null,
            csp: target.docCsp ? [target.docCsp] : [],
            metaCsp: target.docScan?.metaCsp ?? [],
          },
          attributionHeaders: ctx.browser.attributionHeaders,
          mainLoaderId: target.loaderId,
          extraHeaders: effectiveExtraHeaders(target),
          initTimings: raInitTimings,
          capOverrides: ctx.browser.isolateCapOverrides,
          sandboxOutbound: ctx.browser.sandboxOutbound,
        }),
      { generation },
    );
  } catch (err) {
    console.warn(
      "[kitesurf-nav] getOrCreatePageScript threw:",
      err instanceof Error ? err.message : String(err),
    );
    return { console: consoleAcc };
  }

  const raBakeMs = ctx.analytics.now() - raBakeStart;

  if (pendingPageScript) {
    installUpstreamEventHandler(ctx, target, pendingPageScript, generation, url);
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

  try {
    const initialCookies = jarForTarget(ctx, target).documentCookieString(url);
    const ps = pendingPageScript;
    const raNavStart = ctx.analytics.now();
    const summary = await traceSpan(ctx.env.HOST_TRACER, "init.pagescript_navigate", async (s) => {
      const tracer = ctx.env.HOST_TRACER;
      const traced = !!(s && s.isRecording && tracer);
      if (traced && tracer) {
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
      }
      const navPromise = ps.navigate(html, url, {
        cookies: initialCookies,
        ...(traced ? { traced: true } : {}),
        expectIframeInstalls: owesIframeInstalls,
        ...(target.docCharset ? { charset: target.docCharset } : {}),
        ...(ctx.browser.darkColorScheme !== undefined
          ? { darkColorScheme: ctx.browser.darkColorScheme }
          : {}),
        ...(ctx.browser.ttyUaCss
          ? {
              ttyUaCss: ctx.browser.ttyUaCss,
              ttyCellW: ctx.browser.ttyCellW ?? DEFAULT_TTY_CELL_WIDTH_PX,
              ttyCellH: ctx.browser.ttyCellH ?? DEFAULT_TTY_CELL_HEIGHT_PX,
              ttyCss: ttyUaStylesheet(
                ctx.browser.ttyUaCss,
                ctx.browser.ttyCellH ?? DEFAULT_TTY_CELL_HEIGHT_PX,
                ctx.browser.ttyCellW ?? DEFAULT_TTY_CELL_WIDTH_PX,
              ),
            }
          : ctx.browser.ttyKeyboard
            ? { ttyCss: ttyFocusStylesheet }
            : {}),
        connectionId: ctx.connectionId,
        mainFrameId: target.frameId,
        cookieKey: cookieKeyFor(ctx.connectionId, target.browserContextId),
        bindingNames:
          ctx.browser.pendingBindings.size > 0
            ? Array.from(ctx.browser.pendingBindings)
            : undefined,
        ...(target.viewportWidth != null && target.viewportHeight != null
          ? {
              viewportWidth: target.viewportWidth,
              viewportHeight: target.viewportHeight,
            }
          : {}),
      });
      ps.armAwaitLoad?.();

      const sum = await navPromise;
      const ph = sum.phases;
      if (s && ph && typeof ph === "object") {
        const tags: Record<string, string | number | boolean> = {};
        for (const [k, v] of Object.entries(ph)) {
          if (typeof v === "number") tags["phase." + k] = v;
        }
        s.setTags(tags);
      }
      return sum;
    });

    if (target.navigateGeneration !== generation) {
      await disposeStub(
        pendingPageScript,
        { unload: "awaited", reason: "Page.navigate: superseded" },
        { budget: ctx.browser.workerBudget },
      );
      return { console: consoleAcc };
    }

    try {
      const consoleCount = summary.console?.length ?? 0;
      const mutationsCount = summary.cdpMutations?.length ?? 0;
      const cookieWritesCount = summary.cookieWrites?.length ?? 0;
      const firstError = firstConsoleWarningOrError(summary.console);
      const errSuffix = firstError ? ` firstError="${firstError}"` : "";
      const bundleExec = summary.bundleExec;
      const bundleExecSuffix =
        bundleExec && bundleExec.length > 0 ? ` bundleExec=${JSON.stringify(bundleExec)}` : "";
      const fontDegraded = summary.fontDegradedReads ?? 0;
      const fontDegradedSuffix = fontDegraded > 0 ? ` fontDegradedReads=${fontDegraded}` : "";
      console.log(
        `[kitesurf-nav] done url=${url} consoleEntries=${consoleCount} mutations=${mutationsCount} cookieWrites=${cookieWritesCount}${errSuffix}${bundleExecSuffix}${fontDegradedSuffix}`,
      );
    } catch (err) {
      console.warn(
        "[kitesurf-nav] post-navigate log threw (non-fatal):",
        err instanceof Error ? err.message : String(err),
      );
    }

    if (summary.console) {
      for (const e of summary.console) consoleAcc.push(e);
    }
    if (summary.cookieWrites && summary.cookieWrites.length > 0) {
      for (const raw of summary.cookieWrites) {
        jarForTarget(ctx, target).setFromDocumentCookie(url, raw);
      }
    }
    const cdpMutations =
      summary.cdpMutations && summary.cdpMutations.length > 0 ? summary.cdpMutations : undefined;

    const phases = summary.phases;
    if (phases && typeof phases === "object") {
      target.lastNavigatePhases = phases;
    }

    {
      const raNavMs = ctx.analytics.now() - raNavStart;
      const wsUpgradeMs = raInitTimings.wsUpgradeMs ?? 0;
      const ph = (k: string): number => {
        const v = phases?.[k];
        return typeof v === "number" && Number.isFinite(v) ? v : 0;
      };
      emitSessionStart(ctx.analytics, {
        totalMs: ctx.analytics.sessionAgeMs(),
        preSpawnWaitMs: raPreSpawnWaitMs,
        bakeMs: raBakeMs,
        wsUpgradeMs,
        navRpcMs: Math.max(0, raNavMs - wsUpgradeMs),
        parseMs: ph("parseMs"),
        shimMs: ph("shimMs"),
        fontsMs: ph("fontsMs"),
        regularScriptsMs: ph("regularScriptsMs"),
        moduleScriptsMs: ph("moduleScriptsMs"),
        teardownMs: ph("teardownMs"),
        spawnKind: "navigate",
        host: pageScriptOriginOf(url),
      });
    }

    if (target.viewportWidth != null && target.viewportHeight != null) {
      try {
        await stubQueryDom(pendingPageScript, "setViewport", {
          width: target.viewportWidth,
          height: target.viewportHeight,
        });
      } catch {}
    }

    if (target.layoutMode && target.layoutMode !== "full") {
      try {
        await stubQueryDom(pendingPageScript, "setLayoutMode", {
          mode: target.layoutMode,
        });
      } catch {}
    }

    // Keep the replacement private until its initial navigation and viewport setup finish.
    if (
      !publishStub(
        target,
        pendingPageScript,
        {
          isStale: () => target.navigateGeneration !== generation,
          reason: "Page.navigate: superseded",
        },
        { budget: ctx.browser.workerBudget },
      )
    ) {
      return { console: consoleAcc };
    }
    ctx.browser.screencasts.get(target.targetId)?.wake?.();
    // Wake an RBI stream waiting on this target's new generation as well.
    wakeSceneStream(ctx.browser, target.targetId);
    // New isolates default to screen; restore print mode before the new cascade.
    if (target.emulatedMedia === "print") {
      try {
        await stubQueryDom(pendingPageScript, "setMediaType", {
          media: "print",
        });
      } catch {}
    }
    if (target.domEnabledSessions.size > 0) {
      try {
        await stubQueryDom(pendingPageScript, "setCdpDomActive", {
          active: true,
        });
      } catch {}
    }
    if (target.cssEnabledSessions.size > 0 || ctx.browser.connectionMode === "page") {
      try {
        await syncStyleSheetsFromEnumeration(ctx, target, pendingPageScript);
      } catch {}
    }
    return {
      console: consoleAcc,
      phases: target.lastNavigatePhases ?? undefined,
      cdpMutations,
      exceptions: summary.exceptions,
    };
  } catch (err) {
    console.warn(
      "[kitesurf-nav] PageScript.navigate threw:",
      err instanceof Error ? err.message : String(err),
    );
    if (pendingPageScript && target.pageScript !== pendingPageScript) {
      await disposeStub(
        pendingPageScript,
        { unload: "awaited", reason: "Page.navigate: navigate threw" },
        { budget: ctx.browser.workerBudget },
      );
    } else if (pendingPageScript) {
      try {
        await pendingPageScript.unload();
      } catch {}
    }
    // Reporting success here leaves a target with no page, and its next DOM call starts a blank
    // isolate that answers as this document, so a failed load is served as an empty page.
    if (target.navigateGeneration === generation && !target.pageScript) throw err;
    return { console: consoleAcc };
  }
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
  const sessions = target.debuggerEnabledSessions;
  const emit = (meta: ReturnType<typeof makeCompiledScriptMeta>) => {
    target.compiledScripts.push(meta);
    if (hasDebuggerListeners(target)) {
      for (const sid of sessions) {
        emitScriptParsed(
          ctx,
          meta,
          sid === "" ? undefined : sid,
          target.frameId,
          target.defaultContextId || undefined,
        );
      }
    }
  };
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
  for (let i = 0; i < bundle.moduleScriptUrls.length; i++) {
    const moduleUrl = bundle.moduleScriptUrls[i] ?? "";
    if (!moduleUrl) continue;
    const src = bundle.additionalModules[moduleUrl];
    if (typeof src !== "string" || !src) continue;
    emit(
      makeCompiledScriptMeta("bundle:module-" + i, src, moduleUrl, {
        source: src,
        isModule: true,
      }),
    );
  }
}

function emitCapturedExceptions(
  ctx: DispatchCtx,
  target: TargetState,
  entries: ExceptionEntry[] | undefined,
  sessionId: string | undefined,
): void {
  if (!entries || entries.length === 0) return;
  const sessions = targetSessions(target, sessionId);
  for (const entry of entries) {
    const id = ++exceptionIdSeq;
    const ev = exceptionEntryToCdpEvent(entry, id, target.defaultContextId || 1);
    for (const s of sessions) {
      ctx.emit({ method: ev.method, params: ev.params, sessionId: s });
    }
  }
}

let exceptionIdSeq = 0;

export function mainFrame(t: TargetState): FrameState {
  const main = t.frames.get(t.frameId);
  if (main) return main;
  return makeMainFrameState({ frameId: t.frameId, loaderId: t.loaderId, url: t.url });
}

// Chrome includes isDownload in every Page.navigate reply, and Playwright reads it. Kitesurf
// aborts a response Chrome would download (net::ERR_ABORTED), so it never reports a download.
function navigateReply(
  frameId: string,
  loaderId: string,
  errorText?: string,
): Protocol.Page.NavigateResponse {
  return errorText === undefined
    ? { frameId, loaderId, isDownload: false }
    : { frameId, loaderId, errorText, isDownload: false };
}

function navErrorText(err: unknown, aborted: boolean): string | null {
  if (aborted) return "net::ERR_ABORTED";
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  if (name === "AbortError" || /\baborted\b/i.test(msg)) return "net::ERR_ABORTED";
  if (name === "InvalidRedirectError") return "net::ERR_INVALID_REDIRECT";
  if (/refused|ECONNREFUSED|network connection lost/i.test(msg)) {
    return "net::ERR_CONNECTION_REFUSED";
  }
  if (/ENOTFOUND|name not resolved|could not resolve|dns/i.test(msg)) {
    return "net::ERR_NAME_NOT_RESOLVED";
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

// Chrome announces a renderer-initiated navigation before the input that started it replies, and
// chrome-devtools-mcp waits for a click's page only when frameStartedNavigating comes first.
export function emitInputNavigationStarted(
  ctx: DispatchCtx,
  target: TargetState,
  nav: { url: string; loaderId: string; reason: Protocol.Page.ClientNavigationReason },
  sessionId: string | undefined,
): void {
  const frameId = target.frameId;
  for (const s of targetSessions(target, sessionId)) {
    ctx.emit({
      method: "Page.frameRequestedNavigation",
      params: { frameId, reason: nav.reason, url: nav.url, disposition: "currentTab" },
      sessionId: s,
    });
    ctx.emit({
      method: "Page.frameStartedNavigating",
      params: {
        frameId,
        url: nav.url,
        loaderId: nav.loaderId,
        navigationType: "differentDocument",
      },
      sessionId: s,
    });
  }
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
    frame: makeFrameInfo(frame, target.frames),
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
  for (const w of target.isolatedWorlds ?? []) {
    if (w.id > 0) (target.retiredContextIds ??= new Set()).add(w.id);
    w.id = 0;
  }
  for (const s of targetSessions(target, sessionId)) {
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
  for (const s of sessions) {
    ctx.emit({
      method: "Page.lifecycleEvent",
      params,
      sessionId: s,
    });
  }
  if (frame.parentFrameId === null) {
    target.lastLoadAt = Date.now();
    for (const s of sessions) {
      ctx.emit({
        method: "Page.loadEventFired",
        params: { timestamp: ts },
        sessionId: s,
      });
    }
  }
  for (const s of sessions) {
    ctx.emit({
      method: "Page.frameStoppedLoading",
      params: { frameId: frame.frameId },
      sessionId: s,
    });
  }
  if (frame.parentFrameId === null) {
    scheduleNetworkIdleEmit(ctx, target, frame, sessions);
  }
  frame.lifecycle = "load";
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
  const generationAtSchedule = target.navigateGeneration;
  const urlAtSchedule = target.url;
  const browser = ctx.browser;
  const work = (async () => {
    const iframeWaits: Promise<void>[] = [];
    const installWaits: Promise<void>[] = [];
    for (const f of target.frames.values()) {
      if (f.parentFrameId === null) continue;
      if (!f.pendingLoad) continue;
      let markInstalled: () => void = () => {};
      if (frameGatesLoadEvent(f)) {
        installWaits.push(
          new Promise<void>((resolve) => {
            markInstalled = resolve;
          }),
        );
      }
      iframeWaits.push(
        f.pendingLoad
          .catch(() => {})
          .then(async () => {
            const ps = target.pageScript;
            try {
              if (
                browser.wsClosing ||
                target.navigateGeneration !== generationAtSchedule ||
                f.detached
              ) {
                releaseFrameDom(f);
                return;
              }
              if (
                ps &&
                typeof (ps as { installIframeContent?: unknown }).installIframeContent ===
                  "function"
              ) {
                let html = "";
                if (f.dom) {
                  try {
                    html = f.dom.outerHTML(0);
                  } catch {}
                }
                try {
                  await ps.installIframeContent({
                    frameId: f.frameId,
                    ownerBackendNodeId: f.ownerBackendNodeId,
                    html,
                    url: f.url,
                    failed: !f.dom,
                    mimeType: f.mimeType,
                    crossOrigin:
                      !!(f.url && f.url !== "about:blank") && (f.isCrossOrigin || f.hasScript),
                  });
                } catch (err) {
                  console.warn(
                    "[kitesurf-iframe] installIframeContent failed for " + f.url + ":",
                    err instanceof Error ? err.message : String(err),
                  );
                }
              }
              releaseFrameDom(f);
            } finally {
              markInstalled();
            }
            if (f.url && f.url !== "about:blank" && (f.isCrossOrigin || f.hasScript) && ps) {
              await spawnOopifPipeline(ctx, target, f);
            }
            emitChildFrameDclLoad(ctx, target, f, sessionId);
          }),
      );
    }
    if (armedIframeGate) {
      void Promise.all(installWaits)
        .then(() => {
          if (browser.wsClosing || target.navigateGeneration !== generationAtSchedule) {
            return;
          }
          const ps = target.pageScript;
          return ps?.iframeInstallsSettled?.();
        })
        .catch(() => {});
    }
    let summary: Partial<LoadCompletion> = {};
    const summaryWait = traceSpan(ctx.env.HOST_TRACER, "navigate.await_load", async (sp) => {
      const s = await pageScript.awaitLoad();
      if (sp && typeof s.sentAt === "number") {
        const recvAt = Date.now();
        sp.setTags({
          reply_transit_ms: recvAt - s.sentAt,
          ...(typeof s.readyAt === "number" ? { summary_queue_ms: s.sentAt - s.readyAt } : {}),
          outbound_inflight_at_recv: getOutboundInflight(ctx.connectionId),
        });
      }
      return s;
    })
      .then((s) => {
        summary = s;
      })
      .catch((err) => {
        console.warn(
          "[kitesurf-nav] awaitLoad threw (firing load lifecycle anyway):",
          err instanceof Error ? err.message : String(err),
        );
      });
    drivePageTasks(ctx, target, summaryWait);
    await Promise.all([summaryWait, ...iframeWaits]);
    if (browser.wsClosing) return;
    if (target.navigateGeneration !== generationAtSchedule) {
      return;
    }
    if (target.diagSpans) {
      target.diagSpans.settleFromSummary(summary.phases ?? {});
      target.diagSpans.closeAll("load-complete");
      target.diagSpans = null;
    }
    if (summary.cookieWrites && summary.cookieWrites.length > 0 && urlAtSchedule) {
      for (const raw of summary.cookieWrites) {
        jarForTarget(ctx, target).setFromDocumentCookie(urlAtSchedule, raw);
      }
    }
    if (summary.console && summary.console.length > 0) {
      emitCapturedConsole(ctx, target, summary.console, sessionId);
    }
    if (summary.exceptions && summary.exceptions.length > 0) {
      emitCapturedExceptions(ctx, target, summary.exceptions, sessionId);
    }
    if (summary.cdpMutations && summary.cdpMutations.length > 0) {
      emitMutations(ctx, target, summary.cdpMutations);
    }
    if (summary.phases) {
      target.lastNavigatePhases = {
        ...(target.lastNavigatePhases ?? {}),
        ...summary.phases,
      };
    }
    try {
      await reconcileTools(ctx, target);
    } catch (err) {
      console.warn(
        "kitesurf: WebMCP reconcile failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
    emitFrameLoadComplete(ctx, target, mainFrame(target), sessionId);
  })();
  ctx.ctx.waitUntil(work);
}

const backgroundDrainInFlight = new WeakSet<TargetState>();

export function pumpBackgroundEvents(ctx: DispatchCtx, target: TargetState): void {
  if (target.type !== "page") return;
  if (target.domEnabledSessions.size === 0) return;
  const pageScript = target.pageScript;
  if (!pageScript || typeof pageScript.drainConsole !== "function") return;
  if (backgroundDrainInFlight.has(target)) return;
  backgroundDrainInFlight.add(target);
  const work = (async () => {
    try {
      const summary = await pageScript.drainConsole();
      if (ctx.browser.wsClosing) return;
      if (target.pageScript !== pageScript) return;
      // target.url already names the next document while a navigate fetches it.
      const cookieUrl = target.pageScriptUrl;
      if (summary.cookieWrites && summary.cookieWrites.length > 0 && cookieUrl) {
        for (const raw of summary.cookieWrites) {
          jarForTarget(ctx, target).setFromDocumentCookie(cookieUrl, raw);
        }
      }
      if (summary.console && summary.console.length > 0) {
        emitCapturedConsole(ctx, target, summary.console, undefined);
      }
      if (summary.exceptions && summary.exceptions.length > 0) {
        emitCapturedExceptions(ctx, target, summary.exceptions, undefined);
      }
      if (summary.cdpMutations && summary.cdpMutations.length > 0) {
        emitMutations(ctx, target, summary.cdpMutations);
      }
      if (summary.documentReopened) {
        const { replayReopenedLifecycle } = await import("./runtime.ts");
        replayReopenedLifecycle(ctx, target, summary, undefined);
      }
    } catch {
    } finally {
      backgroundDrainInFlight.delete(target);
    }
  })();
  ctx.ctx.waitUntil(work);
}

const PUMP_TASKS_TIMEOUT_MS = 5_000;

async function pumpPageTasks(
  target: TargetState,
  timeoutMs: number = PUMP_TASKS_TIMEOUT_MS,
  armWakeAfterSeq?: number,
  frameIntervalMs?: number,
): Promise<{
  seq: number;
  animating: boolean;
  pumped: number;
  idle: boolean;
  nextRafDelayMs?: number;
} | null> {
  const ps = target.pageScript;
  if (!ps) return null;
  try {
    const r = await withTimeout(
      stubQueryDom(ps, "pumpTasks", { armWakeAfterSeq, frameIntervalMs }),
      timeoutMs,
      "pumpTasks",
    );
    return {
      seq: typeof r?.seq === "number" ? r.seq : 0,
      animating: r?.animating === true,
      pumped: typeof r?.pumped === "number" ? r.pumped : 0,
      idle: r?.idle === true,
      nextRafDelayMs: r?.nextRafDelayMs,
    };
  } catch {
    return null;
  }
}

const DRIVE_IDLE_POLL_MS = 16;
const DRIVE_IDLE_STOP_MS = 1_000;
const DRIVE_MAX_MS = 15_000;

function drivePageTasks(ctx: DispatchCtx, target: TargetState, loaded: Promise<unknown>): void {
  const generation = target.navigateGeneration;
  const browser = ctx.browser;
  let isLoaded = false;
  void loaded.finally(() => {
    isLoaded = true;
  });
  const work = (async () => {
    const start = Date.now();
    let idleSince: number | null = null;
    while (Date.now() - start < DRIVE_MAX_MS) {
      if (browser.wsClosing || target.navigateGeneration !== generation) return;
      const r = await pumpPageTasks(target);
      if (!r || r.pumped < 0) return;
      if (r.pumped > 0) {
        idleSince = null;
        continue;
      }
      idleSince ??= Date.now();
      if (isLoaded && Date.now() - idleSince >= DRIVE_IDLE_STOP_MS) return;
      await new Promise((resolve) => setTimeout(resolve, DRIVE_IDLE_POLL_MS));
    }
  })();
  ctx.ctx.waitUntil(work);
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
  const frameId = frame.frameId;
  const loaderId = frame.loaderId;
  const tracker = ctx.browser.networkEvents;
  const browser = ctx.browser;
  const work = (async () => {
    const start = Date.now();
    let quietSince: number | null = null;
    while (Date.now() - start < NETWORK_IDLE_MAX_WAIT_MS) {
      if (browser.wsClosing) return;
      const leftMs = NETWORK_IDLE_MAX_WAIT_MS - (Date.now() - start);
      if (leftMs <= 0) break;
      await pumpPageTasks(target, Math.min(leftMs, PUMP_TASKS_TIMEOUT_MS));
      if (browser.wsClosing) return;
      tracker.drain();
      const inFlight = tracker.getInFlight();
      if (inFlight === 0) {
        if (quietSince === null) {
          quietSince = Date.now();
        } else if (Date.now() - quietSince >= NETWORK_IDLE_QUIET_MS) {
          break;
        }
      } else {
        quietSince = null;
      }
      await new Promise((resolve) => setTimeout(resolve, NETWORK_IDLE_POLL_MS));
    }
    if (browser.wsClosing) return;
    const ts = Date.now() / MILLISECONDS_PER_SECOND;
    const params: Protocol.Page.LifecycleEventEvent = {
      frameId,
      loaderId,
      name: "networkIdle",
      timestamp: ts,
    };
    for (const s of sessions) {
      ctx.emit({
        method: "Page.lifecycleEvent",
        params,
        sessionId: s,
      });
    }
  })();
  ctx.ctx.waitUntil(work);
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
  emitChildFrameAttachAndStart(ctx, target.frames, childFrames, targetSessions(target, sessionId));
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
    const rest = source.slice(lt);
    if (rest.startsWith("<!--")) {
      const close = source.indexOf("-->", lt + 4);
      if (close < 0) return -1;
      at = close + 3;
    } else if (rest.startsWith("<?")) {
      const close = source.indexOf("?>", lt + 2);
      if (close < 0) return -1;
      at = close + 2;
    } else if (/^<!doctype/i.test(rest)) {
      const bracket = source.indexOf("[", lt);
      const gt = source.indexOf(">", lt);
      if (gt < 0) return -1;
      if (bracket >= 0 && bracket < gt) {
        const closeBracket = source.indexOf("]", bracket);
        if (closeBracket < 0) return -1;
        const gtAfter = source.indexOf(">", closeBracket);
        if (gtAfter < 0) return -1;
        at = gtAfter + 1;
      } else {
        at = gt + 1;
      }
    } else if (/^<svg[\s>]/i.test(rest)) {
      return lt;
    } else if (rest.startsWith("<") && /^<[a-z!?/]/i.test(rest)) {
      return -1;
    } else {
      at = lt + 1;
    }
  }
  return -1;
}

function svgDocumentHtml(svgSource: string, viewport: { width: number; height: number }): string {
  const rootStart = svgRootStart(svgSource);
  let svg = rootStart >= 0 ? svgSource.slice(rootStart) : svgSource;

  const lifted: string[] = [];
  svg = svg.replace(SVG_BREAKOUT_META, (m) => {
    lifted.push(m);
    return "";
  });

  let rootTag = svg.slice(0, svg.indexOf(">") + 1 || undefined);

  const hasAbsoluteSize = (attr: string): boolean => {
    const m = rootTag.match(new RegExp(`[\\s"']${attr}\\s*=\\s*["']?\\s*([^"'\\s>]+)`, "i"));
    return !!m && !/%$/.test(m[1] ?? "");
  };
  if (
    !/[\s"']viewBox\s*=/i.test(rootTag) &&
    !(hasAbsoluteSize("width") && hasAbsoluteSize("height"))
  ) {
    const vb = `viewBox="0 0 ${viewport.width} ${viewport.height}"`;
    svg = svg.replace("<svg", `<svg ${vb}`);
    rootTag = svg.slice(0, svg.indexOf(">") + 1 || undefined);
  }
  const hasViewBox = /[\s"']viewBox\s*=/i.test(rootTag);

  const axisRule = (attr: "width" | "height", unit: "vw" | "vh"): string => {
    const m = rootTag.match(new RegExp(`[\\s"']${attr}\\s*=\\s*["']?\\s*([^"'\\s>]+)`, "i"));
    if (!m) return hasViewBox ? `${attr}:100${unit};` : "";
    const pct = (m[1] ?? "").match(/^([\d.]+)%$/);
    if (!pct) return "";
    return hasViewBox ? `${attr}:${pct[1]}${unit};` : "";
  };

  return (
    "<!doctype html><html><head><style>" +
    "html,body{margin:0;padding:0}" +
    `body>svg{display:block;${axisRule("width", "vw")}${axisRule("height", "vh")}}` +
    "</style>" +
    lifted.join("") +
    "</head><body>" +
    svg +
    "</body></html>"
  );
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

  if (value === null || typeof value !== "object") {
    return `<div class="json-row">${keyHtml}${renderJsonScalar(value)}${trailing}</div>`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `<div class="json-row">${keyHtml}<span class="json-punct">[]</span>${trailing}</div>`;
    }
    const children = value
      .map((item, index) => renderJsonRow(item, null, index === value.length - 1))
      .join("");
    return (
      `<div class="json-row json-collapsible">` +
      `<span class="json-toggle" aria-hidden="true">\u25bc</span>` +
      `<span class="json-summary">${keyHtml}<span class="json-punct">[</span>` +
      `<span class="json-preview">\u2026]${last ? "" : ","}</span></span>` +
      `<div class="json-children">${children}</div>` +
      `<div class="json-close"><span class="json-punct">]</span>${trailing}</div>` +
      `</div>`
    );
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return `<div class="json-row">${keyHtml}<span class="json-punct">{}</span>${trailing}</div>`;
  }
  const children = entries
    .map(([k, v], index) => renderJsonRow(v, JSON.stringify(k), index === entries.length - 1))
    .join("");
  return (
    `<div class="json-row json-collapsible">` +
    `<span class="json-toggle" aria-hidden="true">\u25bc</span>` +
    `<span class="json-summary">${keyHtml}<span class="json-punct">{</span>` +
    `<span class="json-preview">\u2026}${last ? "" : ","}</span></span>` +
    `<div class="json-children">${children}</div>` +
    `<div class="json-close"><span class="json-punct">}</span>${trailing}</div>` +
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
    const k = attributes[i];
    const v = attributes[i + 1];
    if (k !== undefined && v !== undefined && k.toLowerCase() === lower) return v;
  }
  return null;
}

interface ParsedNodeInfo {
  attributes?: string[];
  localName?: string;
  nodeName?: string;
}

function findStylesheetLinks(dom: DomHandle): Array<{ nodeId: number; href: string }> {
  let ids: Int32Array;
  try {
    ids = dom.querySelectorAll("link[rel='stylesheet']");
  } catch {
    return [];
  }
  const out: Array<{ nodeId: number; href: string }> = [];
  for (const id of ids) {
    if (id < 0) continue;
    const info = safeNodeInfo(dom, id);
    const href = readAttr(info?.attributes, "href");
    if (!href) continue;
    out.push({ nodeId: id, href });
  }
  return out;
}

function findIframes(dom: DomHandle): Array<{
  nodeId: number;
  src: string | null;
  name: string | null;
  id: string | null;
  loading: string | null;
}> {
  let ids: Int32Array;
  try {
    ids = dom.querySelectorAll("iframe");
  } catch {
    return [];
  }
  const out: Array<{
    nodeId: number;
    src: string | null;
    name: string | null;
    id: string | null;
    loading: string | null;
  }> = [];
  for (const id of ids) {
    if (id < 0) continue;
    const info = safeNodeInfo(dom, id);
    if (!info) continue;
    const src = readAttr(info.attributes, "src");
    const name = readAttr(info.attributes, "name");
    const idAttr = readAttr(info.attributes, "id");
    const loading = readAttr(info.attributes, "loading");
    out.push({
      nodeId: id,
      src: src ?? null,
      name: name ?? null,
      id: idAttr ?? null,
      loading: loading ?? null,
    });
  }
  return out;
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
    let resolvedUrl: string;
    if (ifr.src) {
      try {
        resolvedUrl = new URL(ifr.src, baseUrl || undefined).toString();
      } catch {
        resolvedUrl = "about:blank";
      }
    } else {
      resolvedUrl = "about:blank";
    }
    const childFrameId = mintFrameId();
    const childLoaderId = mintLoaderId();
    const isCrossOrigin =
      resolvedUrl !== "about:blank" && originOf(resolvedUrl) !== originOf(target.url);
    const childFrame = makeChildFrameState({
      frameId: childFrameId,
      parentFrameId: parentFrame.frameId,
      loaderId: childLoaderId,
      url: resolvedUrl,
      name: ifr.name ?? "",
      ownerElementId: ifr.id ?? "",
      ownerBackendNodeId: ifr.nodeId,
      isCrossOrigin,
      delaysLoadEvent: iframeDelaysLoadEvent(ifr.loading),
    });
    target.frames.set(childFrameId, childFrame);
    registered.push(childFrame);
  }
  return registered;
}

const OOPIF_POLL_TIMEOUT_MS = 10_000;

async function pollOopifFrames(ctx: DispatchCtx, target: TargetState): Promise<void> {
  const parentPs = target.pageScript;
  if (!parentPs) return;
  for (const f of target.frames.values()) {
    const child = f.pageScript;
    if (!child) {
      if (
        f.oopifBlocked &&
        !f.requestBlocked &&
        !f.detached &&
        !f.oopifSpawning &&
        ctx.browser.workerBudget.canSpawnOopif()
      ) {
        ctx.ctx.waitUntil(spawnOopifPipeline(ctx, target, f));
      }
      continue;
    }
    await pollOopifFrame(ctx, target, f, child, parentPs);
  }
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
  let anyChild = false;
  for (const f of target.frames.values()) {
    if (f.pageScript) {
      anyChild = true;
      break;
    }
  }
  if (!anyChild) return;
  ctx.ctx.waitUntil(oopifPass(ctx, target).catch(() => {}));
}

async function pollOopifFrame(
  ctx: DispatchCtx,
  target: TargetState,
  f: FrameState,
  child: PageScriptStub,
  parentPs: PageScriptStub,
): Promise<void> {
  try {
    const { recordAndRasterizeFrame } = await import("../eval/oopif-render.ts");
    const manager = getRendererManager(ctx, target);
    let res;
    try {
      res = await withTimeout(
        recordAndRasterizeFrame(manager, child, {
          raster: { format: "rgba", omitBackground: false },
          sinceSeq: f.lastRenderSeq,
          scope: renderScope(target),
        }),
        OOPIF_POLL_TIMEOUT_MS,
        "oopif recordAndRasterizeFrame",
      );
    } catch (err) {
      manager.dispose("oopif poll timed out");
      throw err;
    }
    if (!res.ok) {
      console.warn(`[kitesurf-oopif] poll re-render failed for ${f.url}: ${res.error}`);
      return;
    }
    if (res.bytes.length === 0) return;
    if (typeof res.width !== "number" || typeof res.height !== "number") {
      console.warn(`[kitesurf-oopif] poll re-render: rgba envelope missing dims for ${f.url}`);
      return;
    }
    if (ctx.browser.wsClosing) return;
    const rc = await withTimeout(
      parentPs.setFrameBitmap({
        ownerBackendNodeId: f.ownerBackendNodeId,
        width: res.width,
        height: res.height,
        rgba: res.bytes,
      }),
      OOPIF_POLL_TIMEOUT_MS,
      "oopif setFrameBitmap",
    );
    if (rc.ok) {
      f.lastRenderSeq = typeof res.seq === "number" ? res.seq : f.lastRenderSeq;
    } else {
      console.warn(
        `[kitesurf-oopif] poll setFrameBitmap rc=${rc.rc} for ${f.url}${rc.error ? ": " + rc.error : ""}`,
      );
    }
  } catch (err) {
    console.warn(
      `[kitesurf-oopif] poll threw for ${f.url}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Refuses a host-blocked child frame before it takes a worker lease, so it never spawns
 * an isolate. The refusal is sticky: budget retries in pollOopifFrames skip it.
 */
function refuseBlockedFrame(ctx: DispatchCtx, target: TargetState, f: FrameState): boolean {
  if (f.requestBlocked) return true;
  if (!ctx.requestBlocker) return false;
  const embedder =
    f.parentFrameId && f.parentFrameId !== target.frameId
      ? target.frames.get(f.parentFrameId)
      : undefined;
  let parentHost = "";
  try {
    const origin = originOf(embedder ? embedder.url : target.url);
    parentHost = origin ? new URL(origin).hostname : "";
  } catch {}
  const verdict = classifyRequest(ctx.requestBlocker, f.url, parentHost, "Document");
  if (!verdict) return false;
  f.requestBlocked = true;
  f.oopifBlocked = false;
  const tracker = ctx.browser.networkEvents;
  if (tracker && f.loaderId && f.frameId) {
    const requestId = tracker.beginRequest({
      url: f.url,
      method: "GET",
      headers: {},
      type: "Document",
      initiator: { type: "parser", url: originOf(target.url) },
      loaderId: f.loaderId,
      frameId: f.frameId,
      sessionIds: targetSessionsNetwork(target, undefined),
    });
    tracker.failRequest(requestId, "net::ERR_BLOCKED_BY_CLIENT", "subresource-filter");
  }
  console.warn(`[kitesurf-oopif] ${verdict.reason}, ${f.url} renders blank`);
  return true;
}

// HTML's site for cookies of the request that loads a frame: the top-level origin when every
// ancestor is same-site with it, else none, which the cookie jar treats as cross-site with every
// host. The frame's own requests also check its document (frameDocumentCookieSite).
export function frameCookieSiteOrigin(target: TargetState, frame: FrameState): string {
  const siteOf = (url: string): string | null => {
    try {
      return siteKey(new URL(url).hostname);
    } catch {
      return null;
    }
  };
  const topSite = siteOf(target.url);
  for (let f = target.frames.get(frame.parentFrameId ?? ""); f;) {
    if (f.parentFrameId === null) break;
    if (!/^about:(blank|srcdoc)([?#]|$)/.test(f.url) && siteOf(f.url) !== topSite) return "";
    f = target.frames.get(f.parentFrameId);
  }
  return topSite ? originOf(target.url) : "";
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
    cookieSiteOrigin: frameCookieSiteOrigin(target, f),
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
          routeChildFramePostMessage(target, f, params, url);
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
  if (f.pageScript || f.oopifPrespawn || f.detached) return;
  const queue = prespawnQueueFor(target);
  if (queue.started >= MAX_PRESPAWNS_PER_NAVIGATE) return;
  if (!f.url || f.url === "about:blank") return;
  if (!f.isCrossOrigin) return;
  if (!/^(https?|data):/i.test(f.url)) return;
  if (refuseBlockedFrame(ctx, target, f)) return;
  const lease = ctx.browser.workerBudget.acquire("oopif");
  if (!lease) return;
  f.pageScriptLease = lease;
  const url = f.url;
  const args = oopifSpawnArgs(ctx, target, f);
  queue.started++;
  const promise = queue.tail.then(async () => {
    if (f.detached || ctx.browser.wsClosing) return null;
    try {
      const { prespawnFrameIsolate } = await import("../eval/oopif-render.ts");
      const pre = await prespawnFrameIsolate(ctx.env, ctx.ctx, args);
      if (!pre.ok) {
        console.warn(`[kitesurf-oopif] prespawn failed for ${url}: ${pre.error}`);
        return null;
      }
      return pre;
    } catch (err) {
      console.warn(
        `[kitesurf-oopif] prespawn threw for ${url}:`,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  });
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

async function discardOopifPrespawnResult(
  pre: PrespawnedFrame,
  reason: string,
  final = false,
): Promise<void> {
  try {
    const { discardPrespawnedFrame } = await import("../eval/oopif-render.ts");
    await discardPrespawnedFrame(pre, reason, final);
  } catch {}
}

function discardOopifPrespawn(f: FrameState, reason: string, atClose?: GenerationDeps): void {
  const entry = f.oopifPrespawn;
  if (!entry) return;
  f.oopifPrespawn = undefined;
  if (!f.pageScript) {
    f.pageScriptLease?.release();
    f.pageScriptLease = null;
  }
  const discarding = entry.promise.then((pre) =>
    pre ? discardOopifPrespawnResult(pre, reason, atClose !== undefined) : undefined,
  );
  if (atClose?.waitUntil) atClose.waitUntil(discarding);
}

async function spawnOopifPipeline(
  ctx: DispatchCtx,
  target: TargetState,
  f: FrameState,
): Promise<void> {
  const ps = target.pageScript;
  if (!ps) return;
  if (f.pageScript || f.oopifSpawning || f.detached) return;
  if (!f.url || f.url === "about:blank") return;
  if (!f.isCrossOrigin && !f.hasScript) return;
  if (!/^(https?|data):/i.test(f.url)) return;
  if (refuseBlockedFrame(ctx, target, f)) return;
  const lease = f.pageScriptLease ?? ctx.browser.workerBudget.acquire("oopif");
  if (!lease) {
    if (!f.oopifBlocked) {
      f.oopifBlocked = true;
      console.warn(
        `[kitesurf-oopif] budget full, ${f.url} renders blank ` +
          `(${ctx.browser.workerBudget.describe()})`,
      );
    }
    return;
  }
  f.oopifBlocked = false;
  f.pageScriptLease = lease;
  f.oopifSpawning = true;
  const browser = ctx.browser;
  const generationAtStart = target.navigateGeneration;
  const urlAtStart = f.url;
  try {
    const { spawnAndNavigateFrame, navigatePrespawnedFrame, recordAndRasterizeFrame } =
      await import("../eval/oopif-render.ts");
    let viewport: { width: number; height: number } | undefined;
    try {
      const rectResp = await stubQueryDom(ps, "getRect", {
        nodeId: f.ownerBackendNodeId,
      });
      const w = rectResp?.rect?.width;
      const h = rectResp?.rect?.height;
      if (typeof w === "number" && typeof h === "number" && w >= 1 && h >= 1) {
        viewport = { width: w, height: h };
      }
    } catch {}
    if (
      browser.wsClosing ||
      target.navigateGeneration !== generationAtStart ||
      target.frames.get(f.frameId) !== f ||
      f.detached
    ) {
      return;
    }
    const args = { ...oopifSpawnArgs(ctx, target, f), viewport };
    const pre = await takeOopifPrespawn(f, f.url);
    const spawn = pre
      ? await navigatePrespawnedFrame(pre, args)
      : await spawnAndNavigateFrame(ctx.env, ctx.ctx, args);
    if (!spawn.ok) {
      console.warn(`[kitesurf-oopif] spawn failed for ${f.url}: ${spawn.error}`);
      lease.release();
      f.pageScriptLease = null;
      return;
    }
    if (
      browser.wsClosing ||
      target.navigateGeneration !== generationAtStart ||
      target.frames.get(f.frameId) !== f ||
      f.detached
    ) {
      try {
        await spawn.stub.unload();
      } catch {}
      try {
        spawn.stub.close?.("oopif spawn superseded");
      } catch {}
      lease.release();
      f.pageScriptLease = null;
      return;
    }
    if (f.url !== urlAtStart) {
      try {
        await spawn.stub.unload();
      } catch {}
      try {
        spawn.stub.close?.("oopif spawn stale: src changed mid-spawn");
      } catch {}
      lease.release();
      f.pageScriptLease = null;
      f.oopifSpawning = false;
      if (f.url && f.url !== "about:blank" && (f.isCrossOrigin || f.hasScript)) {
        await spawnOopifPipeline(ctx, target, f);
      }
      return;
    }
    f.pageScript = spawn.stub;
    if (spawn.finalUrl && spawn.finalUrl !== f.url) {
      f.url = spawn.finalUrl;
      f.securityOrigin = originOf(spawn.finalUrl);
    }
    {
      const queued = f.pendingPostMessages;
      f.pendingPostMessages = undefined;
      for (const p of queued ?? []) deliverPostMessageToChild(f, p);
    }
    f.execContextId = ctx.browser.execContextSeq++;
    const { emitOopifExecutionContext } = await import("./runtime.ts");
    emitOopifExecutionContext(ctx, f);
    announceOopifTarget(ctx, f);
    if (ctx.browser.skipSpeculativeRaster) return;
    const manager = getRendererManager(ctx, target);
    const res = await recordAndRasterizeFrame(manager, spawn.stub, {
      raster: { format: "rgba", omitBackground: false },
      scope: renderScope(target),
    });
    if (
      res.ok &&
      typeof res.width === "number" &&
      typeof res.height === "number" &&
      !browser.wsClosing &&
      target.navigateGeneration === generationAtStart
    ) {
      const rc = await ps.setFrameBitmap({
        ownerBackendNodeId: f.ownerBackendNodeId,
        width: res.width,
        height: res.height,
        rgba: res.bytes,
      });
      if (rc.ok) {
        f.lastRenderSeq = typeof res.seq === "number" ? res.seq : -1;
      } else {
        console.warn(
          `[kitesurf-oopif] setFrameBitmap rc=${rc.rc} for ${f.url}${rc.error ? ": " + rc.error : ""}`,
        );
      }
    } else if (!res.ok) {
      console.warn(`[kitesurf-oopif] render failed for ${f.url}: ${res.error}`);
    }
  } catch (err) {
    console.warn(
      `[kitesurf-oopif] pipeline threw for ${f.url}:`,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    if (!f.pageScript) {
      lease.release();
      f.pageScriptLease = null;
    }
    f.oopifSpawning = false;
  }
}

// `atClose` is for the socket close: nothing reads a frame again, so its isolate is killed without
// the background unload, and the kill stays within the request's lifetime.
export function teardownOopifStubs(
  target: TargetState,
  reason: string,
  ctx?: DispatchCtx,
  atClose?: GenerationDeps,
): void {
  for (const f of target.frames.values()) {
    teardownOopifStubForFrame(target, f, reason, ctx, atClose);
    releaseFrameDom(f);
  }
}

function teardownOopifStubForFrame(
  target: TargetState,
  f: FrameState,
  reason: string,
  ctx?: DispatchCtx,
  atClose?: GenerationDeps,
): void {
  discardOopifPrespawn(f, reason, atClose);
  if (ctx && f.parentFrameId !== null) {
    ctx.browser.dedicatedWorkers.terminateFrame(target.targetId, f.frameId, reason);
  }
  if (ctx && f.parentFrameId !== null) {
    if (ctx.browser.connectionMode === "browser" || f.sessions.size > 0) {
      destroyOopifTarget(ctx, f);
    } else {
      ctx.browser.networkEvents.deleteTargetAttribution(f.frameId);
    }
  }
  if (!f.pageScript) return;
  const destroyedCtxId = f.execContextId;
  f.lastRenderSeq = -1;
  f.execContextId = 0;
  void retireStub(
    f,
    atClose ? "wsClosed" : "frameTeardown",
    `oopif teardown: ${reason}`,
    atClose ?? { budget: ctx?.browser.workerBudget },
  );
  if (ctx && destroyedCtxId > 0) {
    (async () => {
      const { emitOopifExecutionContextDestroyed } = await import("./runtime.ts");
      emitOopifExecutionContextDestroyed(ctx, destroyedCtxId);
    })();
  }
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
  for (const ifr of scan.iframes) {
    let resolvedUrl: string;
    if (ifr.src) {
      try {
        resolvedUrl = new URL(ifr.src, baseUrl || undefined).toString();
      } catch {
        resolvedUrl = "about:blank";
      }
    } else {
      resolvedUrl = "about:blank";
    }
    const childFrameId = mintFrameId();
    const childLoaderId = mintLoaderId();
    const isCrossOrigin =
      resolvedUrl !== "about:blank" && originOf(resolvedUrl) !== originOf(target.url);
    const childFrame = makeChildFrameState({
      frameId: childFrameId,
      parentFrameId: parentFrame.frameId,
      loaderId: childLoaderId,
      url: resolvedUrl,
      name: ifr.name ?? "",
      ownerElementId: ifr.id ?? "",
      ownerBackendNodeId: -1,
      isCrossOrigin,
      delaysLoadEvent: iframeDelaysLoadEvent(ifr.loading),
    });
    target.frames.set(childFrameId, childFrame);
    registered.push(childFrame);
  }
  return registered;
}

async function backfillIframeOwnerNodeIds(target: TargetState): Promise<void> {
  const ps = target.pageScript;
  if (!ps) return;
  const frames = [...target.frames.values()]
    .filter((f) => f.parentFrameId === mainFrame(target).frameId)
    .filter((f) => f.ownerBackendNodeId === -1);
  if (frames.length === 0) return;
  try {
    const r = await stubQueryDom(ps, "querySelectorAll", {
      selector: "iframe",
    });
    const ids = Array.isArray(r?.nodeIds) ? r.nodeIds : [];
    for (let i = 0; i < frames.length && i < ids.length; i++) {
      const frame = frames[i];
      const id = ids[i];
      if (frame && typeof id === "number") frame.ownerBackendNodeId = id;
    }
  } catch {}
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

// HTML's "can have its URL rewritten". A document never moves to another origin, and a
// non-HTTP(S) one such as data: or about: changes only its fragment (file: also its query).
export function canRewriteDocumentUrl(documentUrl: string, targetUrl: string): boolean {
  let doc: URL;
  let next: URL;
  try {
    doc = new URL(documentUrl);
    next = new URL(targetUrl);
  } catch {
    return false;
  }
  if (
    doc.protocol !== next.protocol ||
    doc.username !== next.username ||
    doc.password !== next.password ||
    doc.host !== next.host
  ) {
    return false;
  }
  if (next.protocol === "http:" || next.protocol === "https:") return true;
  if (next.protocol === "file:") return doc.pathname === next.pathname;
  return doc.pathname === next.pathname && doc.search === next.search;
}

export function installUpstreamEventHandler(
  ctx: DispatchCtx,
  target: TargetState,
  stub: PageScriptStub,
  generation: number,
  url: string,
): void {
  if (target.navigateGeneration === generation) target.pageScriptUrl = url;
  if (typeof stub.setUpstreamEventHandler !== "function") return;
  const workerOwner = ctx.browser.dedicatedWorkers.ownerFor(
    target,
    target.frameId,
    stub,
    url,
    target.loaderId,
  );
  const loaderId = target.loaderId;
  stub.setUpstreamEventHandler((event, params) => {
    if (target.navigateGeneration !== generation) return;
    if (ctx.browser.wsClosing) return;
    if (event === "kitesurf.diag") {
      target.diagSpans?.handle(params);
      return;
    }
    if (event === "kitesurf.insertedScriptRan") {
      const p = params as { url?: unknown; bytes?: unknown; run?: unknown };
      if (typeof p.url === "string" && typeof p.bytes === "number") {
        const run = p.run === "baked" || p.run === "stale" ? p.run : "boa";
        // The isolate's own url, not target.url: during Page.navigate target.url already names
        // the next document while this isolate can still report.
        recordInsertedScript(
          ctx.browser.learnedInsertedScripts,
          url,
          p.url,
          p.bytes,
          run,
          target.browserContextId,
        );
      }
      return;
    }
    if (event === "kitesurf.paintDirty") {
      wakeSceneStream(ctx.browser, target.targetId);
      const screencast = ctx.browser.screencasts.get(target.targetId);
      if (screencast) {
        screencast.paintDirty = true;
        screencast.wake?.();
      }
      return;
    }
    if (isWorkerUpstreamEvent(event)) {
      ctx.browser.dedicatedWorkers.handle(ctx, workerOwner, event, params);
      return;
    }
    // Page.navigate mints the next loader id and resets target.frames before it bumps the
    // generation, while this isolate still runs. Its frame events then describe a document that
    // is being replaced and must not reach the next one's frames.
    if (target.loaderId !== loaderId) return;
    handleUpstreamFrameEvent(ctx, target, undefined, event, params, url);
  });
}

export function installIsolateLimitSurface(
  ctx: DispatchCtx,
  target: TargetState,
  generation: number,
  scriptName: string,
): void {
  const caps = pageIsolateCaps(ctx.env, ctx.browser.isolateCapOverrides);
  const isLive = () =>
    !ctx.browser.wsClosing &&
    target.navigateGeneration === generation &&
    ctx.browser.targets.get(target.targetId) === target;
  const onLimit = (notice: IsolateLimitNotice) => {
    if (target.navigateGeneration !== generation) return;
    if (target.isolateLimitReportedGen === generation) return;
    target.isolateLimitReportedGen = generation;
    ctx.browser.dedicatedWorkers.terminateTarget(target.targetId, `page isolate ${notice.kind}`);
    const capMs = notice.kind === "cpu" ? caps.cpuMs : notice.capMs;
    const text =
      notice.kind === "gone"
        ? "Kitesurf: the page isolate was reclaimed by the platform and the page was terminated. Reload to continue."
        : notice.kind === "crashed"
          ? `Kitesurf: the page's engine crashed (${notice.detail ?? "unknown trap"}) and the page was terminated. Reload to continue.`
          : `Kitesurf: page exceeded its ${
              notice.kind === "cpu"
                ? `CPU time limit (${capMs} ms)`
                : notice.kind === "wall"
                  ? `wall-clock time limit (${capMs} ms)`
                  : "memory limit"
            } and was terminated.`;
    const events: CdpEvent[] = [];
    for (const s of targetSessions(target, undefined)) {
      events.push({
        method: "Runtime.consoleAPICalled",
        params: {
          type: "error",
          args: [{ type: "string", value: text } as Protocol.Runtime.RemoteObject],
          executionContextId: target.defaultContextId || 1,
          timestamp: Date.now(),
          stackTrace: { callFrames: [] },
        },
        sessionId: s,
      });
      events.push({
        method: "Target.targetCrashed",
        params: {
          targetId: target.targetId,
          status: "crashed",
          errorCode: 1,
        },
        sessionId: s,
      });
    }
    for (const s of target.sessions) {
      events.push({
        method: "Inspector.targetCrashed",
        params: {},
        sessionId: s,
      });
    }
    for (const ev of events) ctx.browser.networkEvents.queueRaw(ev);
    if (!notice.fromTail) ctx.browser.networkEvents.drain();
  };
  registerIsolateLimitListener(scriptName, onLimit, { owner: ctx.connectionId, isLive });
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

// MessageEvent.origin comes from the url the engine committed for the sending frame, never from
// the isolate's claim, which page script can change. An about:blank or about:srcdoc frame has
// its embedder's origin. An isolate uses the url it was sealed with (sealedUrl for a child): a
// frame's url moves to the next document before the old one has run its unload handlers.
function frameMessageOrigin(target: TargetState, frame: FrameState, sealedUrl?: string): string {
  const about = /^about:(blank|srcdoc)([?#]|$)/;
  let f: FrameState | undefined = frame;
  let url = sealedUrl !== undefined && !about.test(sealedUrl) ? sealedUrl : null;
  while (url === null && f && f.parentFrameId !== null && about.test(f.url)) {
    f = target.frames.get(f.parentFrameId);
  }
  url ??= !f ? "" : f.parentFrameId === null ? (target.pageScriptUrl ?? f.url) : f.url;
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}

// A child frame's message goes to its parent only when it says so, or else to its own child.
export function routeChildFramePostMessage(
  target: TargetState,
  from: FrameState,
  params: ReceivedUpstreamParams,
  sealedUrl?: string,
): void {
  if (params.toParent === true) routePostMessageToParent(target, from.frameId, params, sealedUrl);
  else routePostMessageToChild(target, from, params, sealedUrl);
}

// Owner ids are node ids in the sender's document, so match them only among its own children.
export function routePostMessageToChild(
  target: TargetState,
  from: FrameState,
  params: ReceivedUpstreamParams,
  sealedUrl?: string,
): void {
  const ownerId = typeof params.toFrameOwnerId === "number" ? params.toFrameOwnerId : -1;
  if (ownerId <= 0) return;
  for (const f of target.frames.values()) {
    if (f.ownerBackendNodeId !== ownerId || f.parentFrameId !== from.frameId) continue;
    const message = { ...params, sourceOrigin: frameMessageOrigin(target, from, sealedUrl) };
    if (!f.pageScript) {
      if (!f.detached) {
        const q = (f.pendingPostMessages ??= []);
        if (q.length < MAX_PENDING_CHILD_POST_MESSAGES) q.push(message);
      }
      return;
    }
    deliverPostMessageToChild(f, message);
    return;
  }
}

function deliverPostMessageToChild(f: FrameState, message: ReceivedUpstreamParams): void {
  if (!f.pageScript) return;
  const senderOrigin = String(message.sourceOrigin ?? "");
  if (
    !postMessageOriginAllowed(String(message.targetOrigin ?? "*"), senderOrigin, originOf(f.url))
  ) {
    return;
  }
  void f.pageScript
    .deliverMessage({
      dataJson: String(message.dataJson ?? "null"),
      origin: senderOrigin,
      fromParent: true,
    })
    .catch(() => {});
}

export function routePostMessageToParent(
  target: TargetState,
  fromFrameId: string,
  params: ReceivedUpstreamParams,
  sealedUrl?: string,
): void {
  const f = target.frames.get(fromFrameId);
  if (!f || f.detached) return;
  const senderOrigin = frameMessageOrigin(target, f, sealedUrl);
  let recipient: PageScriptStub | null = null;
  let recipientOrigin = "";
  if (!f.parentFrameId || f.parentFrameId === target.frameId) {
    recipient = target.pageScript;
    recipientOrigin = originOf(target.url);
  } else {
    const pf = target.frames.get(f.parentFrameId);
    recipient = pf?.pageScript ?? null;
    recipientOrigin = pf ? originOf(pf.url) : "";
  }
  if (!recipient) return;
  if (
    !postMessageOriginAllowed(String(params.targetOrigin ?? "*"), senderOrigin, recipientOrigin)
  ) {
    return;
  }
  void recipient
    .deliverMessage({
      dataJson: String(params.dataJson ?? "null"),
      origin: senderOrigin,
      sourceFrameOwnerId: f.ownerBackendNodeId,
    })
    .catch(() => {});
}

function handleUpstreamFrameEvent(
  ctx: DispatchCtx,
  target: TargetState,
  sessionId: string | undefined,
  event: UpstreamEventName,
  params: ReceivedUpstreamParams,
  isolateUrl: string,
): void {
  if (event === "kitesurf.bindingCalled") {
    const name = typeof params.name === "string" ? params.name : "";
    const payload = typeof params.payload === "string" ? params.payload : "";
    if (!name || !ctx.browser.pendingBindings.has(name)) return;
    const sessions = targetSessions(target, sessionId);
    for (const s of sessions) {
      ctx.emit({
        method: "Runtime.bindingCalled",
        params: {
          name,
          payload,
          executionContextId: target.defaultContextId || 1,
        },
        sessionId: s,
      });
    }
    return;
  }

  if (event === "kitesurf.postMessage") {
    routePostMessageToChild(target, mainFrame(target), params);
    return;
  }
  if (event === "kitesurf.formSubmitNavigate") {
    const url = typeof params.url === "string" ? params.url : null;
    if (!url) return;
    const postData = typeof params.postData === "string" ? params.postData : null;
    const postContentType =
      typeof params.postContentType === "string"
        ? params.postContentType
        : "application/x-www-form-urlencoded";
    (async () => {
      try {
        const { dispatch } = await import("./dispatch.ts");
        const navParams: Protocol.Page.NavigateRequest = {
          url,
          _kitesurfInternal: true,
          _kitesurfInitiatorOrigin: initiatorOriginOf(target.url) ?? undefined,
        };
        if (postData !== null) {
          navParams._kitesurfPostData = postData;
          navParams._kitesurfPostContentType = postContentType;
        }
        await dispatch(ctx, {
          id: -1,
          method: "Page.navigate",
          params: navParams,
          sessionId: targetSessionsNetwork(target, sessionId)[0],
        });
      } catch (err) {
        console.warn(
          "kitesurf: form-submit Page.navigate failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    })();
    return;
  }

  if (event === "kitesurf.modelContextToolsAdded") {
    if (Array.isArray(params.tools)) {
      emitToolsAdded(ctx, target, params.tools as Parameters<typeof emitToolsAdded>[2]);
    }
    return;
  }
  if (event === "kitesurf.modelContextToolsRemoved") {
    if (Array.isArray(params.names)) {
      emitToolsRemoved(ctx, target, params.names as string[]);
    }
    return;
  }

  if (event === "kitesurf.navigatedWithinDocument") {
    const url = typeof params.url === "string" ? params.url : null;
    const navigationType =
      typeof params.navigationType === "string" ? params.navigationType : "other";
    const kind = typeof params.kind === "string" ? params.kind : "";
    const previousUrl = typeof params.previousUrl === "string" ? params.previousUrl : "";
    if (!url) return;
    const t: "fragment" | "historyApi" | "other" =
      navigationType === "fragment" || navigationType === "historyApi" || navigationType === "other"
        ? (navigationType as "fragment" | "historyApi" | "other")
        : "other";

    const refetchOnHistoryApi =
      target.refetchOnPushState &&
      (kind === "pushState" || kind === "replaceState") &&
      previousUrl &&
      isSameOriginPathChange(previousUrl, url);

    const crossDocument = kind === "navigate";

    if (crossDocument) {
      const settled =
        target.lastLoadAt > 0 && Date.now() - target.lastLoadAt > AUTO_RELOAD_SETTLED_MS;
      const consecutive = target.autoReloadUrl === url && !settled;
      target.autoReloadCount = consecutive ? target.autoReloadCount + 1 : 1;
      target.autoReloadUrl = url;
      if (target.autoReloadCount > MAX_CONSECUTIVE_AUTO_RELOADS) {
        console.warn(
          `kitesurf: suppressing self-reload #${target.autoReloadCount} to ` +
            `${url}; ${MAX_CONSECUTIVE_AUTO_RELOADS} consecutive reloads ` +
            `fired within ${AUTO_RELOAD_SETTLED_MS}ms of load — reload loop`,
        );
        return;
      }
    }

    if (refetchOnHistoryApi || crossDocument) {
      (async () => {
        try {
          const { dispatch } = await import("./dispatch.ts");
          await dispatch(ctx, {
            id: -1,
            method: "Page.navigate",
            params: {
              url,
              _kitesurfInternal: true,
              _kitesurfInitiatorOrigin: initiatorOriginOf(target.url) ?? undefined,
            },
            sessionId: targetSessionsNetwork(target, sessionId)[0],
          });
        } catch (err) {
          console.warn(
            `kitesurf: escalated ${kind} Page.navigate failed:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      })();
      return;
    }

    // Checked against the isolate's url because target.url is what this event would overwrite.
    if (!canRewriteDocumentUrl(isolateUrl, url)) return;
    target.url = url;
    if (kind === "replaceState") {
      const live = target.navigationHistory[target.navigationHistoryIndex];
      if (live) {
        live.url = url;
        live.userTypedURL = url;
      }
    } else if (kind === "hash" || kind === "pushState") {
      recordNavigationHistory(target, url, "link");
    }
    const sessions = targetSessions(target, sessionId);
    for (const s of sessions) {
      ctx.emit({
        method: "Page.navigatedWithinDocument",
        params: { frameId: target.frameId, url, navigationType: t },
        sessionId: s,
      });
    }
    return;
  }

  const frameId = typeof params.frameId === "string" ? params.frameId : null;
  if (!frameId) return;
  if (event === "kitesurf.frameAttached") {
    if (target.frames.has(frameId)) return;
    const url = typeof params.url === "string" && params.url ? params.url : "about:blank";
    const ownerBackendNodeId =
      typeof params.ownerBackendNodeId === "number" ? params.ownerBackendNodeId : -1;
    const isCrossOrigin = url !== "about:blank" && originOf(url) !== originOf(target.url);
    const frame = makeChildFrameState({
      frameId,
      parentFrameId: target.frameId,
      loaderId: mintLoaderId(),
      url,
      name: typeof params.name === "string" ? params.name : "",
      ownerElementId: typeof params.id === "string" ? params.id : "",
      ownerBackendNodeId,
      isCrossOrigin,
      delaysLoadEvent: iframeDelaysLoadEvent(
        typeof params.loading === "string" ? params.loading : null,
      ),
    });
    target.frames.set(frameId, frame);
    const sessions = targetSessions(target, sessionId);
    for (const s of sessions) {
      ctx.emit({
        method: "Page.frameAttached",
        params: { frameId, parentFrameId: target.frameId },
        sessionId: s,
      });
    }
    emitFrameTarget(ctx, frame);
    emitFrameStartedLoading(ctx, target, frame, sessionId);
    emitFrameNavigated(ctx, target, frame, sessionId);
    const ts = Date.now() / MILLISECONDS_PER_SECOND;
    for (const s of sessions) {
      ctx.emit({
        method: "Page.lifecycleEvent",
        params: { frameId, loaderId: frame.loaderId, name: "init", timestamp: ts },
        sessionId: s,
      });
    }
    return;
  }
  const frame = target.frames.get(frameId);
  if (!frame) return;
  const revived = frame.detached;
  if (revived) {
    if (event !== "kitesurf.frameNavigated") return;
    frame.detached = false;
    frame.lifecycle = "init";
  }
  if (event === "kitesurf.frameNavigated") {
    const url = typeof params.url === "string" && params.url ? params.url : frame.url;
    const urlChanged = url !== frame.url;
    if (urlChanged) {
      frame.url = url;
      frame.securityOrigin = originOf(url);
      frame.isCrossOrigin = !matchesAboutBlank(url) && originOf(url) !== originOf(target.url);
    }
    emitFrameNavigated(ctx, target, frame, sessionId);
    if (urlChanged && !revived) {
      teardownOopifStubForFrame(target, frame, "iframe src changed", ctx);
    }
    if (urlChanged || revived) {
      emitFrameTarget(ctx, frame);
    }
    if (!frame.pageScript && !frame.oopifSpawning && (frame.isCrossOrigin || frame.hasScript)) {
      ctx.ctx.waitUntil(spawnOopifPipeline(ctx, target, frame).catch(() => {}));
    }
    return;
  }
  if (event === "kitesurf.frameLifecycle") {
    const name = typeof params.name === "string" ? params.name : null;
    if (name !== "DOMContentLoaded" && name !== "load") return;
    const sessions = targetSessions(target, sessionId);
    const ts = Date.now() / MILLISECONDS_PER_SECOND;
    for (const s of sessions) {
      ctx.emit({
        method: "Page.lifecycleEvent",
        params: { frameId, loaderId: frame.loaderId, name, timestamp: ts },
        sessionId: s,
      });
    }
    if (name === "DOMContentLoaded") {
      frame.lifecycle = "dcl";
    } else if (name === "load") {
      frame.lifecycle = "load";
      for (const s of sessions) {
        ctx.emit({
          method: "Page.frameStoppedLoading",
          params: { frameId },
          sessionId: s,
        });
      }
    }
    return;
  }
  if (event === "kitesurf.frameStoppedLoading") {
    if (frame.lifecycle === "load") return;
    const sessions = targetSessions(target, sessionId);
    for (const s of sessions) {
      ctx.emit({
        method: "Page.frameStoppedLoading",
        params: { frameId },
        sessionId: s,
      });
    }
    return;
  }
  if (event === "kitesurf.frameDetached") {
    frame.detached = true;
    teardownOopifStubForFrame(target, frame, "iframe removed from DOM", ctx);
    releaseFrameDom(frame);
    const sessions = targetSessions(target, sessionId);
    for (const s of sessions) {
      ctx.emit({
        method: "Page.frameDetached",
        params: { frameId, reason: "remove" },
        sessionId: s,
      });
    }
    return;
  }
  console.warn(`[kitesurf-iframe] unknown upstream event: ${event}`);
}

function emitChildFrameDclLoad(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
  sessionId: string | undefined,
): void {
  if (frame.parentFrameId === null) return;
  if (frame.lifecycle === "load") return;
  const sessions = targetSessions(target, sessionId);
  const ts = Date.now() / MILLISECONDS_PER_SECOND;
  for (const name of ["DOMContentLoaded", "load"] as const) {
    const params: Protocol.Page.LifecycleEventEvent = {
      frameId: frame.frameId,
      loaderId: frame.loaderId,
      name,
      timestamp: ts,
    };
    for (const s of sessions) {
      ctx.emit({ method: "Page.lifecycleEvent", params, sessionId: s });
    }
  }
  for (const s of sessions) {
    ctx.emit({
      method: "Page.frameStoppedLoading",
      params: { frameId: frame.frameId },
      sessionId: s,
    });
  }
  frame.lifecycle = "load";
}

async function loadChildFrame(
  ctx: DispatchCtx,
  target: TargetState,
  frame: FrameState,
  sessionId: string | undefined,
  depth: number = 1,
  ancestorUrls: ReadonlySet<string> = new Set(),
): Promise<void> {
  const docPageOrigin = originOf(frame.url);
  const entryUrl = frame.url;
  const embedder =
    frame.parentFrameId && frame.parentFrameId !== target.frameId
      ? target.frames.get(frame.parentFrameId)
      : undefined;
  // Child requests inherit the embedding document's URL and referrer policy.
  const childDocProps: CallerOutboundProps = {
    pageOrigin: docPageOrigin,
    // The embedder decides whether the frame may reach a private address.
    cookieSiteOrigin: frameCookieSiteOrigin(target, frame),
    // The embedder's URL and policy give the Referer a browser sends;
    // page-script reports the same value as the frame's document.referrer.
    pageUrl: embedder ? embedder.url : target.url,
    referrerPolicy: (embedder ? embedder.referrerPolicy : target.docReferrerPolicy) ?? undefined,
    mainFrameId: frame.frameId,
    mainLoaderId: frame.loaderId,
    allowDocumentBypass: true,
    walksOwnRedirects: true,
  };
  const docOutbound = ctx.browser.sandboxOutbound.parent(childDocProps);
  let resp: Response;
  let finalUrl: string;
  const walkAbort = new AbortController();
  const walkTimer = setTimeout(
    () => walkAbort.abort(new Error("kitesurf: iframe document walk timeout")),
    IFRAME_DOC_WALK_BUDGET_MS,
  );
  try {
    const walk = await walkRedirects({
      url: frame.url,
      signal: walkAbort.signal,
      fetchHop: (hopReq) => docOutbound.fetch(hopReq),
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
    if (!walk.ok) {
      console.warn(`[kitesurf-iframe] too many redirects for ${frame.url}`);
      frame.readyState = "complete";
      return;
    }
    resp = walk.response;
    finalUrl = walk.finalUrl;
  } catch (err) {
    console.warn(
      `[kitesurf-iframe] fetch failed for ${frame.url}:`,
      err instanceof Error ? err.message : String(err),
    );
    frame.readyState = "complete";
    return;
  } finally {
    clearTimeout(walkTimer);
  }
  if (!resp.ok) {
    console.warn(`[kitesurf-iframe] fetch ${resp.status} for ${frame.url}`);
    frame.readyState = "complete";
    return;
  }
  if (finalUrl !== frame.url) {
    frame.url = finalUrl;
    frame.securityOrigin = originOf(finalUrl);
    frame.isCrossOrigin = originOf(finalUrl) !== originOf(target.url);
    if (frame.isCrossOrigin) {
      try {
        await resp.body?.cancel();
      } catch {}
      frame.readyState = "complete";
      emitFrameNavigated(ctx, target, frame, sessionId);
      return;
    }
  }
  const contentType = resp.headers.get("content-type") ?? "";
  {
    const ct = contentType.split(";")[0]?.trim();
    if (ct) frame.mimeType = ct;
  }
  // Read before the grandchildren below are discovered and fetched.
  frame.referrerPolicy = resp.headers.get("referrer-policy");
  let html: string;
  try {
    const read = await readCappedBytes(resp, MAX_DOCUMENT_BYTES, ctx.connectionId);
    if (!read.ok) {
      console.warn(`[kitesurf-iframe] body read refused (${read.failure}) for ${frame.url}`);
      frame.readyState = "complete";
      return;
    }
    html = decodeHtmlBytes(read.bytes, contentType).html;
  } catch (err) {
    console.warn(
      `[kitesurf-iframe] body read failed for ${frame.url}:`,
      err instanceof Error ? err.message : String(err),
    );
    frame.readyState = "complete";
    return;
  }
  const strip = stripIframeScripts(html, frame.url);
  html = strip.html;
  if (frame.mimeType) {
    const m = frame.mimeType.toLowerCase();
    if (
      m === "text/xml" ||
      m === "application/xml" ||
      m === "application/xhtml+xml" ||
      m === "image/svg+xml"
    ) {
      html = html.replace(/\s+$/, "");
    }
  }
  if (frame.detached || target.frames.get(frame.frameId) !== frame) {
    frame.readyState = "complete";
    return;
  }
  try {
    frame.dom = createDom(html, frame.url);
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

  if (frame.dom && depth < MAX_IFRAME_DEPTH) {
    const nextAncestors = new Set(ancestorUrls);
    nextAncestors.add(frame.url);
    nextAncestors.add(entryUrl);
    const grandchildren = discoverChildFramesFor(target, frame, frame.dom);
    if (grandchildren.length > 0) {
      const attachableGrandchildren = grandchildren.filter(
        (frame) => frame.parentFrameId !== null && frame.lifecycle === "init",
      );
      emitChildFrameAttachAndStart(
        ctx,
        target.frames,
        attachableGrandchildren,
        targetSessions(target, sessionId),
      );
      const waits: Promise<void>[] = [];
      for (const gc of grandchildren) {
        const cycled = nextAncestors.has(gc.url);
        if (cycled) {
          console.warn(`[kitesurf-iframe] cycle detected, skipping fetch for ${gc.url}`);
        }
        if (gc.isCrossOrigin || gc.url === "about:blank" || gc.url === "" || cycled) {
          gc.readyState = "complete";
          gc.pendingLoad = Promise.resolve();
          continue;
        }
        const p = loadChildFrame(ctx, target, gc, sessionId, depth + 1, nextAncestors);
        gc.pendingLoad = p;
        waits.push(p);
      }
      if (waits.length > 0) await Promise.all(waits);
    } else if (depth + 1 >= MAX_IFRAME_DEPTH) {
      if (findIframes(frame.dom).length > 0) {
        console.warn(
          `[kitesurf-iframe] MAX_IFRAME_DEPTH=${MAX_IFRAME_DEPTH} reached at ${frame.url}; nested iframes not discovered`,
        );
      }
    }
  }

  frame.readyState = "complete";
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
  let ids: Int32Array;
  try {
    ids = dom.querySelectorAll("base[href]");
  } catch {
    return null;
  }
  for (const id of ids) {
    if (id < 0) continue;
    const info = safeNodeInfo(dom, id);
    const href = readAttr(info?.attributes, "href");
    if (href) return href;
  }
  return null;
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

async function inlineStylesheets(
  dom: DomHandle,
  pageUrl: string,
  sandboxOutbound: SandboxOutboundOverride,
  connectionId: string,
  {
    cache,
    tracker,
    loaderId,
    frameId,
  }: {
    cache?: StyleCache;
    tracker?: NetworkEventTracker;
    loaderId?: string;
    frameId?: string;
  } = {},
): Promise<void> {
  const links = findStylesheetLinks(dom);
  if (links.length === 0) return;

  const baseUrl = resolveBaseUrl(dom, pageUrl);

  let pageOrigin = "";
  try {
    pageOrigin = new URL(pageUrl).origin;
  } catch {}
  const outbound = sandboxOutbound.parent({
    pageOrigin,
    mainFrameId: frameId ?? "",
    mainLoaderId: loaderId ?? "",
  });

  type Task = {
    nodeId: number;
    href: string;
    resolved: string;
    css?: string;
  };
  const tasks: Task[] = [];

  for (const { nodeId, href } of links) {
    let resolved: string;
    try {
      resolved = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    tasks.push({ nodeId, href, resolved });
  }

  if (tasks.length === 0) return;

  const now = Date.now();
  const fetchTasks: Task[] = [];
  for (const t of tasks) {
    const hit = cache?.get(t.resolved);
    if (hit && now - hit.fetchedAt < STYLE_CACHE_TTL_MS) {
      t.css = hit.css;
      if (tracker && loaderId && frameId) {
        const reqId = tracker.beginRequest({
          url: t.resolved,
          method: "GET",
          headers: { accept: "text/css,*/*;q=0.1" },
          type: "Stylesheet",
          initiator: { type: "parser", url: pageUrl },
          loaderId,
          frameId,
        });
        tracker.completeRequest(reqId, {
          url: t.resolved,
          status: 200,
          statusText: "OK",
          headers: { "content-type": "text/css" },
          mimeType: "text/css",
          bodyLength: hit.css.length,
          body: hit.css,
          bodyBase64Encoded: false,
          fromDiskCache: true,
        });
      }
    } else {
      fetchTasks.push(t);
    }
  }

  await Promise.all(
    fetchTasks.map(async (t) => {
      const reqHeaders = {
        accept: "text/css,*/*;q=0.1",
        "x-kitesurf-page-origin": pageOrigin,
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      };
      const reqId =
        tracker && loaderId && frameId
          ? tracker.beginRequest({
              url: t.resolved,
              method: "GET",
              headers: reqHeaders,
              type: "Stylesheet",
              initiator: { type: "parser", url: pageUrl },
              loaderId,
              frameId,
            })
          : null;

      try {
        const walk = await walkRedirects({
          url: t.resolved,
          headers: reqHeaders,
          signal: AbortSignal.timeout(SHEET_WALK_BUDGET_MS),
          fetchHop: (hopReq) => outbound.fetch(hopReq),
        });
        if (!walk.ok) {
          if (reqId && tracker) {
            tracker.failRequest(reqId, "net::ERR_TOO_MANY_REDIRECTS");
          }
          return;
        }
        const resp = walk.response;
        if (resp.status >= 200 && resp.status < 300) {
          const read = await readCappedText(resp, MAX_STYLESHEET_BYTES, connectionId);
          if (!read.ok) {
            console.warn(`[kitesurf-css] stylesheet read refused (${read.failure}): ${t.resolved}`);
            if (reqId && tracker) {
              tracker.failRequest(reqId, cappedErrorText(read.failure));
            }
            return;
          }
          const css = read.text;
          t.css = css;
          if (cache) cache.set(t.resolved, { css, fetchedAt: now });
          if (reqId && tracker) {
            tracker.completeRequest(reqId, {
              url: t.resolved,
              status: resp.status,
              statusText: resp.statusText,
              headers: headersToRecord(resp.headers),
              mimeType: resp.headers.get("content-type") ?? "text/css",
              bodyLength: css.length,
              body: css,
              bodyBase64Encoded: false,
            });
          }
        } else if (reqId && tracker) {
          tracker.completeRequest(reqId, {
            url: t.resolved,
            status: resp.status,
            statusText: resp.statusText,
            headers: headersToRecord(resp.headers),
            mimeType: resp.headers.get("content-type") ?? "text/css",
            bodyLength: 0,
          });
        }
      } catch (err) {
        if (reqId && tracker) {
          tracker.failRequest(reqId, err instanceof Error ? err.message : String(err));
        }
      }
    }),
  );

  for (const t of tasks) {
    try {
      if (t.css !== undefined) {
        const styleId = dom.createElement("style");
        dom.applyOps(
          JSON.stringify([
            {
              kind: "setAttribute",
              node: styleId,
              name: "data-cs-inlined-from",
              value: t.href,
            },
          ]),
        );
        const textId = dom.createTextNode(t.css);
        dom.appendChildNode(styleId, textId);
        dom.replaceChildNode(styleId, t.nodeId);
      } else {
        dom.removeNode(t.nodeId);
      }
    } catch (err) {
      console.warn(
        "kitesurf: inlineStylesheets mutation failed for",
        t.href,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
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

async function screencastLoop(
  ctx: DispatchCtx,
  target: TargetState,
  state: ScreencastState,
): Promise<void> {
  let skipCounter = 0;
  let placeholderConfigurationVersion = -1;
  let noDocPlaceholderSent = false;

  console.log(
    `[kitesurf-screencast] loop start target=${target.targetId} ` +
      `format=${state.format} quality=${state.quality} ` +
      `maxWidth=${state.maxWidth} maxHeight=${state.maxHeight} ` +
      `everyNthFrame=${state.everyNthFrame}`,
  );
  const now = makeWallClock(ctx.env);
  const loopStartedAt = now();
  let exitReason = "unknown";
  type InFlightRender = {
    promise: ReturnType<typeof renderViaPageRenderer>;
    isCurrent: () => boolean;
    seq: number;
    settled: boolean;
  };
  let inFlight: InFlightRender | null = null;
  let seqGeneration = target.navigateGeneration;
  const renderedOrInFlightSeq = (): number =>
    Math.max(state.lastRenderedMutationSeq, inFlight?.isCurrent() ? inFlight.seq : -1);
  const autoStopForAck = (why: string): void => {
    console.warn(`kitesurf: screencast auto-stop ${why}`);
    state.stopped = true;
    ctx.browser.screencasts.delete(target.targetId);
    stopAndRemoveWheelQueue(ctx.browser, target.targetId, state.ownerSessionId, state.wheelQueue);
  };
  try {
    const sendPlaceholder = async (): Promise<boolean> => {
      try {
        const { renderHtmlToImage } = await import("../wasm.ts");
        const bytes = renderHtmlToImage(
          PLACEHOLDER_HTML,
          "https://kitesurf.local/",
          state.maxWidth,
          state.maxHeight,
          state.format,
          state.quality,
        );
        if (
          bytes.length === 0 ||
          state.stopped ||
          ctx.browser.wsClosing ||
          ctx.browser.screencasts.get(target.targetId) !== state ||
          state.configurationVersion !== state.appliedConfigurationVersion
        ) {
          return false;
        }
        emitFrame(bytes, -1);
        return true;
      } catch (err) {
        console.warn("kitesurf: placeholder frame render threw", err);
        return false;
      }
    };

    const sendPlaceholderIfNeeded = async (): Promise<void> => {
      if (
        placeholderConfigurationVersion === state.appliedConfigurationVersion ||
        state.frameSeq - state.lastAckedSeq >= state.maxInFlight
      ) {
        return;
      }
      if (await sendPlaceholder()) {
        placeholderConfigurationVersion = state.appliedConfigurationVersion;
      }
    };

    const emitFrame = (bytes: Uint8Array, mutationSeq: number, scrollX = 0, scrollY = 0) => {
      state.lastRenderedMutationSeq = mutationSeq;
      state.frameSeq += 1;
      const sid = state.frameSeq;
      if (state.pendingAckSessionId === null) {
        state.pendingAckSessionId = sid;
        state.pendingAckSetAt = now();
      }

      const recipient = state.ownerSessionId;

      const data = bytesToBase64(bytes);
      ctx.emit({
        method: "Page.screencastFrame",
        params: {
          data,
          metadata: {
            offsetTop: 0,
            pageScaleFactor: 1,
            deviceWidth: state.maxWidth,
            deviceHeight: state.maxHeight,
            scrollOffsetX: scrollX,
            scrollOffsetY: scrollY,
            timestamp: now() / MILLISECONDS_PER_SECOND,
          },
          sessionId: sid,
        },
        sessionId: recipient,
      });
    };

    let targetPeriod = state.pollIntervalMs;
    let ackPollCap = Math.max(
      MIN_ACK_POLL_INTERVAL_MS,
      Math.min(MAX_ACK_POLL_INTERVAL_MS, targetPeriod),
    );
    let pacingConfigurationVersion = state.appliedConfigurationVersion;
    let nextFrameDue = 0;
    let idleUntil = 0;

    const nap = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const done = (): void => {
          if (state.wake === wake) state.wake = undefined;
          resolve();
        };
        let timer = setTimeout(done, ms);
        const wake = (): void => {
          clearTimeout(timer);
          timer = setTimeout(done, 0);
        };
        state.wake = wake;
      });

    async function settle(pending: InFlightRender): Promise<void> {
      const viaRenderer = await pending.promise;
      if (!pending.isCurrent()) return;
      if ("failed" in viaRenderer) {
        state.lastRenderError = viaRenderer.failed;
        state.framesDropped += 1;
        if (viaRenderer.stage !== "record") return;
        if (viaRenderer.failed.includes(NO_DOCUMENT_YET)) {
          if (!noDocPlaceholderSent && (await sendPlaceholder())) {
            noDocPlaceholderSent = true;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, NO_DOCUMENT_BACKOFF_MS));
          return;
        }
        state.consecutiveRenderFailures += 1;
        if (state.consecutiveRenderFailures >= RENDER_FAILURE_LIMIT) {
          console.warn(
            "kitesurf: screencast record failed " +
              `${state.consecutiveRenderFailures}x (${viaRenderer.failed})` +
              " — placeholder until next navigate.",
          );
          ctx.browser.dedicatedWorkers.terminateTarget(target.targetId, "render failure");
          void retireStub(target, "renderFailure", "screencast: persistent record failure", {
            budget: ctx.browser.workerBudget,
          });
          placeholderConfigurationVersion = -1;
          state.consecutiveRenderFailures = 0;
        }
        return;
      }
      state.consecutiveRenderFailures = 0;
      state.lastRenderError = null;
      noDocPlaceholderSent = false;
      if (viaRenderer.unchanged) {
        if (viaRenderer.seq > state.lastRenderedMutationSeq) {
          state.lastRenderedMutationSeq = viaRenderer.seq;
        }
        return;
      }
      if (viaRenderer.bytes && viaRenderer.bytes.length > 0) {
        while (state.frameSeq - state.lastAckedSeq >= state.maxInFlight) {
          if (!pending.isCurrent()) break;
          if (
            state.pendingAckSessionId !== null &&
            now() - state.pendingAckSetAt > ACK_TIMEOUT_MS
          ) {
            autoStopForAck("waiting for ack before emit");
            break;
          }
          await nap(ackPollCap);
        }
        if (!pending.isCurrent()) return;
        emitFrame(viaRenderer.bytes, viaRenderer.seq, viaRenderer.scrollX, viaRenderer.scrollY);
      }
    }

    while (!state.stopped) {
      const now0 = now();
      const until = nextFrameDue - now0;
      await nap(idleUntil > now0 ? idleUntil - now0 : until > 0 ? Math.min(until, ackPollCap) : 1);
      idleUntil = 0;
      if (state.stopped) break;
      if (
        state.configurationVersion === state.appliedConfigurationVersion &&
        state.appliedConfigurationVersion !== pacingConfigurationVersion
      ) {
        pacingConfigurationVersion = state.appliedConfigurationVersion;
        targetPeriod = state.pollIntervalMs;
        ackPollCap = Math.max(
          MIN_ACK_POLL_INTERVAL_MS,
          Math.min(MAX_ACK_POLL_INTERVAL_MS, targetPeriod),
        );
        nextFrameDue = 0;
      }

      ctx.browser.networkEvents.drain();

      if (state.pendingAckSessionId !== null) {
        const elapsed = now() - state.pendingAckSetAt;
        if (elapsed > ACK_TIMEOUT_MS) {
          autoStopForAck(`after ${elapsed} ms with no ack`);
          break;
        }
      }
      if (
        inFlight?.settled &&
        now() < nextFrameDue &&
        state.frameSeq - state.lastAckedSeq < state.maxInFlight
      ) {
        const done = inFlight;
        inFlight = null;
        await settle(done);
        continue;
      }

      const nowGate = now();
      if (nowGate < nextFrameDue) continue;
      nextFrameDue =
        nextFrameDue === 0 || nowGate - nextFrameDue > targetPeriod
          ? nowGate + targetPeriod
          : nextFrameDue + targetPeriod;

      if (state.configurationVersion !== state.appliedConfigurationVersion) {
        continue;
      }

      if (!target.pageScript) {
        await sendPlaceholderIfNeeded();
        if (inFlight) {
          const stale = inFlight.promise;
          inFlight = null;
          await stale.catch(() => {});
        }
        continue;
      }

      placeholderConfigurationVersion = -1;

      pumpOopifFrames(ctx, target);

      const canIdle =
        seqGeneration === target.navigateGeneration &&
        !inFlight &&
        ![...target.frames.values()].some((f) => f.pageScript);
      state.paintDirty = false;
      const pump = await pumpPageTasks(
        target,
        PUMP_TASKS_TIMEOUT_MS,
        canIdle ? state.lastRenderedMutationSeq : undefined,
        targetPeriod,
      );
      if (state.stopped) break;
      if (pump?.nextRafDelayMs !== undefined && pump.nextRafDelayMs > 0) {
        nextFrameDue = Math.min(nextFrameDue, now() + pump.nextRafDelayMs);
      }
      if (pump?.idle && !inFlight && !state.paintDirty) {
        idleUntil = now() + IDLE_SCREENCAST_WAKE_MS;
      }

      if (seqGeneration !== target.navigateGeneration) {
        seqGeneration = target.navigateGeneration;
        state.lastRenderedMutationSeq = -1;
      }

      let next: InFlightRender | null = null;
      dispatch: {
        if (state.maxInFlight <= 1) {
          if (!pump) break dispatch;
          if (pump.seq <= renderedOrInFlightSeq() && !pump.animating) {
            break dispatch;
          }
        }

        if (state.everyNthFrame > 1) {
          skipCounter++;
          if (skipCounter < state.everyNthFrame) break dispatch;
          skipCounter = 0;
        }

        const renderGeneration = target.navigateGeneration;
        const renderPageScript = target.pageScript;
        if (!renderPageScript) break dispatch;
        const renderConfigurationVersion = state.configurationVersion;
        const renderIsCurrent = () =>
          !state.stopped &&
          !ctx.browser.wsClosing &&
          ctx.browser.screencasts.get(target.targetId) === state &&
          target.navigateGeneration === renderGeneration &&
          target.pageScript === renderPageScript &&
          state.configurationVersion === renderConfigurationVersion &&
          state.appliedConfigurationVersion === renderConfigurationVersion;
        if (!renderIsCurrent()) break dispatch;
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
          isCurrent: renderIsCurrent,
        };
        const markSettled = (): void => {
          render.settled = true;
          state.wake?.();
        };
        render.promise.then(markSettled, markSettled);
        next = render;
      }

      const pending = inFlight;
      inFlight = next;
      if (!pending) continue;
      await settle(pending);
    }
  } finally {
    if (inFlight) {
      await inFlight.promise.catch(() => {});
    }
    exitReason = state.stopped ? "state.stopped" : exitReason;
    const elapsed = now() - loopStartedAt;
    console.log(
      `[kitesurf-screencast] loop end target=${target.targetId} ` +
        `reason=${exitReason} elapsedMs=${elapsed} ` +
        `frameSeq=${state.frameSeq} ` +
        `pendingAck=${state.pendingAckSessionId}`,
    );
  }
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
