// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements CDP DOM commands and coordinates PageScript setup and mutation events.

import type { Protocol } from "devtools-protocol";
import type { CdpMutation } from "@kitesurf/jsrpc-types/shared";

import type { CdpEvent, CdpRequest, TargetState } from "./types.ts";
import type { DispatchCtx } from "./dispatch.ts";
import {
  getOrCreatePageScript,
  pageScriptCacheKey,
  type PageScriptInitTimings,
  originOf as pageScriptOriginOf,
  type PageScriptStub,
} from "../eval/page-script.ts";
import { syncStyleSheetsFromMutations } from "./css.ts";
import { installIsolateLimitSurface, installUpstreamEventHandler } from "./page.ts";
import { cookieKeyFor } from "./cookie-jar-registry.ts";
import { publishStub } from "./page-script-generation.ts";
import { ensureTargetDom } from "./dom-release.ts";
import {
  registerEnsurePageScript,
  resolveTarget,
  sessionOf,
  stubQueryDom,
  type PageSession,
  type QueryDomResult,
} from "./page-session.ts";
import { traceSpan } from "../tracing.ts";
import { emitSessionStart } from "../observability.ts";
import { reconcileTools } from "./webmcp.ts";

interface DomCommandContext {
  ctx: DispatchCtx;
  target: TargetState;
  session: PageSession;
  pageScript: PageScriptStub | null;
  sessionId: string | undefined;
}

export async function handleDom(ctx: DispatchCtx, req: CdpRequest): Promise<unknown> {
  const target = resolveTarget(ctx, req.sessionId);
  const session = sessionOf(ctx, target);
  const command: DomCommandContext = {
    ctx,
    target,
    session,
    pageScript: session.ensure(),
    sessionId: req.sessionId,
  };

  switch (req.method) {
    case "DOM.enable":
      registerDomObserver(target, req.sessionId);
      return {};
    case "DOM.getFrameOwner":
      return getFrameOwner(target, req);
    case "DOM.disable":
    case "DOM.discardSearchResults":
    case "DOM.markUndoableState":
    case "DOM.undo":
    case "DOM.redo":
    case "DOM.setNodeStackTracesEnabled":
      return {};
    case "DOM.getDocument":
      return getDocument(command);
    case "DOM.getFlattenedDocument":
      return getFlattenedDocument(command);
    case "DOM.requestChildNodes":
      return requestChildNodes(command, req);
    case "DOM.querySelector":
      return querySelector(command, req);
    case "DOM.querySelectorAll":
      return querySelectorAll(command, req);
    case "DOM.getOuterHTML":
      return getOuterHTML(command, req);
    case "DOM.describeNode":
      return describeNode(command, req);
    case "DOM.resolveNode":
      return resolveNode(command, req);
    case "DOM.requestNode":
      return requestNode(req);
    case "DOM.getAttributes":
      return getAttributes(command, req);
    case "DOM.getBoxModel":
      return getBoxModel(command, req);
    case "DOM.getContentQuads":
      return getContentQuads(command, req);
    case "DOM.getNodeForLocation":
      return getNodeForLocation(command, req);
    case "DOM.focus":
      return focusNode(command, req);
    case "DOM.scrollIntoViewIfNeeded":
    case "DOM.highlightNode":
    case "DOM.hideHighlight":
      return {};
    case "DOM.pushNodesByBackendIdsToFrontend":
      return pushNodesByBackendIds(req);
    case "DOM.pushNodeByPathToFrontend":
      return { nodeId: 0 };
    case "DOM.setInspectedNode":
      return {};
    default:
      return {};
  }
}

function getFrameOwner(
  target: TargetState,
  req: Extract<CdpRequest, { method: "DOM.getFrameOwner" }>,
): { backendNodeId: number; nodeId: number } {
  const frameId = req.params?.frameId;
  const frame = typeof frameId === "string" ? target.frames.get(frameId) : undefined;
  if (!frame || frame.ownerBackendNodeId <= 0) {
    throw new Error("Frame with the given id was not found.");
  }
  return { backendNodeId: frame.ownerBackendNodeId, nodeId: frame.ownerBackendNodeId };
}

