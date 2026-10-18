// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Manages CDP browser contexts, targets, sessions, and their lifecycle resources.

import type { BrowserState, CdpRequest } from "./types.ts";
import { makeSessionId, makeTargetId, type FrameState, type TargetState } from "./types.ts";
import type { Protocol } from "devtools-protocol";
import type { DispatchCtx } from "./dispatch.ts";
import { domainAndRegistryOf, makeMainFrameState } from "./frames.ts";
import { retireStub } from "./page-script-generation.ts";
import { createCookieJar, type CookieJar } from "../cookies.ts";
import { engineWasmBytes, engineWasmInitialBytes } from "../engine-wasm-probe.ts";
import { isolateRetainedBodyBytesTotal } from "./network-events.ts";
import { imageStoreStats } from "../eval/resource-store.ts";
import { assetCacheRetainedBytes } from "../eval/outbound.ts";
import { clearLearnedScripts } from "../eval/learned-scripts.ts";
import { releaseParkedForConnection } from "./fetch-interception.ts";
import { releaseAllDomHandles } from "./dom-release.ts";
import { stubQueryDom } from "./page-session.ts";
import { detachWebMcpSession } from "./webmcp.ts";
import { stopSceneStreams } from "./scene-stream.ts";
import { cancelAndRemoveTargetWheelQueues, stopAndRemoveWheelQueue } from "./wheel-queue.ts";
import { registerCookieJar, unregisterCookieJar, cookieKeyFor } from "./cookie-jar-registry.ts";

const BROWSER_TARGET_ID = "browser";

function announceExistingOopifTargets(ctx: DispatchCtx): void {
  for (const target of ctx.browser.targets.values()) {
    for (const frame of target.frames.values()) {
      if (frame.pageScript) announceOopifTarget(ctx, frame);
    }
  }
}

function updateFrameSessionAttribution(
  ctx: DispatchCtx,
  frame: FrameState,
  sessionId: string,
): void {
  if (!frame.sessions.delete(sessionId)) return;
  if (frame.detached) {
    ctx.browser.networkEvents.deleteTargetAttribution(frame.frameId);
    return;
  }
  ctx.browser.networkEvents.setTargetAttribution(
    frame.frameId,
    frame.loaderId,
    Array.from(frame.sessions),
  );
}

export function detachSessions(ctx: DispatchCtx, sessions: Set<string>, targetId: string): void {
  for (const sessionId of sessions) {
    ctx.emit({
      method: "Target.detachedFromTarget",
      params: { sessionId, targetId },
    });
    ctx.browser.networkEvents.forgetSession(sessionId);
  }
  sessions.clear();
}

export function jarForTarget(ctx: DispatchCtx, target: TargetState | null | undefined): CookieJar {
  const cid = target?.browserContextId;
  if (cid) {
    const entry = ctx.browser.contexts.get(cid);
    if (entry) return entry.cookieJar;
  }
  return ctx.browser.cookies;
}

export function jarForContextId(ctx: DispatchCtx, browserContextId: string | undefined): CookieJar {
  if (browserContextId) {
    const entry = ctx.browser.contexts.get(browserContextId);
    if (!entry) {
      // Falling back to the default jar here would cross browser-context boundaries.
      throw new Error(`Failed to find browser context with id ${browserContextId}`);
    }
    return entry.cookieJar;
  }
  return ctx.browser.cookies;
}

