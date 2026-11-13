// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Builds partial accessibility trees and handles CDP Accessibility commands.

import type { Protocol } from "devtools-protocol";

import { RawJsonResult, type CdpRequest, type TargetState } from "./types.ts";
import type { DispatchCtx } from "./dispatch.ts";
import {
  accessibilityTreeResponse,
  sessionOf,
  type AccessibilityTreeReply,
  type SessionOps,
  type SessionSoftOps,
} from "./page-session.ts";
import type { QueryDomArgs, QueryDomResult, ReadStamp } from "@kitesurf/jsrpc-types/query-dom";
import { ensureTargetDom } from "./dom-release.ts";
import { subtreeBudgetError } from "./dom-frontend.ts";
import { assertDomReplyGraph } from "./dom.ts";

export interface AxNode {
  nodeId: string;
  ignored: boolean;
  ignoredReasons?: Array<{ name: string; value: { type: string; value?: unknown } }>;
  role?: { type: "role" | "internalRole"; value: string };
  chromeRole?: { type: "internalRole"; value: number };
  name?: { type: "computedString"; value: string; sources?: unknown[] };
  description?: { type: "computedString"; value: string };
  value?: { type: string; value?: unknown };
  properties?: Array<{ name: string; value: { type: string; value?: unknown } }>;
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId: number;
  frameId?: string;
}

export interface DomNode {
  nodeId: number;
  backendNodeId?: number;
  nodeType: number;
  nodeName: string;
  localName?: string;
  nodeValue: string;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
  frameId?: string;
}

export async function handleAccessibility(ctx: DispatchCtx, req: CdpRequest): Promise<unknown> {
  const target = pickTarget(ctx, req.sessionId);
  if (!target) return emptyReply(req.method);
  const session = sessionOf(ctx, target);
  const ps = session.available() ? session : null;

  switch (req.method) {
    case "Accessibility.enable": {
      const result = await accessibilityResult(target, ps, req, "root");
      const root = result instanceof RawJsonResult ? rootFromResult(result) : undefined;
      if (root) {
        ctx.emit({
          method: "Accessibility.loadComplete",
          // SAFETY: `buildTree` root is synthetic; `AxNode` also allows newer AX property names.
          // The pinned protocol type omits those names. Related coverage is in
          // `packages/engine/test/e2e/accessibility.e2e.test.ts`.
          params: { root } as Protocol.Accessibility.LoadCompleteEvent,
          sessionId: req.sessionId,
        });
      }
      return {};
    }
    case "Accessibility.disable":
      return {};

    case "Accessibility.getFullAXTree":
      return accessibilityResult(target, ps, req, "full");
    case "Accessibility.getRootAXNode": {
      const result = await accessibilityResult(target, ps, req, "root");
      if (result instanceof RawJsonResult && !rootFromResult(result)) {
        throw new Error("Empty accessibility tree");
      }
      return result;
    }
    case "Accessibility.getPartialAXTree":
      return accessibilityResult(target, ps, req, "partial");
    case "Accessibility.getChildAXNodes":
      return accessibilityResult(target, ps, req, "children");
    case "Accessibility.getAXNodeAndAncestors":
      return accessibilityResult(target, ps, req, "ancestors");
    case "Accessibility.queryAXTree":
      return accessibilityResult(target, ps, req, "query");

    default:
      // Accept unsupported Accessibility methods without a protocol error.
      return {};
  }
}

async function accessibilityResult(
  target: TargetState,
  ps: ReturnType<typeof sessionOf> | null,
  req: CdpRequest,
  method: QueryDomArgs<"accessibilityTree">["method"],
): Promise<RawJsonResult> {
  const args = accessibilityArgs(target, req, method);
  const reply = ps
    ? await accessibilityTreeResponse(
        (buffered) => ps.call.accessibilityTree({ ...args, buffered }),
        req.method,
      )
    : fallbackReply(accessibilityTreeFallback(target, args, req.method));
  if ("budgetError" in reply) throw accessibilityBudgetError(req.method, reply.budgetError);
  return reply.result;
}