async function getDocument(context: DomCommandContext): Promise<unknown> {
  registerDomObserver(context.target, context.sessionId);
  const pageResult = await pageScriptDocument(context);
  if (pageResult) return pageResult;
  return { root: localDocumentRoot(context.target) };
}

async function getFlattenedDocument(context: DomCommandContext): Promise<unknown> {
  registerDomObserver(context.target, context.sessionId);
  const pageResult = await pageScriptDocument(context);
  if (pageResult) return { nodes: flattenedDocumentNodes(pageResult.root) };
  return { nodes: [localDocumentRoot(context.target)] };
}

async function pageScriptDocument(
  context: DomCommandContext,
): Promise<QueryDomResult<"getDocument"> | null> {
  if (!context.pageScript) return null;
  try {
    const result = await context.session.call.getDocument({});
    annotateIframeFrameIds(result.root, context.target);
    return result;
  } catch (error) {
    if (!isMissingDocumentError(error)) throw error;
    return null;
  }
}

function isMissingDocumentError(error: unknown): boolean {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? error.message
      : String(error);
  return /no document loaded/i.test(String(message ?? error));
}

function flattenedDocumentNodes(root: Protocol.DOM.Node | null | undefined): Protocol.DOM.Node[] {
  return root ? [root] : [];
}

function localDocumentRoot(target: TargetState): unknown {
  const dom = ensureTargetDom(target);
  if (!dom) return syntheticBlankDocument();
  const root = dom.getDocument();
  stripAttributeNamespaceSidecars(root);
  annotateIframeFrameIds(root, target);
  return root;
}

async function requestChildNodes(
  context: DomCommandContext,
  req: Extract<CdpRequest, { method: "DOM.requestChildNodes" }>,
): Promise<Record<string, never>> {
  registerDomObserver(context.target, context.sessionId);
  const id = numericNodeId(req.params);
  if (!isPositiveNodeId(id)) return {};
  if (!context.pageScript) return {};
  await emitRequestedChildNodes(context, id);
  return {};
}

async function emitRequestedChildNodes(context: DomCommandContext, id: number): Promise<void> {
  const result = await context.session.tryCall.nodeSubtree({ nodeId: id });
  const node = result?.node ?? null;
  if (!node) return;
  const nodes = childNodesForRebind(node) ?? [];
  context.ctx.emit({
    method: "DOM.setChildNodes",
    params: { parentId: id, nodes },
    sessionId: context.sessionId,
  });
}

function isPositiveNodeId(nodeId: number | null): nodeId is number {
  return nodeId !== null && nodeId > 0;
}

async function querySelector(
  context: DomCommandContext,
  req: Extract<CdpRequest, { method: "DOM.querySelector" }>,
): Promise<unknown> {
  const selector = req.params!.selector;
  if (context.pageScript) return context.session.call.querySelector({ selector });
  return querySelectorInLocalDom(context.target, selector);
}

function querySelectorInLocalDom(target: TargetState, selector: string): unknown {
  const dom = requireDom(target);
  try {
    const id = dom.querySelector(selector);
    return { nodeId: id < 0 ? 0 : id };
  } catch (error) {
    return { nodeId: 0, error: String(error) };
  }
}

async function querySelectorAll(
  context: DomCommandContext,
  req: Extract<CdpRequest, { method: "DOM.querySelectorAll" }>,
): Promise<unknown> {
  const selector = req.params!.selector;
  if (context.pageScript) return context.session.call.querySelectorAll({ selector });
  return querySelectorAllInLocalDom(context.target, selector);
}

function querySelectorAllInLocalDom(target: TargetState, selector: string): unknown {
  const dom = requireDom(target);
  try {
    const ids = dom.querySelectorAll(selector);
    return { nodeIds: Array.from(ids).filter((nodeId) => nodeId >= 0) };
  } catch (error) {
    return { nodeIds: [], error: String(error) };
  }
}