export async function handleTarget(ctx: DispatchCtx, req: CdpRequest): Promise<unknown> {
  switch (req.method) {
    case "Target.setDiscoverTargets":
    case "Target.setRemoteLocations":
      return {};

    case "Target.setAutoAttach": {
      if (req.sessionId) return {};

      ctx.browser.autoAttach = Boolean(req.params?.autoAttach);
      ctx.browser.flatten = Boolean(req.params?.flatten);
      if (ctx.browser.autoAttach && ctx.browser.connectionMode !== "page") {
        for (const t of ctx.browser.targets.values()) {
          if (t.type !== "page") continue;
          if (t.sessions.size > 0) continue;
          autoAttachTarget(ctx, t);
        }
      }
      if (ctx.browser.autoAttach && ctx.browser.connectionMode === "page") {
        announceRendererTarget(ctx);
        announceEngineTarget(ctx);
        announceExistingOopifTargets(ctx);
      }
      return {};
    }

    case "Target.getTargets": {
      const infos: Protocol.Target.TargetInfo[] = [];
      for (const t of ctx.browser.targets.values()) {
        infos.push(targetInfo(ctx, t));
        if (t.type !== "page" || ctx.browser.connectionMode !== "browser") continue;
        for (const frame of t.frames.values()) {
          if (frame.parentFrameId === null) continue;
          infos.push(frameTargetInfo(frame));
        }
      }
      return { targetInfos: infos };
    }

    case "Target.getTargetInfo": {
      const id = req.params?.targetId ?? BROWSER_TARGET_ID;
      if (id === RENDERER_TARGET_ID) {
        return { targetInfo: rendererTargetInfo(ctx) };
      }
      if (id === ENGINE_TARGET_ID) {
        return { targetInfo: engineTargetInfo(ctx) };
      }
      const t = ctx.browser.targets.get(id);
      if (!t) throw new Error(`No target with id ${id}`);
      return { targetInfo: targetInfo(ctx, t) };
    }

    case "Target.createBrowserContext": {
      const id = `ctx-${ctx.browser.nextBrowserContextId++}`;
      const jar = createCookieJar();
      ctx.browser.contexts.set(id, { cookieJar: jar });
      registerCookieJar(cookieKeyFor(ctx.connectionId, id), jar);
      return { browserContextId: id };
    }

    case "Target.disposeBrowserContext": {
      const id = req.params?.browserContextId;
      if (id && ctx.browser.contexts.has(id)) {
        const closes: Promise<boolean>[] = [];
        for (const t of Array.from(ctx.browser.targets.values())) {
          if (t.browserContextId === id) closes.push(closeTargetInternal(ctx, t.targetId));
        }
        await Promise.all(closes);
        ctx.browser.contexts.delete(id);
        unregisterCookieJar(cookieKeyFor(ctx.connectionId, id));
        clearLearnedScripts(ctx.browser.learnedInsertedScripts, id);
      }
      return {};
    }

    case "Target.getBrowserContexts":
      return { browserContextIds: Array.from(ctx.browser.contexts.keys()) };

    case "Target.createTarget": {
      const url = req.params?.url ?? "about:blank";
      const bctx = req.params?.browserContextId;
      if (bctx && !ctx.browser.contexts.has(bctx)) {
        throw new Error(`Failed to find browser context with id ${bctx}`);
      }
      const target = createPageTarget(ctx, url, bctx || undefined);
      ctx.emit({
        method: "Target.targetCreated",
        params: { targetInfo: targetInfo(ctx, target) },
      });
      if (ctx.browser.autoAttach) {
        autoAttachTarget(ctx, target);
      }
      return { targetId: target.targetId };
    }

    case "Target.closeTarget": {
      const existed = await closeTargetInternal(ctx, req.params!.targetId);
      return { success: existed };
    }

    case "Target.attachToTarget": {
      const id = req.params!.targetId;
      if (id === RENDERER_TARGET_ID) {
        const sessionId = announceRendererTarget(ctx);
        if (!sessionId) throw new Error("pageRenderer is disabled");
        return { sessionId };
      }
      if (id === ENGINE_TARGET_ID) {
        return { sessionId: announceEngineTarget(ctx) };
      }
      const target = ctx.browser.targets.get(id);
      if (target) {
        const sessionId = makeSessionId();
        target.sessions.add(sessionId);
        ctx.browser.networkEvents.setTargetAttribution(
          target.frameId,
          target.loaderId,
          Array.from(target.sessions),
        );
        ctx.emit({
          method: "Target.attachedToTarget",
          params: {
            sessionId,
            targetInfo: targetInfo(ctx, target),
            waitingForDebugger: false,
          },
        });
        return { sessionId };
      }
      if (ctx.browser.connectionMode === "browser") {
        for (const parent of ctx.browser.targets.values()) {
          const frame = parent.frames.get(id);
          if (!frame || frame.parentFrameId === null || frame.detached) continue;
          const sessionId = makeSessionId();
          frame.sessions.add(sessionId);
          ctx.browser.networkEvents.setTargetAttribution(
            frame.frameId,
            frame.loaderId,
            Array.from(frame.sessions),
          );
          ctx.emit({
            method: "Target.attachedToTarget",
            params: {
              sessionId,
              targetInfo: frameTargetInfo(frame),
              waitingForDebugger: false,
            },
          });
          return { sessionId };
        }
      }
      throw new Error(`No target with id ${id}`);
    }

    case "Target.attachToBrowserTarget": {
      const sessionId = makeSessionId();
      const browser = ctx.browser.targets.get(BROWSER_TARGET_ID);
      if (browser) browser.sessions.add(sessionId);
      return { sessionId };
    }

    case "Target.detachFromTarget": {
      const sessionId = req.params?.sessionId;
      if (sessionId) {
        for (const t of ctx.browser.targets.values()) {
          if (t.sessions.delete(sessionId)) {
            ctx.browser.networkEvents.setTargetAttribution(
              t.frameId,
              t.loaderId,
              Array.from(t.sessions),
            );
          }
          detachWebMcpSession(t, sessionId);
          const stream = ctx.browser.screencasts.get(t.targetId);
          if (stream?.ownerSessionId === sessionId) {
            stream.stopped = true;
            ctx.browser.screencasts.delete(t.targetId);
            stopAndRemoveWheelQueue(
              ctx.browser,
              t.targetId,
              stream.ownerSessionId,
              stream.wheelQueue,
            );
          }
          for (const frame of t.frames.values()) {
            updateFrameSessionAttribution(ctx, frame, sessionId);
          }
        }
        ctx.browser.networkEvents.forgetSession(sessionId);
        if (sessionId === ctx.browser.rendererSessionId) {
          ctx.browser.rendererSessionId = null;
        }
      }
      return {};
    }

    case "Target.activateTarget":
      return {};

    default:
      return {};
  }
}

