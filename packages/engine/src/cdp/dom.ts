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
} from "./page-session.ts";
import { traceSpan } from "../tracing.ts";
import { emitSessionStart } from "../observability.ts";
import { reconcileTools } from "./webmcp.ts";

export async function handleDom(ctx: DispatchCtx, req: CdpRequest): Promise<unknown> {
  const target = resolveTarget(ctx, req.sessionId);
  const session = sessionOf(ctx, target);
  const ps = session.ensure();

  switch (req.method) {
    case "DOM.enable":
      registerDomObserver(target, req.sessionId);
      return {};
    case "DOM.getFrameOwner": {
      const frameId = req.params?.frameId;
      const f = typeof frameId === "string" ? target.frames.get(frameId) : undefined;
      if (!f || f.ownerBackendNodeId <= 0) {
        throw new Error("Frame with the given id was not found.");
      }
      return {
        backendNodeId: f.ownerBackendNodeId,
        nodeId: f.ownerBackendNodeId,
      };
    }
    case "DOM.disable":
    case "DOM.discardSearchResults":
    case "DOM.markUndoableState":
    case "DOM.undo":
    case "DOM.redo":
    case "DOM.setNodeStackTracesEnabled":
      return {};

    case "DOM.getDocument": {
      registerDomObserver(target, req.sessionId);
      if (ps) {
        try {
          const r = await session.call.getDocument({});
          assertDomReplyGraph(r);
          annotateIframeFrameIds(r.root, target);
          return r;
        } catch (err) {
          const msg = (err as Error)?.message ?? String(err);
          if (!/no document loaded/i.test(msg)) throw err;
        }
      }
      {
        const dom = ensureTargetDom(target);
        if (!dom) return { root: syntheticBlankDocument() };
        const root = dom.getDocument();
        assertDomReplyGraph(root);
        stripAttributeNamespaceSidecars(root);
        annotateIframeFrameIds(root, target);
        return { root };
      }
    }

    case "DOM.getFlattenedDocument": {
      registerDomObserver(target, req.sessionId);
      if (ps) {
        try {
          const r = await session.call.getDocument({});
          assertDomReplyGraph(r);
          annotateIframeFrameIds(r.root, target);
          return { nodes: r.root ? [r.root] : [] };
        } catch (err) {
          const msg = (err as Error)?.message ?? String(err);
          if (!/no document loaded/i.test(msg)) throw err;
        }
      }
      {
        const dom = ensureTargetDom(target);
        if (!dom) return { nodes: [syntheticBlankDocument()] };
        const root = dom.getDocument();
        assertDomReplyGraph(root);
        stripAttributeNamespaceSidecars(root);
        annotateIframeFrameIds(root, target);
        return { nodes: [root] };
      }
    }

    case "DOM.requestChildNodes": {
      registerDomObserver(target, req.sessionId);
      const id = numericNodeId(req.params);
      if (id == null || id <= 0) return {};
      let node: unknown = null;
      if (ps) {
        const r = await session.tryCall.nodeSubtree({ nodeId: id });
        node = r?.node ?? null;
      }
      if (!node) return {};
      assertDomReplyGraph(node);
      const nodes = childNodesForRebind(node) ?? [];
      ctx.emit({
        method: "DOM.setChildNodes",
        params: { parentId: id, nodes },
        sessionId: req.sessionId,
      });
      return {};
    }

    case "DOM.querySelector": {
      const sel = req.params!.selector;
      if (ps) {
        return await session.call.querySelector({ selector: sel });
      }
      const dom = requireDom(target);
      try {
        const id = dom.querySelector(sel);
        return { nodeId: id < 0 ? 0 : id };
      } catch (err) {
        return { nodeId: 0, error: String(err) };
      }
    }

    case "DOM.querySelectorAll": {
      const sel = req.params!.selector;
      if (ps) {
        return await session.call.querySelectorAll({ selector: sel });
      }
      const dom = requireDom(target);
      try {
        const ids = dom.querySelectorAll(sel);
        return { nodeIds: Array.from(ids).filter((n) => n >= 0) };
      } catch (err) {
        return { nodeIds: [], error: String(err) };
      }
    }

    case "DOM.getOuterHTML": {
      const id = numericNodeId(req.params);
      if (ps) {
        const includeDoctype = req.params?.includeDoctype === true;
        return await session.call.getOuterHTML({
          ...(id != null ? { nodeId: id } : {}),
          ...(includeDoctype ? { includeDoctype: true } : {}),
        });
      }
      const dom = requireDom(target);
      if (id == null) return { outerHTML: "" };
      return { outerHTML: dom.outerHTML(id) };
    }

    case "DOM.describeNode": {
      const id = numericNodeId(req.params);
      if (ps) {
        const objectId = req.params?.objectId;
        const args = id != null ? { nodeId: id } : typeof objectId === "string" ? { objectId } : {};
        const reply = await session.call.describeNode(args);
        assertDomReplyGraph(reply);
        return reply;
      }
      const dom = requireDom(target);
      if (id == null) {
        return {
          node: { nodeId: 0, nodeType: 1, nodeName: "", localName: "", nodeValue: "" },
        };
      }
      let node: unknown;
      try {
        node = dom.nodeInfo(id);
      } catch {
        return {
          node: { nodeId: 0, nodeType: 1, nodeName: "", localName: "", nodeValue: "" },
        };
      }
      assertDomReplyGraph(node);
      stripAttributeNamespaceSidecars(node);
      return { node };
    }

    case "DOM.resolveNode": {
      const id = numericNodeId(req.params);
      if (ps && id != null) {
        const r = await session.call.resolveNode({ nodeId: id });
        if (r.object) return r;
      }
      return {
        object: {
          type: "object",
          subtype: "node",
          className: "Element",
          description: id != null ? `Node#${id}` : "Node",
          objectId: id != null ? `node:${id}` : crypto.randomUUID(),
        },
      };
    }

    case "DOM.requestNode": {
      const objectId = req.params!.objectId;
      if (objectId.startsWith("node:")) {
        return { nodeId: Number(objectId.slice(5)) || 0 };
      }
      return { nodeId: 0 };
    }

    case "DOM.getAttributes": {
      const id = numericNodeId(req.params);
      if (ps) {
        return await session.call.getAttributes(id != null ? { nodeId: id } : {});
      }
      const dom = requireDom(target);
      if (id == null) return { attributes: [] };
      try {
        const info = dom.nodeInfo(id) as { attributes?: string[] };
        return { attributes: info.attributes ?? [] };
      } catch {
        return { attributes: [] };
      }
    }

    case "DOM.getBoxModel": {
      const ref = rectNodeRef(req.params);
      const rect = ref ? await pageScriptRect(session, ref) : null;
      if (!rect) throw new Error("Could not compute box model.");
      return { model: realBoxFor(rect) };
    }

    case "DOM.getContentQuads": {
      const ref = rectNodeRef(req.params);
      const rect = ref ? await pageScriptRect(session, ref) : null;
      if (!rect) return { quads: [] };
      return { quads: [rectToQuad(rect)] };
    }

    case "DOM.getNodeForLocation": {
      const x = req.params!.x;
      const y = req.params!.y;
      const id = await pageScriptElementFromPoint(session, x, y);
      const nodeId = id >= 0 ? id : 0;
      return { backendNodeId: nodeId, frameId: target.frameId, nodeId };
    }

    case "DOM.focus": {
      if (ps) {
        const id = numericNodeId(req.params);
        if (id != null) {
          await session.call.focus({ nodeId: id });
        }
      }
      return {};
    }

    case "DOM.scrollIntoViewIfNeeded": {
      // An empty reply read as success: puppeteer skipped its own fallback scroll, and its
      // locator re-checked an off-screen element until it timed out.
      if (!ps) return {};
      const id = numericNodeId(req.params);
      const objectId = req.params?.objectId;
      const rect = req.params?.rect;
      const reply = await session.call.scrollIntoViewIfNeeded({
        ...(id != null ? { nodeId: id } : typeof objectId === "string" ? { objectId } : {}),
        ...(rect ? { rect } : {}),
      });
      if (!reply.found) throw new Error("Node is detached from document");
      return {};
    }

    case "DOM.highlightNode":
    case "DOM.hideHighlight":
      return {};

    case "DOM.pushNodesByBackendIdsToFrontend": {
      const ids = req.params!.backendNodeIds ?? [];
      const valid = ids.filter((n): n is number => typeof n === "number" && n >= 0);
      return { nodeIds: valid };
    }

    case "DOM.pushNodeByPathToFrontend": {
      return { nodeId: 0 };
    }

    case "DOM.setInspectedNode": {
      return {};
    }

    default:
      return {};
  }
}