async function getOuterHTML(
  context: DomCommandContext,
  req: Extract<CdpRequest, { method: "DOM.getOuterHTML" }>,
): Promise<unknown> {
  const nodeId = numericNodeId(req.params);
  if (context.pageScript) {
    const includeDocumentType = req.params?.includeDoctype === true;
    return context.session.call.getOuterHTML(outerHTMLArgs(nodeId, includeDocumentType));
  }
  return getLocalOuterHTML(context.target, nodeId);
}

function outerHTMLArgs(
  nodeId: number | null,
  includeDocumentType: boolean,
): { nodeId?: number; includeDoctype?: true } {
  return {
    ...(nodeId !== null ? { nodeId } : {}),
    ...(includeDocumentType ? { includeDoctype: true as const } : {}),
  };
}

function getLocalOuterHTML(target: TargetState, nodeId: number | null): unknown {
  const dom = requireDom(target);
  if (nodeId === null) return { outerHTML: "" };
  return { outerHTML: dom.outerHTML(nodeId) };
}

async function describeNode(
  context: DomCommandContext,
  req: Extract<CdpRequest, { method: "DOM.describeNode" }>,
): Promise<unknown> {
  const nodeId = numericNodeId(req.params);
  if (context.pageScript) {
    return context.session.call.describeNode(describeNodeArgs(nodeId, req.params?.objectId));
  }
  return describeLocalNode(context.target, nodeId);
}

function describeNodeArgs(
  nodeId: number | null,
  objectId: string | undefined,
): { nodeId: number } | { objectId: string } | Record<string, never> {
  if (nodeId !== null) return { nodeId };
  if (typeof objectId === "string") return { objectId };
  return {};
}

function describeLocalNode(target: TargetState, nodeId: number | null): unknown {
  const dom = requireDom(target);
  if (nodeId === null) return emptyNodeDescription();
  try {
    const node: unknown = dom.nodeInfo(nodeId);
    stripAttributeNamespaceSidecars(node);
    return { node };
  } catch {
    return emptyNodeDescription();
  }
}

function emptyNodeDescription(): unknown {
  return { node: { nodeId: 0, nodeType: 1, nodeName: "", localName: "", nodeValue: "" } };
}

async function resolveNode(
  context: DomCommandContext,
  req: Extract<CdpRequest, { method: "DOM.resolveNode" }>,
): Promise<unknown> {
  const nodeId = numericNodeId(req.params);
  if (context.pageScript && nodeId !== null) {
    const result = await context.session.call.resolveNode({ nodeId });
    if (result.object) return result;
  }
  return fallbackResolvedNode(nodeId);
}

function fallbackResolvedNode(nodeId: number | null): unknown {
  return {
    object: {
      type: "object",
      subtype: "node",
      className: "Element",
      description: nodeId !== null ? `Node#${nodeId}` : "Node",
      objectId: nodeId !== null ? `node:${nodeId}` : crypto.randomUUID(),
    },
  };
}

function requestNode(req: Extract<CdpRequest, { method: "DOM.requestNode" }>): { nodeId: number } {
  const objectId = req.params!.objectId;
  return { nodeId: requestNodeId(objectId) };
}

function requestNodeId(objectId: string): number {
  if (!objectId.startsWith("node:")) return 0;
  return Number(objectId.slice(5)) || 0;
}

async function getAttributes(
  context: DomCommandContext,
  req: Extract<CdpRequest, { method: "DOM.getAttributes" }>,
): Promise<unknown> {
  const nodeId = numericNodeId(req.params);
  if (context.pageScript) {
    return context.session.call.getAttributes(nodeId !== null ? { nodeId } : {});
  }
  return getLocalAttributes(context.target, nodeId);
}

function getLocalAttributes(target: TargetState, nodeId: number | null): unknown {
  const dom = requireDom(target);
  if (nodeId === null) return { attributes: [] };
  try {
    const info = dom.nodeInfo(nodeId) as { attributes?: string[] };
    return { attributes: info.attributes ?? [] };
  } catch {
    return { attributes: [] };
  }
}