export function ensureBrowserTarget(ctx: DispatchCtx): TargetState {
  let t = ctx.browser.targets.get(BROWSER_TARGET_ID);
  if (t) return t;
  t = {
    targetId: BROWSER_TARGET_ID,
    type: "browser",
    sessions: new Set(),
    url: "",
    title: "",
    html: "",
    dom: null,
    docScan: null,
    domEpoch: 0,
    loaderId: BROWSER_TARGET_ID,
    frameId: BROWSER_TARGET_ID,
    frames: new Map(),
    pageScript: null,
    pageScriptLease: null,
    navigateGeneration: 0,
    wheelTeardownDepth: 0,
    defaultContextId: 0,
    navigationHistory: [],
    navigationHistoryIndex: 0,
    nextNavigationHistoryId: 1,
    viewportWidth: null,
    viewportHeight: null,
    screencastConfigurationBarrier: Promise.resolve(),
    screencastConfigurationVersion: 0,
    emulatedMedia: "screen",
    refetchOnPushState: false,
    autoReloadUrl: null,
    autoReloadCount: 0,
    lastLoadAt: 0,
    layoutMode: ctx.browser.layoutMode,
    compiledScripts: [],
    debuggerEnabledSessions: new Set(),
    domEnabledSessions: new Set(),
    cssEnabledSessions: new Set(),
    webmcpSessions: new Set(),
    webmcpEnableRevisions: new Map(),
    webmcpWatchRevision: 0,
    webmcpAnnouncedTools: new Map(),
    styleSheets: new Map(),
    nextStyleSheetRev: new Map(),
    lastNavigatePhases: null,
    extraHttpHeaders: {},
    userAgentOverride: "",
  };
  ctx.browser.targets.set(BROWSER_TARGET_ID, t);
  return t;
}