function fallbackReply(
  fallback: { budgetError: { nodes: number; bytes: number; budget: number } } | RawJsonResult,
): AccessibilityTreeReply {
  return fallback instanceof RawJsonResult ? { result: fallback } : fallback;
}

function accessibilityArgs(
  target: TargetState,
  req: CdpRequest,
  method: QueryDomArgs<"accessibilityTree">["method"],
): QueryDomArgs<"accessibilityTree"> {
  const params: unknown = req.params;
  const nodeId =
    method === "partial" || method === "ancestors" || method === "query"
      ? pickBackendId(params)
      : null;
  const safeNodeId =
    nodeId === null || (Number.isInteger(nodeId) && nodeId <= 0xffff_ffff) ? nodeId : 0;
  const depth: unknown = params == null ? undefined : Reflect.get(params, "depth");
  const role: unknown = params == null ? undefined : Reflect.get(params, "role");
  const accessibleName: unknown =
    params == null ? undefined : Reflect.get(params, "accessibleName");
  const id: unknown = params == null ? undefined : Reflect.get(params, "id");
  const fetchRelatives: unknown =
    params == null ? undefined : Reflect.get(params, "fetchRelatives");
  return {
    method,
    nodeId: safeNodeId,
    axId: method === "children" ? String(id ?? "") : null,
    fetchRelatives: fetchRelatives !== false,
    role: typeof role === "string" ? role : null,
    accessibleName: typeof accessibleName === "string" ? accessibleName : null,
    ...(method === "full" && typeof depth === "number" ? { depth } : {}),
    frameId: target.frameId,
    title: target.title || "",
    url: target.url || "",
  };
}

function accessibilityTreeFallback(
  target: TargetState,
  args: QueryDomArgs<"accessibilityTree">,
  method: string,
): { budgetError: { nodes: number; bytes: number; budget: number } } | RawJsonResult {
  const dom = ensureTargetDom(target);
  if (!dom) {
    if (args.method === "root") throw new Error("No document loaded");
    return new RawJsonResult(['{"nodes":[]}']);
  }
  const start = dom.accessibilityStream(
    JSON.stringify({ ...args, buffered: true, visibility: true }),
  );
  try {
    const budgetJson = start.budgetError();
    if (budgetJson) return { budgetError: parseAccessibilityBudget(budgetJson) };
    const bytes = start.takeBytes();
    if (!bytes) throw new Error(`${method}: engine accessibility read returned no bytes`);
    try {
      const decoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
      const pieces: string[] = [];
      let filled = 0;
      for (;;) {
        const chunk = bytes.nextChunk(256 * 1024);
        if (chunk.byteLength === 0) break;
        filled += chunk.byteLength;
        const piece = decoder.decode(chunk, { stream: true });
        if (piece) pieces.push(piece);
      }
      if (filled !== bytes.byteLength) {
        throw new Error(
          `${method}: engine accessibility read ended after ${filled} of ${bytes.byteLength} bytes`,
        );
      }
      const tail = decoder.decode();
      if (tail) pieces.push(tail);
      return new RawJsonResult(pieces);
    } finally {
      bytes.free();
    }
  } finally {
    start.free();
  }
}

function parseAccessibilityBudget(json: string): { nodes: number; bytes: number; budget: number } {
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("accessibility stream returned an invalid budget error");
  }
  const nodes: unknown = Reflect.get(value, "nodes");
  const bytes: unknown = Reflect.get(value, "bytes");
  const budget: unknown = Reflect.get(value, "budget");
  if (
    typeof nodes !== "number" ||
    !Number.isSafeInteger(nodes) ||
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    typeof budget !== "number" ||
    !Number.isSafeInteger(budget)
  ) {
    throw new Error("accessibility stream returned an invalid budget error");
  }
  return { nodes, bytes, budget };
}

function accessibilityBudgetError(
  method: string,
  budget: { nodes: number; bytes: number; budget: number },
): Error {
  return new Error(
    `${method}: accessibility tree is ${budget.nodes} nodes and ${budget.bytes} bytes of JSON, ` +
      `over the ${budget.budget}-byte reply budget; request a subtree with ` +
      "Accessibility.getPartialAXTree, Accessibility.queryAXTree, or " +
      "Accessibility.getFullAXTree with depth",
  );
}