async function getBoxModel(
  context: DomCommandContext,
  req: Extract<CdpRequest, { method: "DOM.getBoxModel" }>,
): Promise<unknown> {
  const nodeId = numericNodeId(req.params);
  const rect = isPositiveNodeId(nodeId) ? await pageScriptRect(context.session, nodeId) : null;
  if (!rect) throw new Error("Could not compute box model.");
  return { model: realBoxFor(rect) };
}

async function getContentQuads(
  context: DomCommandContext,
  req: Extract<CdpRequest, { method: "DOM.getContentQuads" }>,
): Promise<{ quads: number[][] }> {
  const nodeId = numericNodeId(req.params);
  if (!isPositiveNodeId(nodeId)) return { quads: [] };
  const rect = await pageScriptRect(context.session, nodeId);
  if (!rect) return { quads: [] };
  return { quads: [rectToQuad(rect)] };
}

async function getNodeForLocation(
  context: DomCommandContext,
  req: Extract<CdpRequest, { method: "DOM.getNodeForLocation" }>,
): Promise<{ backendNodeId: number; frameId: string; nodeId: number }> {
  const { x, y } = req.params!;
  const id = await pageScriptElementFromPoint(context.session, x, y);
  const nodeId = id >= 0 ? id : 0;
  return { backendNodeId: nodeId, frameId: context.target.frameId, nodeId };
}

async function focusNode(
  context: DomCommandContext,
  req: Extract<CdpRequest, { method: "DOM.focus" }>,
): Promise<Record<string, never>> {
  if (!context.pageScript) return {};
  const nodeId = numericNodeId(req.params);
  if (nodeId !== null) await context.session.call.focus({ nodeId });
  return {};
}

function pushNodesByBackendIds(
  req: Extract<CdpRequest, { method: "DOM.pushNodesByBackendIdsToFrontend" }>,
): { nodeIds: number[] } {
  const ids = req.params!.backendNodeIds ?? [];
  return {
    nodeIds: ids.filter((nodeId): nodeId is number => typeof nodeId === "number" && nodeId >= 0),
  };
}

async function pageScriptRect(
  session: PageSession,
  nodeId: number,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const r = await session.callIfLive.getRect({ nodeId });
  if (!r?.rect) return null;
  if (r.rect.width <= 0 || r.rect.height <= 0) return null;
  return r.rect;
}

async function pageScriptElementFromPoint(
  session: PageSession,
  x: number,
  y: number,
): Promise<number> {
  const r = await session.callIfLive.elementFromPoint({ x, y });
  return typeof r?.nodeId === "number" ? r.nodeId : -1;
}