export async function closeTargetInternal(ctx: DispatchCtx, id: string): Promise<boolean> {
  const target = ctx.browser.targets.get(id);
  const retirements: Promise<unknown>[] = [];
  if (target) {
    try {
      target.pendingNavAbort?.abort();
    } catch {}
    target.pendingNavAbort = null;
    target.navigateGeneration++;
    target.blankReady = null;
    target.wheelTeardownDepth += 1;
    const stream = ctx.browser.screencasts.get(id);
    if (stream) stream.stopped = true;
    ctx.browser.screencasts.delete(id);
    void cancelAndRemoveTargetWheelQueues(ctx.browser, id);
    ctx.browser.dedicatedWorkers.terminateTarget(id, "Target.closeTarget");
    retirements.push(
      retireStub(target, "closeTarget", "Target.closeTarget", {
        budget: ctx.browser.workerBudget,
        awaitTeardown: true,
      }),
    );
  }
  if (target) {
    // Puppeteer resolves page.close() on Target.detachedFromTarget, before targetDestroyed.
    detachSessions(ctx, target.sessions, id);
    ctx.browser.networkEvents.deleteTargetAttribution(target.frameId);
    for (const frame of target.frames.values()) {
      if (frame.frameId !== target.frameId) {
        ctx.browser.networkEvents.deleteTargetAttribution(frame.frameId);
      }
      for (const sessionId of frame.sessions) {
        ctx.browser.networkEvents.forgetSession(sessionId);
      }
      frame.sessions.clear();
      frame.detached = true;
      const prespawn = frame.oopifPrespawn;
      if (prespawn) {
        frame.oopifPrespawn = undefined;
        frame.pageScriptLease?.release();
        frame.pageScriptLease = null;
        ctx.ctx.waitUntil(
          prespawn.promise.then(async (pre) => {
            if (!pre) return;
            try {
              const { discardPrespawnedFrame } = await import("../eval/oopif-render.ts");
              await discardPrespawnedFrame(pre, "Target.closeTarget");
            } catch {}
          }),
        );
      }
      frame.lastRenderSeq = -1;
      frame.execContextId = 0;
      retirements.push(
        retireStub(frame, "closeTarget", "Target.closeTarget", {
          budget: ctx.browser.workerBudget,
          awaitTeardown: true,
        }),
      );
    }
    releaseAllDomHandles(target);
  }
  const existed = ctx.browser.targets.delete(id);
  stopSceneStreams(ctx.browser, id);
  if (existed) {
    ctx.emit({
      method: "Target.targetDestroyed",
      params: { targetId: id },
    });
  }
  releaseParkedForConnection(ctx.connectionId);
  await Promise.all(retirements);
  return existed;
}

export function createPageTarget(
  ctx: DispatchCtx,
  url: string,
  browserContextId?: string,
): TargetState {
  const targetId = makeTargetId();
  const loaderId = makeTargetId();
  const frames = new Map<string, FrameState>();
  frames.set(targetId, makeMainFrameState({ frameId: targetId, loaderId, url }));
  const t: TargetState = {
    targetId,
    type: "page",
    browserContextId,
    sessions: new Set(),
    url,
    title: "",
    html: "",
    dom: null,
    docScan: null,
    domEpoch: 0,
    loaderId,
    frameId: targetId,
    frames,
    pageScript: null,
    pageScriptLease: null,
    navigateGeneration: 0,
    wheelTeardownDepth: 0,
    defaultContextId: 0,
    navigationHistory: [
      {
        id: 1,
        url,
        userTypedURL: url,
        title: "",
        transitionType: "typed",
      },
    ],
    navigationHistoryIndex: 0,
    nextNavigationHistoryId: 2,
    viewportWidth: null,
    viewportHeight: null,
    screencastConfigurationBarrier: Promise.resolve(),
    screencastConfigurationVersion: 0,
    emulatedMedia: "screen",
    refetchOnPushState: false,
    autoReloadUrl: null,
    autoReloadCount: 0,
    lastLoadAt: 0,
    layoutMode: ctx.browser.layoutMode,
    compiledScripts: [],
    debuggerEnabledSessions: new Set(),
    domEnabledSessions: new Set(),
    cssEnabledSessions: new Set(),
    webmcpSessions: new Set(),
    webmcpEnableRevisions: new Map(),
    webmcpWatchRevision: 0,
    webmcpAnnouncedTools: new Map(),
    styleSheets: new Map(),
    nextStyleSheetRev: new Map(),
    lastNavigatePhases: null,
    extraHttpHeaders: {},
    userAgentOverride: "",
  };
  ctx.browser.targets.set(targetId, t);
  return t;
}

