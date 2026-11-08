// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Reads the accessibility tree and handles CDP Accessibility commands.

import type { Protocol } from "devtools-protocol";

import { RawJsonResult, type CdpRequest, type TargetState } from "./types.ts";
import type { DispatchCtx } from "./dispatch.ts";
import {
  accessibilityTreeResponse,
  sessionOf,
  type AccessibilityTreeReply,
  type AccessibilityTreeRequest,
  type SessionOps,
  type SessionSoftOps,
} from "./page-session.ts";
import type {
  AccessibilityBudgetError,
  QueryDomArgs,
  ReadStamp,
} from "@kitesurf/jsrpc-types/query-dom";
import { ensureTargetDom, releasedFallbackError } from "./dom-release.ts";
import { subtreeBudgetError } from "./dom-frontend.ts";
import { assertDomReplyGraph } from "./dom.ts";

type AxMethod = QueryDomArgs<"accessibilityTree">["method"];

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
      const root = rootFromResult(await accessibilityResult(target, ps, req, "root"));
      if (root) {
        ctx.emit({
          method: "Accessibility.loadComplete",
          // SAFETY: the Rust tree's root is synthetic; `AxNode` also allows newer AX property
          // names, which the pinned protocol type omits. Related coverage is in
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
      if (!rootFromResult(result)) throw new Error("Empty accessibility tree");
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
  axMethod: AxMethod,
): Promise<RawJsonResult> {
  const args = accessibilityArgs(target, req, axMethod);
  const reply = ps
    ? await accessibilityTreeResponse(
        (buffered) => ps.call.accessibilityTree({ ...args, buffered }),
        req.method,
      )
    : accessibilityTreeFallback(target, args, req.method);
  if ("budgetError" in reply) throw accessibilityBudgetError(req.method, reply.budgetError);
  return reply.result;
}

function accessibilityArgs(
  target: TargetState,
  req: CdpRequest,
  axMethod: AxMethod,
): QueryDomArgs<"accessibilityTree"> {
  const params: unknown = req.params;
  const nodeId =
    axMethod === "partial" || axMethod === "ancestors" || axMethod === "query"
      ? pickBackendId(params)
      : null;
  const safeNodeId =
    nodeId === null || (Number.isInteger(nodeId) && nodeId <= 0xffff_ffff) ? nodeId : 0;
  const depth = paramField(params, "depth");
  const role = paramField(params, "role");
  const accessibleName = paramField(params, "accessibleName");
  const id = paramField(params, "id");
  const fetchRelatives = paramField(params, "fetchRelatives");
  return {
    method: axMethod,
    nodeId: safeNodeId,
    axId: axMethod === "children" ? String(id ?? "") : null,
    fetchRelatives: fetchRelatives !== false,
    role: typeof role === "string" ? role : null,
    accessibleName: typeof accessibleName === "string" ? accessibleName : null,
    ...(axMethod === "full" && typeof depth === "number" ? { depth } : {}),
    frameId: target.frameId,
    title: target.title || "",
    url: target.url || "",
  };
}

// CDP params arrive as wire JSON, so every field is read as untrusted.
function paramField(params: unknown, key: string): unknown {
  return params == null ? undefined : Reflect.get(params, key);
}

function accessibilityTreeFallback(
  target: TargetState,
  args: QueryDomArgs<"accessibilityTree">,
  cdpMethod: string,
): AccessibilityTreeReply {
  const dom = ensureTargetDom(target);
  if (!dom) {
    if (args.method === "root") throw new Error("No document loaded");
    if (target.fallbackHtmlReleased) throw releasedFallbackError(cdpMethod);
    return { result: new RawJsonResult(['{"nodes":[]}']) };
  }
  const start = dom.accessibilityStream(
    JSON.stringify({ ...args, buffered: true, visibility: true }),
  );
  try {
    const budgetJson = start.budgetError();
    if (budgetJson) return { budgetError: parseAccessibilityBudget(budgetJson) };
    const bytes = start.takeBytes();
    if (!bytes) throw new Error(`${cdpMethod}: engine accessibility read returned no bytes`);
    try {
      return { result: readEngineTreeBytes(bytes, cdpMethod) };
    } finally {
      bytes.free();
    }
  } finally {
    start.free();
  }
}

// The engine holds the whole tree in memory and hands it over in chunks; the pieces join as JSON.
function readEngineTreeBytes(
  bytes: { readonly byteLength: number; nextChunk(maxBytes: number): Uint8Array },
  cdpMethod: string,
): RawJsonResult {
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
      `${cdpMethod}: engine accessibility read ended after ${filled} of ${bytes.byteLength} bytes`,
    );
  }
  const tail = decoder.decode();
  if (tail) pieces.push(tail);
  return new RawJsonResult(pieces);
}