// PageScript owns `ps:` handles, so an objectId that is not `node:N` goes there unresolved.
function rectNodeRef(
  params: { nodeId?: number; backendNodeId?: number; objectId?: string } | undefined,
): { nodeId: number } | { objectId: string } | null {
  const nodeId = numericNodeId(params);
  if (nodeId != null) return nodeId > 0 ? { nodeId } : null;
  return typeof params?.objectId === "string" ? { objectId: params.objectId } : null;
}

async function pageScriptRect(
  session: PageSession,
  ref: { nodeId: number } | { objectId: string },
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const r = await session.callIfLive.getRect(ref);
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

function numericNodeId(
  params:
    | {
        nodeId?: number;
        backendNodeId?: number;
        objectId?: string;
      }
    | undefined,
): number | null {
  if (!params) return null;
  if (typeof params.nodeId === "number") return params.nodeId;
  if (typeof params.backendNodeId === "number") return params.backendNodeId;
  if (typeof params.objectId === "string" && params.objectId.startsWith("node:")) {
    const n = Number(params.objectId.slice(5));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function requireDom(target: TargetState): NonNullable<TargetState["dom"]> {
  const dom = ensureTargetDom(target);
  if (!dom) {
    throw new Error("No document loaded — call Page.navigate first");
  }
  return dom;
}

// A DOM reply is page-shaped data the engine walks and then JSON-serializes to the CDP
// client. Shared references make that walk exponential, so a reply must be a plain tree.
// Each record and array counts once, so 2^20 containers is ~350k nodes: a CDP node costs
// about three. That is tens of MiB of JSON, several times the 16 MiB document cap.
const MAX_DOM_REPLY_CONTAINERS = 1 << 20;
// The accessibility builder recurses once per element level and overflows the worker
// stack at about 1535 levels, so half of that is the largest depth with a 2x margin.
// JSON serialization handles far deeper replies; `BuildCtx.build` sets this bound.
const MAX_DOM_REPLY_DEPTH = 767;

function rejectDomReply(reason: string): Error {
  return new Error(`DOM reply from the page isolate ${reason}`);
}

export function assertDomReplyGraph(root: unknown): void {
  if (!isCdpRecord(root)) return;
  const seen = new WeakSet<object>();
  const stack: Array<{ node: object; depth: number }> = [{ node: root, depth: 0 }];
  let containers = 0;
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) continue;
    const { node, depth } = frame;
    if (seen.has(node)) throw rejectDomReply("repeats an object reference");
    seen.add(node);
    // Count each record and array once, not each of its properties or slots.
    containers += 1;
    if (containers > MAX_DOM_REPLY_CONTAINERS) throw rejectDomReply("is too large");
    if (depth > MAX_DOM_REPLY_DEPTH) throw rejectDomReply("nests too deeply");
    const isArray = Array.isArray(node);
    let slots = 0;
    for (const key of Reflect.ownKeys(node)) {
      // RPC results carry symbol keys such as Symbol.dispose; JSON drops them and the engine
      // never reads them. Array `length` is checked against the index keys below.
      if (typeof key === "symbol") continue;
      if (isArray && key === "length") continue;
      if (isArray && isArrayIndexKey(key)) slots += 1;
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (!descriptor) continue;
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        throw rejectDomReply("has an accessor");
      }
      if (isCdpRecord(descriptor.value)) {
        stack.push({ node: descriptor.value, depth: isArray ? depth : depth + 1 });
      }
    }
    // Consumers visit an array once per slot (`for..of`, `JSON.stringify`), so holes cost
    // work the record budget does not see. Builders emit dense arrays; a reply never has one.
    if (isArray && slots !== node.length) throw rejectDomReply("has a sparse array");
  }
}