export function autoAttachTarget(ctx: DispatchCtx, target: TargetState): string {
  const sessionId = makeSessionId();
  target.sessions.add(sessionId);
  ctx.browser.networkEvents.setTargetAttribution(
    target.frameId,
    target.loaderId,
    Array.from(target.sessions),
  );
  ctx.emit({
    method: "Target.attachedToTarget",
    params: {
      sessionId,
      targetInfo: targetInfo(ctx, target),
      waitingForDebugger: false,
    },
  });
  return sessionId;
}

function targetInfo(ctx: DispatchCtx, t: TargetState) {
  return {
    targetId: t.targetId,
    type: t.type,
    title: t.title,
    url: t.url,
    attached: t.sessions.size > 0 || (ctx.browser.connectionMode === "page" && t.type === "page"),
    canAccessOpener: false,
    browserContextId: t.browserContextId ?? "default",
  };
}

export function frameTargetInfo(frame: FrameState): Protocol.Target.TargetInfo {
  return {
    targetId: frame.frameId,
    type: "iframe",
    title: "",
    url: frame.url,
    attached: frame.sessions.size > 0,
    canAccessOpener: false,
    openerFrameId: frame.parentFrameId ?? undefined,
    browserContextId: "default",
  };
}

export function emitFrameTarget(ctx: DispatchCtx, frame: FrameState): string | null {
  if (ctx.browser.connectionMode !== "browser") return null;
  const info = frameTargetInfo(frame);
  ctx.emit({
    method: "Target.targetCreated",
    params: { targetInfo: info },
  });
  if (!ctx.browser.autoAttach) return null;
  const sessionId = makeSessionId();
  frame.sessions.add(sessionId);
  ctx.browser.networkEvents.setTargetAttribution(
    frame.frameId,
    frame.loaderId,
    Array.from(frame.sessions),
  );
  ctx.emit({
    method: "Target.attachedToTarget",
    params: {
      sessionId,
      targetInfo: { ...info, attached: true },
      waitingForDebugger: false,
    },
  });
  return sessionId;
}

export const RENDERER_TARGET_ID = "kitesurf-page-renderer";

function rendererTargetInfo(ctx: DispatchCtx) {
  return {
    targetId: RENDERER_TARGET_ID,
    type: "worker",
    title: "PageRenderer",
    url: "kitesurf://renderer/page-renderer.js",
    attached: ctx.browser.rendererSessionId !== null,
    canAccessOpener: false,
    browserContextId: "default",
  };
}

export function announceRendererTarget(ctx: DispatchCtx): string | null {
  if (ctx.browser.rendererSessionId) return ctx.browser.rendererSessionId;
  const sessionId = makeSessionId();
  ctx.browser.rendererSessionId = sessionId;
  ctx.emit({
    method: "Target.attachedToTarget",
    params: {
      sessionId,
      targetInfo: { ...rendererTargetInfo(ctx), attached: true },
      waitingForDebugger: false,
    },
  });
  return sessionId;
}

export const ENGINE_TARGET_ID = "kitesurf-engine";

function engineTargetInfo(ctx: DispatchCtx) {
  return {
    targetId: ENGINE_TARGET_ID,
    type: "worker",
    title: "Engine",
    url: "kitesurf://engine/index.js",
    attached: ctx.browser.engineSessionId !== null,
    canAccessOpener: false,
    browserContextId: "default",
  };
}

export function announceEngineTarget(ctx: DispatchCtx): string {
  if (ctx.browser.engineSessionId) return ctx.browser.engineSessionId;
  const sessionId = makeSessionId();
  ctx.browser.engineSessionId = sessionId;
  ctx.emit({
    method: "Target.attachedToTarget",
    params: {
      sessionId,
      targetInfo: { ...engineTargetInfo(ctx), attached: true },
      waitingForDebugger: false,
    },
  });
  return sessionId;
}