function rootFromResult(result: RawJsonResult): AxNode | undefined {
  const parsed: unknown = JSON.parse(result.pieces.join(""));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const node: unknown = Reflect.get(parsed, "node");
  return isAxNode(node) ? node : undefined;
}

function isAxNode(value: unknown): value is AxNode {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return (
    typeof Reflect.get(value, "nodeId") === "string" &&
    typeof Reflect.get(value, "ignored") === "boolean" &&
    typeof Reflect.get(value, "backendDOMNodeId") === "number"
  );
}

function emptyReply(method: string): Record<string, unknown> {
  if (method === "Accessibility.getRootAXNode") {
    return {
      node: {
        nodeId: "0",
        ignored: false,
        role: { type: "role", value: "RootWebArea" },
        name: { type: "computedString", value: "" },
        backendDOMNodeId: 0,
        childIds: [],
      },
    };
  }
  return { nodes: [] };
}

function pickTarget(ctx: DispatchCtx, sessionId: string | undefined): TargetState | undefined {
  if (sessionId) {
    for (const t of ctx.browser.targets.values()) {
      if (t.sessions.has(sessionId)) return t;
    }
  }
  for (const t of ctx.browser.targets.values()) {
    if (t.type === "page") return t;
  }
  return undefined;
}

function pickBackendId(params: unknown): number | null {
  const p = (params ?? {}) as {
    nodeId?: number;
    backendNodeId?: number;
    objectId?: string;
  };
  if (typeof p.backendNodeId === "number" && p.backendNodeId > 0) return p.backendNodeId;
  if (typeof p.nodeId === "number" && p.nodeId > 0) return p.nodeId;
  if (typeof p.objectId === "string") {
    const m = /^node:(\d+)$/.exec(p.objectId);
    if (m) return Number(m[1]);
    const ps = /^ps:(?:[^:]+:)?(\d+)$/.exec(p.objectId);
    if (ps) return Number(ps[1]);
  }
  return null;
}

export interface BuiltTree {
  nodes: AxNode[];
  byId: Map<string, AxNode>;
  // The DOM snapshot the tree was computed from: AX nodes carry no tag or
  // input type, and read consumers need both without a second read.
  root: DomNode;
  readState?: AccessibilityReadState;
}

export interface AccessibilityReadState {
  stamps: {
    document?: ReadStamp;
    visibility?: ReadStamp;
    forms?: ReadStamp;
    accessibility?: ReadStamp;
  };
  forms: {
    values: Map<number, string>;
    checked: Map<number, boolean>;
    selected: Map<number, boolean>;
  };
  fallback: boolean;
}

export type MeasurePageRead = <T>(phase: string, run: () => Promise<T>) => Promise<T>;