function parseAccessibilityBudget(json: string): AccessibilityBudgetError {
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("accessibility stream returned an invalid budget error");
  }
  const nodes = Reflect.get(value, "nodes");
  const bytes = Reflect.get(value, "bytes");
  const budget = Reflect.get(value, "budget");
  if (!isSafeInteger(nodes) || !isSafeInteger(bytes) || !isSafeInteger(budget)) {
    throw new Error("accessibility stream returned an invalid budget error");
  }
  return { nodes, bytes, budget };
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function accessibilityBudgetError(cdpMethod: string, budget: AccessibilityBudgetError): Error {
  return new Error(
    `${cdpMethod}: accessibility tree is ${budget.nodes} nodes and ${budget.bytes} bytes of JSON, ` +
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

type BuildTreeSession = {
  call?: Pick<SessionOps, "getDocument" | "accessibilityTree">;
  tryCall: Pick<SessionSoftOps, "getDocument" | "notRenderedNodeIds" | "formStateSnapshot">;
};

type BuildTreeOptions = {
  includeReadState?: boolean;
  fallback?: boolean;
  measureRead?: MeasurePageRead;
};

interface DocumentSnapshot {
  root: DomNode;
  /** The engine's own DOM, when it had to serve the snapshot PageScript could not. */
  fallbackDom: ReturnType<typeof ensureTargetDom>;
  usedFallback: boolean;
  stamps: AccessibilityReadState["stamps"];
  forms: AccessibilityReadState["forms"];
}

export async function buildTree(
  ps: BuildTreeSession | null,
  target: TargetState,
  options: BuildTreeOptions = {},
): Promise<BuiltTree | null> {
  const snapshot = await readDocumentSnapshot(ps, target, options);
  if (!snapshot) return null;

  const tree = await readAccessibilityTree(ps, target, snapshot.fallbackDom, options);
  if (!tree) return null;
  if (tree.stamp) snapshot.stamps.accessibility = tree.stamp;

  const readState = options.includeReadState
    ? { stamps: snapshot.stamps, forms: snapshot.forms, fallback: snapshot.usedFallback }
    : undefined;
  return {
    ...fullTreeFromResult(tree.result),
    root: snapshot.root,
    ...(readState ? { readState } : {}),
  };
}

async function readDocumentSnapshot(
  ps: BuildTreeSession | null,
  target: TargetState,
  options: BuildTreeOptions,
): Promise<DocumentSnapshot | null> {
  const stamps: AccessibilityReadState["stamps"] = {};
  let root: DomNode | null = null;
  let values = new Map<number, string>();
  let checked = new Map<number, boolean>();
  let selected = new Map<number, boolean>();

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
    if (Array.isArray(formRes?.values)) values = new Map(formRes.values);
    if (Array.isArray(formRes?.checked)) checked = new Map(formRes.checked);
    if (Array.isArray(formRes?.selected)) selected = new Map(formRes.selected);
  }

  const usedFallback = !root;
  let fallbackDom: ReturnType<typeof ensureTargetDom> = null;
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
  return { root, fallbackDom, usedFallback, stamps, forms: { values, checked, selected } };
}

async function readAccessibilityTree(
  ps: BuildTreeSession | null,
  target: TargetState,
  fallbackDom: ReturnType<typeof ensureTargetDom>,
  options: BuildTreeOptions,
): Promise<{ result: RawJsonResult; stamp?: ReadStamp } | null> {
  const args = fullAccessibilityArgs(target);
  if (!ps) {
    // PageScript could not read the document, so the tree comes from the engine's copy.
    if (!fallbackDom) return null;
    const reply = accessibilityTreeFallback(target, args, "Accessibility.getFullAXTree");
    if ("budgetError" in reply) {
      throw accessibilityBudgetError("Accessibility.getFullAXTree", reply.budgetError);
    }
    return { result: reply.result };
  }

  // A stamped read builds the whole tree in one call, so the mutation sequence
  // it reports covers every node it returns.
  const stampArgs = options.includeReadState ? { includeReadStamp: true } : {};
  const request = accessibilityRequest(ps, target, args, stampArgs);
  const read = () => accessibilityTreeResponse(request, "Accessibility.getFullAXTree");
  const reply = options.measureRead
    ? await options.measureRead("axtree.accessibility", read)
    : await read();
  if ("budgetError" in reply) {
    throw accessibilityBudgetError("Accessibility.getFullAXTree", reply.budgetError);
  }
  return { result: reply.result, stamp: reply.readStamp };
}

// The engine prefers the retained session; a target with only a PageScript stub still answers.
function accessibilityRequest(
  ps: BuildTreeSession,
  target: TargetState,
  args: QueryDomArgs<"accessibilityTree">,
  stampArgs: { includeReadStamp?: boolean },
): AccessibilityTreeRequest {
  if (ps.call) {
    const call = ps.call;
    return (buffered) => call.accessibilityTree({ ...args, ...stampArgs, buffered });
  }
  if (!target.pageScript) throw new Error("buildTree: PageScript isolate is unavailable");
  const pageScript = target.pageScript;
  return (buffered) =>
    pageScript.queryDom("accessibilityTree", { ...args, ...stampArgs, buffered });
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