export function engineMemoryBreakdown(browser: BrowserState): {
  wasmBytes: number;
  wasmInitialBytes: number;
  wasmDeltaBytes: number;
  retainedBodyBytes: number;
  retainedBodyBytesIsolate: number;
  retainedRequestCount: number;
  retainedImageBytes: number;
  retainedImageCount: number;
  fontAssetCacheBytes: number;
  accountedBytes: number;
} {
  const wasmBytes = engineWasmBytes();
  const wasmInitialBytes = engineWasmInitialBytes();
  const retainedBodyBytes = browser.networkEvents.retainedBodyBytes();
  const retainedBodyBytesIsolate = isolateRetainedBodyBytesTotal();
  const fontAssetCacheBytes = assetCacheRetainedBytes();
  const images = imageStoreStats();
  return {
    wasmBytes,
    wasmInitialBytes,
    wasmDeltaBytes: Math.max(0, wasmBytes - wasmInitialBytes),
    retainedBodyBytes,
    retainedBodyBytesIsolate,
    retainedRequestCount: browser.networkEvents.retainedRequestCount(),
    retainedImageBytes: images.bytes,
    retainedImageCount: images.count,
    fontAssetCacheBytes,
    accountedBytes: wasmBytes + retainedBodyBytesIsolate + images.bytes + fontAssetCacheBytes,
  };
}

export async function handleEngineSession(ctx: DispatchCtx, req: CdpRequest): Promise<unknown> {
  switch (req.method) {
    case "Runtime.enable": {
      ctx.emit({
        method: "Runtime.executionContextCreated",
        params: {
          context: {
            id: 1,
            origin: "kitesurf://engine",
            name: "Engine",
            uniqueId: "kitesurf-engine-context",
          },
        },
        sessionId: req.sessionId,
      });
      return {};
    }
    case "Runtime.getHeapUsage": {
      const { accountedBytes } = engineMemoryBreakdown(ctx.browser);
      return { usedSize: accountedBytes, totalSize: accountedBytes };
    }
    default:
      return {};
  }
}

export async function handleRendererSession(ctx: DispatchCtx, req: CdpRequest): Promise<unknown> {
  switch (req.method) {
    case "Runtime.enable": {
      ctx.emit({
        method: "Runtime.executionContextCreated",
        params: {
          context: {
            id: 1,
            origin: "kitesurf://renderer",
            name: "PageRenderer",
            uniqueId: "kitesurf-renderer-context",
          },
        },
        sessionId: req.sessionId,
      });
      return {};
    }
    case "Runtime.getHeapUsage": {
      const mem = await ctx.browser.rendererManager?.memoryStats();
      const usedSize = mem?.bytes ?? 0;
      return { usedSize, totalSize: usedSize };
    }
    default:
      return {};
  }
}

export function findOopifFrameBySession(
  ctx: DispatchCtx,
  sessionId: string,
): { target: TargetState; frame: FrameState } | null {
  for (const t of ctx.browser.targets.values()) {
    for (const f of t.frames.values()) {
      if (f.pageScript && f.sessions.has(sessionId)) {
        return { target: t, frame: f };
      }
    }
  }
  return null;
}

export function announceOopifTarget(ctx: DispatchCtx, frame: FrameState): string | null {
  if (ctx.browser.connectionMode !== "page") return null;
  if (!ctx.browser.autoAttach) return null;
  if (!frame.pageScript) return null;
  const existing = frame.sessions.values().next();
  if (!existing.done) {
    ctx.browser.networkEvents.setTargetAttribution(
      frame.frameId,
      frame.loaderId,
      Array.from(frame.sessions),
    );
    return existing.value;
  }
  const sessionId = makeSessionId();
  frame.sessions.add(sessionId);
  ctx.browser.networkEvents.setTargetAttribution(
    frame.frameId,
    frame.loaderId,
    Array.from(frame.sessions),
  );
  ctx.emit({
    method: "Target.attachedToTarget",
    params: {
      sessionId,
      targetInfo: { ...frameTargetInfo(frame), attached: true },
      waitingForDebugger: false,
    },
  });
  return sessionId;
}

export function destroyOopifTarget(
  ctx: DispatchCtx,
  frame: Pick<FrameState, "frameId" | "sessions">,
): void {
  detachSessions(ctx, frame.sessions, frame.frameId);
  ctx.browser.networkEvents.deleteTargetAttribution(frame.frameId);
  ctx.emit({
    method: "Target.targetDestroyed",
    params: { targetId: frame.frameId },
  });
}