export async function buildTree(
  ps: {
    call?: Pick<SessionOps, "getDocument" | "accessibilityTree">;
    tryCall: Pick<SessionSoftOps, "getDocument" | "notRenderedNodeIds" | "formStateSnapshot">;
  } | null,
  target: TargetState,
  options: {
    includeReadState?: boolean;
    fallback?: boolean;
    measureRead?: MeasurePageRead;
  } = {},
): Promise<BuiltTree | null> {
  let root: DomNode | null = null;
  let fallbackDom: ReturnType<typeof ensureTargetDom> = null;
  let liveValues = new Map<number, string>();
  let liveChecked = new Map<number, boolean>();
  let liveSelected = new Map<number, boolean>();
  const stamps: AccessibilityReadState["stamps"] = {};
  if (ps) {
    const read = <T>(phase: string, run: () => Promise<T>): Promise<T> =>
      options.measureRead ? options.measureRead(phase, run) : run();
    const args = options.includeReadState ? { includeReadStamp: true } : {};
    // A full document snapshot can hit PageScript's read budget; preserve that error.
    const readDocument = () => (ps.call ? ps.call.getDocument(args) : ps.tryCall.getDocument(args));
    const [docRes, hiddenRes, formRes] = await Promise.all([
      read("axtree.dom", readDocument),
      read("axtree.visibility", () => ps.tryCall.notRenderedNodeIds(args)),
      read("axtree.forms", () => ps.tryCall.formStateSnapshot(args)),
    ]);
    if (docRes?.budgetError) {
      throw subtreeBudgetError("Accessibility.getFullAXTree", docRes.budgetError);
    }
    stamps.document = docRes?.readStamp;
    stamps.visibility = hiddenRes?.readStamp;
    stamps.forms = formRes?.readStamp;
    root = (docRes?.root as DomNode | undefined) ?? null;
    if (Array.isArray(formRes?.values)) liveValues = new Map(formRes.values);
    if (Array.isArray(formRes?.checked)) liveChecked = new Map(formRes.checked);
    if (Array.isArray(formRes?.selected)) liveSelected = new Map(formRes.selected);
  }
  const usedFallback = !root;
  if (!root && options.fallback !== false) {
    fallbackDom = ensureTargetDom(target);
    if (fallbackDom) {
      const budgetError = fallbackDom.documentBudgetError(-1, true);
      if (budgetError) throw subtreeBudgetError("Accessibility.getFullAXTree", budgetError);
      root = (fallbackDom.getDocument(-1, true) as DomNode | undefined) ?? null;
    }
  }
  if (!root) return null;
  assertDomReplyGraph(root);

  const args = fullAccessibilityArgs(target);
  // A stamped read builds the whole tree in one call, so the mutation sequence
  // it reports covers every node it returns.
  const stampArgs = options.includeReadState ? { includeReadStamp: true } : {};
  let result: { budgetError: { nodes: number; bytes: number; budget: number } } | RawJsonResult;
  if (ps) {
    let request: (buffered: boolean) => Promise<QueryDomResult<"accessibilityTree">>;
    if (ps.call) {
      const call = ps.call;
      request = (buffered) => call.accessibilityTree({ ...args, ...stampArgs, buffered });
    } else if (target.pageScript) {
      const pageScript = target.pageScript;
      request = (buffered) =>
        pageScript.queryDom("accessibilityTree", { ...args, ...stampArgs, buffered });
    } else {
      throw new Error("buildTree: PageScript isolate is unavailable");
    }
    const read = () => accessibilityTreeResponse(request, "Accessibility.getFullAXTree");
    const reply = options.measureRead
      ? await options.measureRead("axtree.accessibility", read)
      : await read();
    if (!("budgetError" in reply)) stamps.accessibility = reply.readStamp;
    result = "budgetError" in reply ? reply : reply.result;
  } else {
    if (!fallbackDom) return null;
    result = accessibilityTreeFallback(target, args, "Accessibility.getFullAXTree");
  }
  if (!(result instanceof RawJsonResult)) {
    throw accessibilityBudgetError("Accessibility.getFullAXTree", result.budgetError);
  }
  const { nodes, byId } = fullTreeFromResult(result);
  const readState = options.includeReadState
    ? {
        stamps,
        forms: { values: liveValues, checked: liveChecked, selected: liveSelected },
        fallback: usedFallback,
      }
    : undefined;
  return { nodes, byId, root, ...(readState ? { readState } : {}) };
}

function fullAccessibilityArgs(target: TargetState): QueryDomArgs<"accessibilityTree"> {
  return {
    method: "full",
    nodeId: null,
    axId: null,
    fetchRelatives: true,
    role: null,
    accessibleName: null,
    frameId: target.frameId,
    title: target.title || "",
    url: target.url || "",
  };
}

function fullTreeFromResult(result: RawJsonResult): Pick<BuiltTree, "nodes" | "byId"> {
  const parsed: unknown = JSON.parse(result.pieces.join(""));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("buildTree: Rust accessibility tree returned an invalid JSON object");
  }
  const nodes: unknown = Reflect.get(parsed, "nodes");
  if (!Array.isArray(nodes) || !nodes.every(isAxNode)) {
    throw new Error("buildTree: Rust accessibility tree returned invalid nodes");
  }
  const byId = new Map<string, AxNode>();
  for (const node of nodes) byId.set(node.nodeId, node);
  return { nodes, byId };
}