function realBoxFor(rect: { x: number; y: number; width: number; height: number }): {
  content: number[];
  padding: number[];
  border: number[];
  margin: number[];
  width: number;
  height: number;
} {
  const quad = (xx: number, yy: number, ww: number, hh: number) => [
    xx,
    yy,
    xx + ww,
    yy,
    xx + ww,
    yy + hh,
    xx,
    yy + hh,
  ];
  return {
    content: quad(rect.x, rect.y, rect.width, rect.height),
    padding: quad(rect.x - 1, rect.y - 1, rect.width + 2, rect.height + 2),
    border: quad(rect.x - 2, rect.y - 2, rect.width + 4, rect.height + 4),
    margin: quad(rect.x - 3, rect.y - 3, rect.width + 6, rect.height + 6),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function rectToQuad(rect: { x: number; y: number; width: number; height: number }): number[] {
  return [
    rect.x,
    rect.y,
    rect.x + rect.width,
    rect.y,
    rect.x + rect.width,
    rect.y + rect.height,
    rect.x,
    rect.y + rect.height,
  ];
}

function numericNodeId(params: NodeIdParams | undefined): number | null {
  if (!params) return null;
  const directId = directNodeId(params);
  if (directId !== undefined) return directId;
  return nodeIdFromObjectId(params.objectId);
}

type NodeIdParams = {
  nodeId?: number;
  backendNodeId?: number;
  objectId?: string;
};

function directNodeId(params: NodeIdParams): number | undefined {
  if (typeof params.nodeId === "number") return params.nodeId;
  if (typeof params.backendNodeId === "number") return params.backendNodeId;
  return undefined;
}

function nodeIdFromObjectId(objectId: string | undefined): number | null {
  if (typeof objectId !== "string" || !objectId.startsWith("node:")) return null;
  const nodeId = Number(objectId.slice(5));
  if (!Number.isFinite(nodeId)) return null;
  return nodeId;
}

function requireDom(target: TargetState): NonNullable<TargetState["dom"]> {
  const dom = ensureTargetDom(target);
  if (!dom) {
    throw new Error("No document loaded — call Page.navigate first");
  }
  return dom;
}

function annotateIframeFrameIds(root: unknown, target: TargetState): void {
  const byOwner = new Map<number, string>();
  for (const f of target.frames.values()) {
    if (f.parentFrameId !== null && f.isCrossOrigin && f.ownerBackendNodeId > 0) {
      byOwner.set(f.ownerBackendNodeId, f.frameId);
    }
  }
  if (byOwner.size === 0 || !root || typeof root !== "object") return;
  const walk = (n: {
    nodeName?: string;
    backendNodeId?: number;
    frameId?: string;
    children?: unknown[];
  }): void => {
    if (
      n.nodeName === "IFRAME" &&
      typeof n.backendNodeId === "number" &&
      byOwner.has(n.backendNodeId)
    ) {
      n.frameId = byOwner.get(n.backendNodeId);
    }
    if (Array.isArray(n.children)) {
      for (const c of n.children) {
        if (c && typeof c === "object") walk(c as typeof n);
      }
    }
  };
  walk(root as Parameters<typeof walk>[0]);
}

function isCdpRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stripAttributeNamespaceSidecars(node: unknown): void {
  if (!isCdpRecord(node)) return;
  delete node.attributeNamespaces;
  stripNodeCollectionSidecars(node.children);
  stripNodeCollectionSidecars(node.shadowRoots);
}

function stripNodeCollectionSidecars(collection: unknown): void {
  if (!Array.isArray(collection)) return;
  for (const child of collection) stripAttributeNamespaceSidecars(child);
}

function syntheticBlankDocument(): Record<string, unknown> {
  return {
    nodeId: 0,
    backendNodeId: 0,
    nodeType: 9,
    nodeName: "#document",
    localName: "",
    nodeValue: "",
    documentURL: "about:blank",
    baseURL: "about:blank",
    childNodeCount: 0,
    children: [],
  };
}

/**
 * Returns an existing page stub, or starts lazy `about:blank` setup without awaiting it.
 * Without a stub, non-page, closing, pending, and failed spawn requests return `null`.
 */
export function ensurePageScript(
  dctx: DispatchCtx,
  target: TargetState | undefined,
): PageScriptStub | null {
  return target ? ensurePageScriptForTarget(dctx, target) : null;
}

function ensurePageScriptForTarget(dctx: DispatchCtx, target: TargetState): PageScriptStub | null {
  const state = lazyPageScriptState(dctx, target);
  if (state.kind === "existing") return state.pageScript;
  if (state.kind === "pending") return null;
  const navUrl = target.url || "about:blank";
  const preSpawnWaitMs = dctx.analytics.sessionAgeMs();
  const bakeStart = dctx.analytics.now();
  const initTimings: PageScriptInitTimings = {};
  const stub = createLazyPageScript(dctx, target, navUrl, initTimings);
  if (!stub) return null;
  const bakeMs = dctx.analytics.now() - bakeStart;
  installLazyPageScript(dctx, target, stub, navUrl);
  startBlankPageScriptNavigation(dctx, target, stub, initTimings, preSpawnWaitMs, bakeMs);
  return stub;
}

type LazyPageScriptState =
  | { kind: "existing"; pageScript: PageScriptStub }
  | { kind: "pending" }
  | { kind: "start" };

function lazyPageScriptState(dctx: DispatchCtx, target: TargetState): LazyPageScriptState {
  if (target.type !== "page") return { kind: "pending" };
  if (target.pageScript) return { kind: "existing", pageScript: target.pageScript };
  if (target.blankReady) return { kind: "pending" };
  if (!isCurrentPageScriptTarget(dctx, target)) return { kind: "pending" };
  return { kind: "start" };
}

function isCurrentPageScriptTarget(dctx: DispatchCtx, target: TargetState): boolean {
  return dctx.browser.targets.get(target.targetId) === target && !dctx.browser.wsClosing;
}

function createLazyPageScript(
  dctx: DispatchCtx,
  target: TargetState,
  navUrl: string,
  initTimings: PageScriptInitTimings,
): PageScriptStub | null {
  try {
    return traceSpan(
      dctx.env.HOST_TRACER,
      "init.bake_isolate",
      () =>
        getOrCreatePageScript({
          env: dctx.env,
          ctx: dctx.ctx,
          key: {
            connectionId: dctx.connectionId,
            targetId: target.targetId,
            navigateGeneration: target.navigateGeneration,
            cookieKey: cookieKeyFor(dctx.connectionId, target.browserContextId),
            lazy: true,
          },
          pageOrigin: pageScriptOriginOf(navUrl),
          startupInput: {
            pixelFree: dctx.browser.skipSpeculativeRaster,
          },
          attributionHeaders: dctx.browser.attributionHeaders,
          mainLoaderId: target.loaderId,
          extraHeaders: {},
          initTimings,
          capOverrides: dctx.browser.isolateCapOverrides,
          sandboxOutbound: dctx.browser.sandboxOutbound,
        }),
      { lazy: true },
    );
  } catch (error) {
    console.warn("kitesurf: getOrCreatePageScript failed:", pageScriptErrorMessage(error));
    return null;
  }
}

function pageScriptErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function installLazyPageScript(
  dctx: DispatchCtx,
  target: TargetState,
  stub: PageScriptStub,
  navUrl: string,
): void {
  publishStub(target, stub, {}, { budget: dctx.browser.workerBudget });
  installUpstreamEventHandler(dctx, target, stub, target.navigateGeneration, navUrl);
  installIsolateLimitSurface(
    dctx,
    target,
    target.navigateGeneration,
    pageScriptCacheKey({
      connectionId: dctx.connectionId,
      targetId: target.targetId,
      navigateGeneration: target.navigateGeneration,
      lazy: true,
    }),
  );
  if (target.domEnabledSessions.size > 0) {
    void stubQueryDom(stub, "setCdpDomActive", { active: true }).catch(() => {});
  }
}

interface BlankPageScriptSetup {
  dctx: DispatchCtx;
  target: TargetState;
  stub: PageScriptStub;
  initTimings: PageScriptInitTimings;
  preSpawnWaitMs: number;
  bakeMs: number;
}

function startBlankPageScriptNavigation(
  dctx: DispatchCtx,
  target: TargetState,
  stub: PageScriptStub,
  initTimings: PageScriptInitTimings,
  preSpawnWaitMs: number,
  bakeMs: number,
): void {
  const rpcStart = dctx.analytics.now();
  const setup = { dctx, target, stub, initTimings, preSpawnWaitMs, bakeMs };
  // Page reads wait for the lazy isolate to finish its initial about:blank setup.
  target.blankReady = stub
    .navigate("", "about:blank", {
      connectionId: dctx.connectionId,
      cookieKey: cookieKeyFor(dctx.connectionId, target.browserContextId),
      bindingNames: pendingBindingNames(dctx),
    })
    .then(() => completeBlankPageScriptNavigation(setup, rpcStart))
    .catch((error) => {
      console.warn("kitesurf: lazy PageScript.navigate failed:", pageScriptErrorMessage(error));
    });
}

function pendingBindingNames(dctx: DispatchCtx): string[] | undefined {
  return dctx.browser.pendingBindings.size > 0
    ? Array.from(dctx.browser.pendingBindings)
    : undefined;
}

async function completeBlankPageScriptNavigation(
  setup: BlankPageScriptSetup,
  rpcStart: number,
): Promise<void> {
  emitBlankPageSessionStart(setup, rpcStart);
  await evaluatePreNavigationScripts(setup);
  await reconcileTools(setup.dctx, setup.target);
}

function emitBlankPageSessionStart(setup: BlankPageScriptSetup, rpcStart: number): void {
  const { dctx, initTimings, preSpawnWaitMs, bakeMs } = setup;
  const firstRpcMs = dctx.analytics.now() - rpcStart;
  const wsUpgradeMs = initTimings.wsUpgradeMs ?? 0;
  emitSessionStart(dctx.analytics, {
    totalMs: dctx.analytics.sessionAgeMs(),
    preSpawnWaitMs,
    bakeMs,
    wsUpgradeMs,
    navRpcMs: Math.max(0, firstRpcMs - wsUpgradeMs),
    parseMs: 0,
    shimMs: 0,
    fontsMs: 0,
    regularScriptsMs: 0,
    moduleScriptsMs: 0,
    teardownMs: 0,
    spawnKind: "blank",
    host: "",
  });
}

async function evaluatePreNavigationScripts(setup: BlankPageScriptSetup): Promise<void> {
  const { dctx, stub } = setup;
  for (const source of dctx.browser.preNavScripts.values()) {
    try {
      await stub.evaluate(source, {});
    } catch (error) {
      console.warn("kitesurf: blank-page pre-nav script failed:", pageScriptErrorMessage(error));
    }
  }
}

registerEnsurePageScript(ensurePageScript);

function registerDomObserver(target: TargetState, sessionId: string | undefined): void {
  const wasEmpty = target.domEnabledSessions.size === 0;
  target.domEnabledSessions.add(typeof sessionId === "string" ? sessionId : "");
  if (wasEmpty && target.pageScript) {
    stubQueryDom(target.pageScript, "setCdpDomActive", { active: true }).catch(() => {});
  }
}

export function emitMutations(
  ctx: DispatchCtx,
  target: TargetState,
  mutations: CdpMutation[] | undefined,
): void {
  if (!hasMutations(mutations)) return;
  syncStyleSheetsFromMutations(ctx, target, mutations);
  if (target.domEnabledSessions.size === 0) return;
  const staleParents = staleParentIds(mutations);
  emitMutationEvents(ctx, target, mutations);
  if (staleParents.size > 0) scheduleChildRebinds(ctx, target, staleParents);
}

function hasMutations(mutations: CdpMutation[] | undefined): mutations is CdpMutation[] {
  return Boolean(mutations && mutations.length > 0);
}

function staleParentIds(mutations: CdpMutation[]): Set<number> {
  const staleParents = new Set<number>();
  for (const mutation of mutations) {
    if (!isEventMutation(mutation)) continue;
    const nodeId = staleParentId(mutation);
    if (nodeId !== null) staleParents.add(nodeId);
  }
  return staleParents;
}

function isEventMutation(mutation: CdpMutation): boolean {
  if (!mutation || typeof mutation !== "object") return false;
  if (typeof mutation.kind !== "string" || mutation.kind.length === 0) return false;
  return mutation.kind !== "stylesheetResourceLoaded";
}

function staleParentId(mutation: CdpMutation): number | null {
  if (mutation.kind !== "childNodeCountUpdated") return null;
  const nodeId = mutation.nodeId;
  if (typeof nodeId !== "number" || nodeId <= 0) return null;
  return nodeId;
}

function emitMutationEvents(ctx: DispatchCtx, target: TargetState, mutations: CdpMutation[]): void {
  for (const mutation of mutations) {
    if (isEventMutation(mutation)) emitMutationToSessions(ctx, target, mutation);
  }
}

function emitMutationToSessions(
  ctx: DispatchCtx,
  target: TargetState,
  mutation: CdpMutation,
): void {
  for (const sessionId of target.domEnabledSessions) {
    const event = mutationEvent(mutation, sessionId.length === 0 ? undefined : sessionId);
    if (event) ctx.emit(event);
  }
}

function mutationEvent(mutation: CdpMutation, sessionId: string | undefined): CdpEvent | null {
  switch (mutation.kind) {
    case "attributeModified":
      return {
        method: "DOM.attributeModified",
        params: {
          nodeId: mutation.nodeId,
          name: mutation.name,
          value: mutation.value,
        },
        sessionId,
      };
    case "attributeRemoved":
      return {
        method: "DOM.attributeRemoved",
        params: { nodeId: mutation.nodeId, name: mutation.name },
        sessionId,
      };
    case "characterDataModified":
      return {
        method: "DOM.characterDataModified",
        params: { nodeId: mutation.nodeId, characterData: mutation.characterData },
        sessionId,
      };
    case "childNodeCountUpdated":
      return {
        method: "DOM.childNodeCountUpdated",
        params: { nodeId: mutation.nodeId, childNodeCount: mutation.childNodeCount },
        sessionId,
      };
    case "childNodeInserted":
      return {
        method: "DOM.childNodeInserted",
        params: {
          parentNodeId: mutation.parentNodeId,
          previousNodeId: mutation.previousNodeId,
          node: mutation.node,
        },
        sessionId,
      };
    case "childNodeRemoved":
      return {
        method: "DOM.childNodeRemoved",
        params: { parentNodeId: mutation.parentNodeId, nodeId: mutation.nodeId },
        sessionId,
      };
    case "shadowRootPushed":
      return {
        method: "DOM.shadowRootPushed",
        params: { hostId: mutation.hostId, root: mutation.root },
        sessionId,
      };
    case "stylesheetResourceLoaded":
      return null;
    default:
      return null;
  }
}

function scheduleChildRebinds(ctx: DispatchCtx, target: TargetState, parentIds: Set<number>): void {
  const pageScript = target.pageScript;
  if (!pageScript) return;
  ctx.ctx.waitUntil(rebindChildNodes(ctx, target, pageScript, parentIds));
}

interface ParentNodeRead {
  id: number;
  node: unknown;
}

async function rebindChildNodes(
  ctx: DispatchCtx,
  target: TargetState,
  pageScript: PageScriptStub,
  parentIds: Set<number>,
): Promise<void> {
  const reads = await readParentNodes(pageScript, parentIds);
  if (target.pageScript !== pageScript) return;
  emitReboundChildNodes(ctx, target, reads);
}

function readParentNodes(
  pageScript: PageScriptStub,
  parentIds: Set<number>,
): Promise<ParentNodeRead[]> {
  return Promise.all(Array.from(parentIds, (id) => readParentNode(pageScript, id)));
}

async function readParentNode(pageScript: PageScriptStub, id: number): Promise<ParentNodeRead> {
  try {
    const result = await stubQueryDom(pageScript, "nodeSubtree", { nodeId: id });
    return { id, node: result?.node ?? null };
  } catch {
    return { id, node: null };
  }
}

function emitReboundChildNodes(
  ctx: DispatchCtx,
  target: TargetState,
  reads: ParentNodeRead[],
): void {
  for (const { id, node } of reads) {
    const nodes = childNodesForRebind(node);
    if (!nodes) continue;
    emitReboundChildNodesToSessions(ctx, target, id, nodes);
  }
}

function emitReboundChildNodesToSessions(
  ctx: DispatchCtx,
  target: TargetState,
  parentId: number,
  nodes: Protocol.DOM.Node[],
): void {
  for (const sessionId of target.domEnabledSessions) {
    ctx.emit({
      method: "DOM.setChildNodes",
      params: { parentId, nodes },
      sessionId: sessionId.length === 0 ? undefined : sessionId,
    });
  }
}

function childNodesForRebind(node: unknown): Protocol.DOM.Node[] | null {
  if (!node || typeof node !== "object") return null;
  const children = (node as { children?: unknown }).children;
  if (!Array.isArray(children)) return null;
  for (const c of children) {
    if (!c || typeof c !== "object") return null;
    const n = c as { nodeId?: unknown; nodeName?: unknown; nodeType?: unknown };
    if (typeof n.nodeId !== "number") return null;
    if (typeof n.nodeName !== "string") return null;
    if (typeof n.nodeType !== "number") return null;
  }
  return children as Protocol.DOM.Node[];
}