export async function handleOopifSession(
  ctx: DispatchCtx,
  req: CdpRequest,
  _target: TargetState,
  frame: FrameState,
): Promise<unknown> {
  switch (req.method) {
    case "Network.enable":
      ctx.browser.networkEvents.setEnabled(req.sessionId, true, {
        maxTotalBufferSize:
          typeof req.params?.maxTotalBufferSize === "number"
            ? req.params.maxTotalBufferSize
            : undefined,
        maxResourceBufferSize:
          typeof req.params?.maxResourceBufferSize === "number"
            ? req.params.maxResourceBufferSize
            : undefined,
      });
      return {};
    case "Network.disable":
      ctx.browser.networkEvents.setEnabled(req.sessionId, false);
      return {};
    case "Page.getFrameTree":
    case "Page.getResourceTree": {
      const frameJson = {
        id: frame.frameId,
        loaderId: frame.loaderId,
        url: frame.url,
        domainAndRegistry: domainAndRegistryOf(frame.url),
        securityOrigin: originOfUrl(frame.url),
        mimeType: "text/html",
        secureContextType: "Secure",
        crossOriginIsolatedContextType: "NotIsolated",
        gatedAPIFeatures: [],
      };
      return req.method === "Page.getFrameTree"
        ? { frameTree: { frame: frameJson, childFrames: [] } }
        : { frameTree: { frame: frameJson, resources: [] } };
    }
    case "Runtime.enable": {
      ctx.emit({
        method: "Runtime.executionContextCreated",
        params: {
          context: {
            id: frame.execContextId || 1,
            origin: originOfUrl(frame.url),
            name: "",
            uniqueId: `oopif-${frame.frameId}`,
            auxData: {
              isDefault: true,
              type: "default",
              frameId: frame.frameId,
            },
          },
        },
        sessionId: req.sessionId,
      });
      return {};
    }
    case "Runtime.getHeapUsage": {
      try {
        const mem = frame.pageScript
          ? await stubQueryDom(frame.pageScript, "getMemoryStats", {})
          : undefined;
        const usedSize = typeof mem?.bytes === "number" ? mem.bytes : 0;
        return { usedSize, totalSize: usedSize };
      } catch {
        return { usedSize: 0, totalSize: 0 };
      }
    }
    case "Target.getTargetInfo":
      return { targetInfo: { ...frameTargetInfo(frame), attached: true } };

    case "DOM.enable": {
      ctx.emit({
        method: "DOM.documentUpdated",
        sessionId: req.sessionId,
      });
      return {};
    }
    case "DOM.getDocument": {
      const r = frame.pageScript
        ? await stubQueryDom(frame.pageScript, "getDocument", {})
        : undefined;
      return r?.root ? r : { root: null };
    }
    case "DOM.getFlattenedDocument": {
      const r = frame.pageScript
        ? await stubQueryDom(frame.pageScript, "getDocument", {})
        : undefined;
      return { nodes: r?.root ? [r.root] : [] };
    }
    case "DOM.requestChildNodes":
      return {};
    case "DOM.getOuterHTML": {
      const nodeId = oopifNodeId(req.params);
      if (!frame.pageScript) return undefined;
      return await stubQueryDom(frame.pageScript, "getOuterHTML", nodeId != null ? { nodeId } : {});
    }
    case "DOM.describeNode": {
      const nodeId = oopifNodeId(req.params);
      if (!frame.pageScript) return undefined;
      return await stubQueryDom(frame.pageScript, "describeNode", nodeId != null ? { nodeId } : {});
    }
    case "DOM.getAttributes": {
      const nodeId = oopifNodeId(req.params);
      if (!frame.pageScript) return undefined;
      return await stubQueryDom(
        frame.pageScript,
        "getAttributes",
        nodeId != null ? { nodeId } : {},
      );
    }
    default:
      return {};
  }
}

function oopifNodeId(
  params: { nodeId?: number; backendNodeId?: number } | undefined,
): number | null {
  const v = params?.nodeId ?? params?.backendNodeId;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function originOfUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}