function annotateIframeFrameIds(root: unknown, target: TargetState): void {
  const byOwner = new Map<number, string>();
  for (const f of target.frames.values()) {
    if (f.parentFrameId !== null && f.isCrossOrigin && f.ownerBackendNodeId > 0) {
      byOwner.set(f.ownerBackendNodeId, f.frameId);
    }
  }
  if (byOwner.size === 0 || !isCdpRecord(root)) return;
  const visited = new WeakSet<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    if (!isCdpRecord(n) || visited.has(n)) continue;
    visited.add(n);
    if (n.nodeName === "IFRAME" && typeof n.backendNodeId === "number") {
      const frameId = byOwner.get(n.backendNodeId);
      if (frameId !== undefined) n.frameId = frameId;
    }
    const children = n.children;
    if (Array.isArray(children)) for (const child of children) stack.push(child);
  }
}

function isCdpRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isArrayIndexKey(key: string): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && String(index) === key;
}

function stripAttributeNamespaceSidecars(node: unknown): void {
  const visited = new WeakSet<object>();
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const n = stack.pop();
    if (!isCdpRecord(n) || visited.has(n)) continue;
    visited.add(n);
    delete n.attributeNamespaces;
    const childNodes = n.children;
    if (Array.isArray(childNodes)) for (const child of childNodes) stack.push(child);
    const shadowRoots = n.shadowRoots;
    if (Array.isArray(shadowRoots)) for (const root of shadowRoots) stack.push(root);
  }
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
  if (!target || target.type !== "page") return null;
  if (target.pageScript) return target.pageScript;
  if (target.blankReady) return null;
  if (dctx.browser.targets.get(target.targetId) !== target || dctx.browser.wsClosing) {
    return null;
  }
  const navUrl = target.url || "about:blank";
  const preSpawnWaitMs = dctx.analytics.sessionAgeMs();
  const bakeStart = dctx.analytics.now();
  const initTimings: PageScriptInitTimings = {};
  let stub: PageScriptStub;
  try {
    stub = traceSpan(
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
            fontProfile: dctx.browser.fontProfile,
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
  } catch (err) {
    console.warn(
      "kitesurf: getOrCreatePageScript failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  const bakeMs = dctx.analytics.now() - bakeStart;
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
  const rpcStart = dctx.analytics.now();
  // Page reads wait for the lazy isolate to finish its initial about:blank setup.
  target.blankReady = stub
    .navigate("", "about:blank", {
      connectionId: dctx.connectionId,
      cookieKey: cookieKeyFor(dctx.connectionId, target.browserContextId),
      bindingNames:
        dctx.browser.pendingBindings.size > 0
          ? Array.from(dctx.browser.pendingBindings)
          : undefined,
    })
    .then(async () => {
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
      for (const source of dctx.browser.preNavScripts.values()) {
        try {
          await stub.evaluate(source, {});
        } catch (err) {
          console.warn(
            "kitesurf: blank-page pre-nav script failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      await reconcileTools(dctx, target);
    })
    .catch((err) => {
      console.warn(
        "kitesurf: lazy PageScript.navigate failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
  return stub;
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
  if (!mutations || mutations.length === 0) return;
  syncStyleSheetsFromMutations(ctx, target, mutations);
  if (target.domEnabledSessions.size === 0) return;
  const staleParents = new Set<number>();
  for (const m of mutations) {
    if (!m || typeof m !== "object") continue;
    const kind = m.kind;
    if (typeof kind !== "string" || kind.length === 0) continue;
    if (kind === "stylesheetResourceLoaded") continue;
    if (m.kind === "childNodeCountUpdated" && typeof m.nodeId === "number" && m.nodeId > 0) {
      staleParents.add(m.nodeId);
    }
    for (const sessionId of target.domEnabledSessions) {
      const event = mutationEvent(m, sessionId.length === 0 ? undefined : sessionId);
      if (event) ctx.emit(event);
    }
  }
  if (staleParents.size > 0) scheduleChildRebinds(ctx, target, staleParents);
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
  const work = (async () => {
    const reads = await Promise.all(
      Array.from(parentIds, async (id) => {
        try {
          const r = await stubQueryDom(pageScript, "nodeSubtree", {
            nodeId: id,
          });
          const node = r?.node ?? null;
          assertDomReplyGraph(node);
          return { id, node };
        } catch {
          return { id, node: null };
        }
      }),
    );
    if (target.pageScript !== pageScript) return;
    for (const { id, node } of reads) {
      const nodes = childNodesForRebind(node);
      if (!nodes) continue;
      for (const sessionId of target.domEnabledSessions) {
        ctx.emit({
          method: "DOM.setChildNodes",
          params: { parentId: id, nodes },
          sessionId: sessionId.length === 0 ? undefined : sessionId,
        });
      }
    }
  })();
  ctx.ctx.waitUntil(work);
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
