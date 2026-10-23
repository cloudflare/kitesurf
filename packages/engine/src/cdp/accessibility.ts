// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Builds partial accessibility trees and handles CDP Accessibility commands.

import type { Protocol } from "devtools-protocol";

import type { CdpRequest, TargetState } from "./types.ts";
import type { DispatchCtx } from "./dispatch.ts";
import { sessionOf, type PageSession, type SessionSoftOps } from "./page-session.ts";
import type { ReadStamp } from "@kitesurf/jsrpc-types/query-dom";
import { ensureTargetDom } from "./dom-release.ts";
import { isRecord } from "../guards.ts";

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

  return dispatchAccessibilityMethod(ctx, target, ps, req);
}

function dispatchAccessibilityMethod(
  ctx: DispatchCtx,
  target: TargetState,
  ps: PageSession | null,
  req: CdpRequest,
): Promise<unknown> | unknown {
  switch (req.method) {
    case "Accessibility.enable":
      return enableAccessibility(ctx, target, ps, req.sessionId);
    case "Accessibility.disable":
      return {};
    case "Accessibility.getFullAXTree":
      return getFullAccessibilityTree(ps, target);
    case "Accessibility.getRootAXNode":
      return getRootAccessibilityNode(ps, target);
    case "Accessibility.getPartialAXTree":
      return getPartialAccessibilityTree(ps, target, req);
    case "Accessibility.getChildAXNodes":
      return getChildAccessibilityNodes(ps, target, req);
    case "Accessibility.getAXNodeAndAncestors":
      return getAccessibilityNodeAndAncestors(ps, target, req);
    case "Accessibility.queryAXTree":
      return queryAccessibilityTree(ps, target, req);

    default:
      // Accept unsupported Accessibility methods without a protocol error.
      return {};
  }
}

async function enableAccessibility(
  ctx: DispatchCtx,
  target: TargetState,
  ps: PageSession | null,
  sessionId: string | undefined,
): Promise<Record<string, never>> {
  const tree = await buildTree(ps, target);
  const root = tree?.nodes[0];
  if (root) {
    ctx.emit({
      method: "Accessibility.loadComplete",
      // SAFETY: `buildTree` root is synthetic; `AxNode` also allows newer AX property names.
      // The pinned protocol type omits those names. Related coverage is in
      // `packages/engine/test/e2e/accessibility.e2e.test.ts`.
      params: { root } as Protocol.Accessibility.LoadCompleteEvent,
      sessionId,
    });
  }
  return {};
}

async function getFullAccessibilityTree(
  ps: PageSession | null,
  target: TargetState,
): Promise<{ nodes: AxNode[] }> {
  const tree = await buildTree(ps, target);
  return { nodes: tree ? tree.nodes : [] };
}

async function getRootAccessibilityNode(
  ps: PageSession | null,
  target: TargetState,
): Promise<{ node: AxNode }> {
  const tree = await buildTree(ps, target);
  if (!tree) throw new Error("No document loaded");
  const root = tree.nodes[0];
  if (!root) throw new Error("Empty accessibility tree");
  return { node: root };
}

async function getPartialAccessibilityTree(
  ps: PageSession | null,
  target: TargetState,
  req: Extract<CdpRequest, { method: "Accessibility.getPartialAXTree" }>,
): Promise<{ nodes: AxNode[] }> {
  const tree = await buildTree(ps, target);
  if (!tree) return { nodes: [] };
  const id = pickBackendId(req.params, tree);
  if (id == null) return { nodes: [] };
  const collected = new Map<string, AxNode>();
  collectSubtree(tree, String(id), collected);
  if (req.params?.fetchRelatives !== false) collectAncestors(tree, String(id), collected);
  return { nodes: Array.from(collected.values()) };
}

async function getChildAccessibilityNodes(
  ps: PageSession | null,
  target: TargetState,
  req: Extract<CdpRequest, { method: "Accessibility.getChildAXNodes" }>,
): Promise<{ nodes: AxNode[] }> {
  const tree = await buildTree(ps, target);
  if (!tree) return { nodes: [] };
  const parent = tree.byId.get(String(req.params?.id ?? ""));
  if (!parent) return { nodes: [] };
  return { nodes: accessibilityChildren(tree, parent) };
}

function accessibilityChildren(tree: BuiltTree, parent: AxNode): AxNode[] {
  const nodes: AxNode[] = [];
  for (const id of parent.childIds ?? []) {
    const node = tree.byId.get(id);
    if (node) nodes.push(node);
  }
  return nodes;
}

async function getAccessibilityNodeAndAncestors(
  ps: PageSession | null,
  target: TargetState,
  req: CdpRequest,
): Promise<{ nodes: AxNode[] }> {
  const tree = await buildTree(ps, target);
  if (!tree) return { nodes: [] };
  const id = pickBackendId(req.params, tree);
  if (id == null) return { nodes: [] };
  return { nodes: accessibilityNodeChain(tree, String(id)) };
}

function accessibilityNodeChain(tree: BuiltTree, startId: string): AxNode[] {
  const chain: AxNode[] = [];
  let current: string | undefined = startId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const node = tree.byId.get(current);
    if (!node) break;
    chain.push(node);
    current = node.parentId;
  }
  return chain;
}

async function queryAccessibilityTree(
  ps: PageSession | null,
  target: TargetState,
  req: Extract<CdpRequest, { method: "Accessibility.queryAXTree" }>,
): Promise<{ nodes: AxNode[] }> {
  const tree = await buildTree(ps, target);
  if (!tree) return { nodes: [] };
  const params = req.params ?? {};
  const subtree = accessibilitySubtree(tree, pickExplicitBackendId(params));
  return { nodes: filterAccessibilityNodes(subtree, params) };
}

function accessibilitySubtree(tree: BuiltTree, rootId: number | null): Map<string, AxNode> {
  const subtree = new Map<string, AxNode>();
  if (rootId == null) {
    for (const node of tree.nodes) subtree.set(node.nodeId, node);
  } else {
    collectSubtree(tree, String(rootId), subtree);
  }
  return subtree;
}

function filterAccessibilityNodes(
  subtree: Map<string, AxNode>,
  params: NonNullable<Extract<CdpRequest, { method: "Accessibility.queryAXTree" }>["params"]>,
): AxNode[] {
  const wantName = typeof params.accessibleName === "string" ? params.accessibleName : undefined;
  const wantRole = typeof params.role === "string" ? params.role : undefined;
  const matches: AxNode[] = [];
  for (const node of subtree.values()) {
    if (matchesAccessibilityNode(node, wantRole, wantName)) matches.push(node);
  }
  return matches;
}

function matchesAccessibilityNode(
  node: AxNode,
  wantRole: string | undefined,
  wantName: string | undefined,
): boolean {
  if (node.ignored) return false;
  return matchesAccessibilityRole(node, wantRole) && matchesAccessibilityName(node, wantName);
}

function matchesAccessibilityRole(node: AxNode, wantRole: string | undefined): boolean {
  return !wantRole || (node.role?.value ?? "") === wantRole;
}

function matchesAccessibilityName(node: AxNode, wantName: string | undefined): boolean {
  return wantName == null || (node.name?.value ?? "") === wantName;
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
    const sessionTarget = findSessionTarget(ctx, sessionId);
    if (sessionTarget) return sessionTarget;
  }
  return findPageTarget(ctx);
}

function findSessionTarget(ctx: DispatchCtx, sessionId: string): TargetState | undefined {
  for (const t of ctx.browser.targets.values()) {
    if (t.sessions.has(sessionId)) return t;
  }
  return undefined;
}

function findPageTarget(ctx: DispatchCtx): TargetState | undefined {
  for (const t of ctx.browser.targets.values()) {
    if (t.type === "page") return t;
  }
  return undefined;
}

function pickBackendId(params: unknown, tree: BuiltTree): number | null {
  return requestedBackendId(params) ?? tree.nodes[0]?.backendDOMNodeId ?? null;
}

function pickExplicitBackendId(params: unknown): number | null {
  return requestedBackendId(params);
}

function requestedBackendId(params: unknown): number | null {
  const p = isRecord(params) ? params : {};
  return (
    positiveBackendId(p.backendNodeId) ?? positiveBackendId(p.nodeId) ?? objectBackendId(p.objectId)
  );
}

function positiveBackendId(value: unknown): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}

function objectBackendId(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(?:node|ps):(\d+)$/.exec(value);
  return match ? Number(match[1]) : null;
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
  };
  forms: {
    values: Map<number, string>;
    checked: Map<number, boolean>;
    selected: Map<number, boolean>;
  };
  fallback: boolean;
}

export type MeasurePageRead = <T>(phase: string, run: () => Promise<T>) => Promise<T>;

type AccessibilityPageSession = {
  tryCall: Pick<SessionSoftOps, "getDocument" | "notRenderedNodeIds" | "formStateSnapshot">;
};

interface BuildTreeOptions {
  includeReadState?: boolean;
  fallback?: boolean;
  measureRead?: MeasurePageRead;
}

interface AccessibilityPageData {
  root: DomNode | null;
  displayNone: Set<number>;
  invisible: Set<number>;
  liveValues: Map<number, string>;
  liveChecked: Map<number, boolean>;
  liveSelected: Map<number, boolean>;
  stamps: AccessibilityReadState["stamps"];
}

type AccessibilityVisibilityResult = Awaited<ReturnType<SessionSoftOps["notRenderedNodeIds"]>>;
type AccessibilityFormsResult = Awaited<ReturnType<SessionSoftOps["formStateSnapshot"]>>;

function emptyAccessibilityPageData(): AccessibilityPageData {
  return {
    root: null,
    displayNone: new Set<number>(),
    invisible: new Set<number>(),
    liveValues: new Map<number, string>(),
    liveChecked: new Map<number, boolean>(),
    liveSelected: new Map<number, boolean>(),
    stamps: {},
  };
}

async function readAccessibilityPageData(
  ps: AccessibilityPageSession,
  options: BuildTreeOptions,
): Promise<AccessibilityPageData> {
  const read = <T>(phase: string, run: () => Promise<T>): Promise<T> =>
    options.measureRead ? options.measureRead(phase, run) : run();
  const args = options.includeReadState ? { includeReadStamp: true } : {};
  const [docRes, hiddenRes, formRes] = await Promise.all([
    read("axtree.dom", () => ps.tryCall.getDocument(args)),
    read("axtree.visibility", () => ps.tryCall.notRenderedNodeIds(args)),
    read("axtree.forms", () => ps.tryCall.formStateSnapshot(args)),
  ]);
  return accessibilityPageDataFromResponses(docRes, hiddenRes, formRes);
}

function accessibilityPageDataFromResponses(
  docRes: Awaited<ReturnType<SessionSoftOps["getDocument"]>>,
  hiddenRes: AccessibilityVisibilityResult,
  formRes: AccessibilityFormsResult,
): AccessibilityPageData {
  const visibility = accessibilityVisibilityData(hiddenRes);
  const forms = accessibilityFormsData(formRes);
  return {
    root: (docRes?.root as DomNode | undefined) ?? null,
    displayNone: visibility.displayNone,
    invisible: visibility.invisible,
    liveValues: forms.liveValues,
    liveChecked: forms.liveChecked,
    liveSelected: forms.liveSelected,
    stamps: accessibilityReadStamps(docRes, hiddenRes, formRes),
  };
}

function accessibilityReadStamps(
  docRes: Awaited<ReturnType<SessionSoftOps["getDocument"]>>,
  hiddenRes: AccessibilityVisibilityResult,
  formRes: AccessibilityFormsResult,
): AccessibilityReadState["stamps"] {
  return {
    document: docRes?.readStamp,
    visibility: hiddenRes?.readStamp,
    forms: formRes?.readStamp,
  };
}

function accessibilityVisibilityData(
  result: AccessibilityVisibilityResult,
): Pick<AccessibilityPageData, "displayNone" | "invisible"> {
  const displayNone = Array.isArray(result?.displayNone)
    ? new Set(result.displayNone)
    : new Set<number>();
  const invisible = Array.isArray(result?.invisible)
    ? new Set(result.invisible)
    : new Set<number>();
  return { displayNone, invisible };
}

function accessibilityFormsData(
  result: AccessibilityFormsResult,
): Pick<AccessibilityPageData, "liveValues" | "liveChecked" | "liveSelected"> {
  return {
    liveValues: numberStringMap(result?.values),
    liveChecked: numberBooleanMap(result?.checked),
    liveSelected: numberBooleanMap(result?.selected),
  };
}

function numberStringMap(value: Array<[number, string]> | undefined): Map<number, string> {
  return Array.isArray(value) ? new Map(value) : new Map<number, string>();
}

function numberBooleanMap(value: Array<[number, boolean]> | undefined): Map<number, boolean> {
  return Array.isArray(value) ? new Map(value) : new Map<number, boolean>();
}

function fallbackDocument(
  root: DomNode | null,
  target: TargetState,
  fallbackEnabled: boolean,
): DomNode | null {
  if (root || !fallbackEnabled) return root;
  const dom = ensureTargetDom(target);
  if (!dom) return null;
  try {
    return dom.getDocument() as DomNode;
  } catch {
    return null;
  }
}

export async function buildTree(
  ps: AccessibilityPageSession | null,
  target: TargetState,
  options: BuildTreeOptions = {},
): Promise<BuiltTree | null> {
  const data = ps ? await readAccessibilityPageData(ps, options) : emptyAccessibilityPageData();
  const usedFallback = !data.root;
  const root = fallbackDocument(data.root, target, options.fallback !== false);
  if (!root) return null;

  const ctx = new BuildCtx(target.frameId, data.displayNone, data.invisible);
  ctx.root = root;
  ctx.baseUrl = target.url || "";
  ctx.liveValues = data.liveValues;
  ctx.liveChecked = data.liveChecked;
  ctx.liveSelected = data.liveSelected;
  ctx.indexIds(root);
  const rootAx = ctx.build(root, null, {
    ariaHidden: false,
    hidden: false,
    textHidden: false,
    layoutTable: false,
    listDepth: 0,
  });
  const rootWeb = rootWebAreaNode(target, root, rootAx);
  ctx.byId.set(rootWeb.nodeId, rootWeb);
  ctx.nodes.unshift(rootWeb);
  return finishBuiltTree(ctx, root, data, usedFallback, options.includeReadState);
}

function finishBuiltTree(
  ctx: BuildCtx,
  root: DomNode,
  data: AccessibilityPageData,
  usedFallback: boolean,
  includeReadState: boolean | undefined,
): BuiltTree {
  const readState = includeReadState
    ? {
        stamps: data.stamps,
        forms: {
          values: data.liveValues,
          checked: data.liveChecked,
          selected: data.liveSelected,
        },
        fallback: usedFallback,
      }
    : undefined;
  return { nodes: ctx.nodes, byId: ctx.byId, root, ...(readState ? { readState } : {}) };
}

function rootWebAreaNode(target: TargetState, root: DomNode, rootAx: AxNode | null): AxNode {
  const rootWeb: AxNode = {
    nodeId: `root-${target.frameId}`,
    ignored: false,
    role: { type: "internalRole", value: "RootWebArea" },
    chromeRole: { type: "internalRole", value: 144 },
    name: { type: "computedString", value: target.title || "" },
    value: { type: "string", value: target.url || "" },
    backendDOMNodeId: root.backendNodeId ?? 0,
    frameId: target.frameId,
    childIds: rootWebAreaChildIds(rootAx),
    properties: [
      { name: "url", value: { type: "string", value: target.url || "" } },
      { name: "focusable", value: { type: "booleanOrUndefined", value: true } },
    ],
  };
  linkRootWebAreaChild(rootWeb, rootAx);
  return rootWeb;
}

function linkRootWebAreaChild(rootWeb: AxNode, rootAx: AxNode | null): void {
  if (!rootAx) return;
  rootAx.parentId = rootWeb.nodeId;
}

function rootWebAreaChildIds(rootAx: AxNode | null): string[] {
  return rootAx ? [rootAx.nodeId] : [];
}

interface Inherited {
  ariaHidden: boolean;
  hidden: boolean;
  textHidden: boolean;
  layoutTable: boolean;
  listDepth: number;
}

interface ElementBasics {
  tag: string;
  attrs: Map<string, string>;
  backendId: number;
}

interface ElementVisibility {
  selfAriaHidden: boolean;
  ariaHidden: boolean;
  noBox: boolean;
  subtreeHidden: boolean;
  hidden: boolean;
}

interface ElementTableState {
  inLayoutTable: boolean;
  demotedByTable: boolean;
}

interface ElementBuildInfo extends ElementBasics, ElementVisibility, ElementTableState {
  axId: string;
  explicitRole: string;
  role: string;
  name: string;
  description: string;
  value: AxNode["value"];
  props: NonNullable<AxNode["properties"]>;
}

class BuildCtx {
  nodes: AxNode[] = [];
  byId = new Map<string, AxNode>();
  idAttrToBackend = new Map<string, number>();
  frameId: string;
  displayNone: Set<number>;
  invisible: Set<number>;
  root: DomNode | null = null;
  parentOf = new Map<number, DomNode>();
  baseUrl = "";
  sawBase = false;
  liveValues = new Map<number, string>();
  liveChecked = new Map<number, boolean>();
  liveSelected = new Map<number, boolean>();
  backendToNode = new Map<number, DomNode>();
  labelForId = new Map<string, DomNode>();

  constructor(frameId: string, displayNone: Set<number>, invisible: Set<number>) {
    this.frameId = frameId;
    this.displayNone = displayNone;
    this.invisible = invisible;
  }

  inSelect(optionId: number): boolean {
    let parent = this.parentOf.get(optionId);
    if (parent && localTag(parent) === "optgroup" && typeof parent.backendNodeId === "number") {
      parent = this.parentOf.get(parent.backendNodeId);
    }
    return parent !== undefined && localTag(parent) === "select";
  }

  indexIds(node: DomNode): void {
    this.indexBackendNode(node);
    this.indexElement(node);
    this.indexParentLinks(node);
    this.indexNodeList(node.children);
    this.indexNodeList(node.shadowRoots);
    if (node.contentDocument) this.indexIds(node.contentDocument);
  }

  private indexBackendNode(node: DomNode): void {
    if (typeof node.backendNodeId === "number") {
      this.backendToNode.set(node.backendNodeId, node);
    }
  }

  private indexElement(node: DomNode): void {
    if (node.nodeType !== 1) return;
    const attrs = attrMap(node.attributes);
    this.indexIdAttribute(node, attrs);
    this.indexLabel(node, attrs);
    this.indexBase(node, attrs);
  }

  private indexIdAttribute(node: DomNode, attrs: Map<string, string>): void {
    const id = attrs.get("id");
    if (id && typeof node.backendNodeId === "number") {
      this.idAttrToBackend.set(id, node.backendNodeId);
    }
  }

  private indexLabel(node: DomNode, attrs: Map<string, string>): void {
    if (localTag(node) !== "label") return;
    const forId = attrs.get("for");
    if (forId && !this.labelForId.has(forId)) this.labelForId.set(forId, node);
  }

  private indexBase(node: DomNode, attrs: Map<string, string>): void {
    if (localTag(node) !== "base") return;
    const href = attrs.get("href");
    if (!href || this.sawBase) return;
    this.sawBase = true;
    this.baseUrl = absUrl(href, this.baseUrl) || this.baseUrl;
  }

  private indexParentLinks(node: DomNode): void {
    for (const child of node.children ?? []) {
      if (typeof child.backendNodeId === "number") {
        this.parentOf.set(child.backendNodeId, node);
      }
    }
  }

  private indexNodeList(nodes: DomNode[] | undefined): void {
    for (const node of nodes ?? []) this.indexIds(node);
  }

  build(node: DomNode, parentAxId: string | null, inh: Inherited): AxNode | null {
    if (node.nodeType === 3) return this.buildTextNode(node, parentAxId, inh);
    if (node.nodeType === 9) return this.buildDocumentNode(node, parentAxId, inh);
    if (node.nodeType !== 1) return null;
    return this.buildElementNode(node, parentAxId, inh);
  }

  private buildTextNode(node: DomNode, parentAxId: string | null, inh: Inherited): AxNode | null {
    const text = textNodeContent(node);
    if (!text) return null;
    const ax = textAxNode(
      backendIdForNode(node),
      text,
      isInheritedTextHidden(inh),
      inh.ariaHidden,
      this.frameId,
    );
    if (parentAxId) ax.parentId = parentAxId;
    this.nodes.push(ax);
    this.byId.set(ax.nodeId, ax);
    return ax;
  }

  private buildDocumentNode(
    node: DomNode,
    parentAxId: string | null,
    inh: Inherited,
  ): AxNode | null {
    let firstChild: AxNode | null = null;
    for (const child of node.children ?? []) {
      const built = this.build(child, parentAxId, inh);
      if (built && !firstChild) firstChild = built;
    }
    return firstChild;
  }

  private buildElementNode(
    node: DomNode,
    parentAxId: string | null,
    inh: Inherited,
  ): AxNode | null {
    const info = elementBuildInfo(this, node, inh);
    if (!info) return null;
    const ax = elementAxNode(this.frameId, info);
    if (parentAxId) ax.parentId = parentAxId;
    this.nodes.push(ax);
    this.byId.set(info.axId, ax);
    if (info.noBox) return ax;
    const childIds = elementChildIds(this, node, info, inh);
    if (childIds.length > 0) ax.childIds = childIds;
    return ax;
  }
}

function textNodeContent(node: DomNode): string {
  return (node.nodeValue ?? "").replace(/\s+/g, " ").trim();
}

function isInheritedTextHidden(inh: Inherited): boolean {
  return inh.hidden || inh.textHidden;
}

function textAxNode(
  id: number,
  text: string,
  hidden: boolean,
  ariaHidden: boolean,
  frameId: string,
): AxNode {
  const ax: AxNode = {
    nodeId: String(id),
    ignored: hidden,
    backendDOMNodeId: id,
    frameId,
  };
  if (hidden) {
    ax.ignoredReasons = [ignoreReason(ariaHidden ? "ariaHiddenSubtree" : "notRendered")];
    ax.role = { type: "internalRole", value: "none" };
  } else {
    ax.role = { type: "internalRole", value: "StaticText" };
    ax.name = { type: "computedString", value: text };
  }
  return ax;
}

function elementBuildInfo(ctx: BuildCtx, node: DomNode, inh: Inherited): ElementBuildInfo | null {
  const basics = elementBasics(node);
  if (!basics) return null;
  const visibility = elementVisibility(ctx, basics, inh);
  const explicitRole = firstToken(basics.attrs.get("role"));
  const role = elementRole(basics.tag, basics.attrs, explicitRole);
  const table = elementTableState(node, basics, explicitRole, inh);
  return {
    ...basics,
    ...visibility,
    ...table,
    axId: String(basics.backendId),
    explicitRole,
    role,
    name: computeName(node, basics.tag, basics.attrs, ctx),
    description: computeDescription(basics.attrs, ctx),
    value: computeValue(node, basics.tag, basics.attrs, ctx),
    props: computeProperties(basics.tag, basics.attrs, node, ctx, role, inh.listDepth),
  };
}

function elementBasics(node: DomNode): ElementBasics | null {
  const tag = localTag(node);
  if (SKIP_TAGS.has(tag)) return null;
  const backendId = backendIdForNode(node);
  return { tag, attrs: attrMap(node.attributes), backendId };
}

function backendIdForNode(node: DomNode): number {
  return node.backendNodeId ?? node.nodeId ?? 0;
}

function elementRole(tag: string, attrs: Map<string, string>, explicitRole: string): string {
  return explicitRole || implicitRole(tag, attrs) || "generic";
}

function elementVisibility(
  ctx: BuildCtx,
  basics: ElementBasics,
  inh: Inherited,
): ElementVisibility {
  const selfAriaHidden = basics.attrs.get("aria-hidden") === "true";
  const ariaHidden = inh.ariaHidden || selfAriaHidden;
  const noBox = elementHasNoBox(ctx, basics);
  const subtreeHidden = inh.hidden || ariaHidden || noBox;
  return {
    selfAriaHidden,
    ariaHidden,
    noBox,
    subtreeHidden,
    hidden: subtreeHidden || ctx.invisible.has(basics.backendId),
  };
}

function elementHasNoBox(ctx: BuildCtx, basics: ElementBasics): boolean {
  return elementIsBoxless(ctx, basics) || basics.attrs.has("hidden");
}

function elementIsBoxless(ctx: BuildCtx, basics: ElementBasics): boolean {
  const hiddenOption = isUaHiddenOption(ctx, basics);
  const noDisplay = ctx.displayNone.has(basics.backendId) && !hiddenOption;
  return noDisplay || isHiddenInput(basics);
}

function isUaHiddenOption(ctx: BuildCtx, basics: ElementBasics): boolean {
  return (
    basics.tag === "option" &&
    ctx.inSelect(basics.backendId) &&
    !inlineDisplayNone(basics.attrs.get("style"))
  );
}

function isHiddenInput(basics: ElementBasics): boolean {
  return basics.tag === "input" && basics.attrs.get("type")?.trim().toLowerCase() === "hidden";
}

function elementTableState(
  node: DomNode,
  basics: ElementBasics,
  explicitRole: string,
  inh: Inherited,
): ElementTableState {
  const startsLayoutTable = isLayoutTableElement(node, basics, explicitRole);
  const inLayoutTable = basics.tag === "table" ? startsLayoutTable : inh.layoutTable;
  return {
    inLayoutTable,
    demotedByTable:
      startsLayoutTable || isTablePartInLayoutTable(basics.tag, explicitRole, inh.layoutTable),
  };
}

function isLayoutTableElement(node: DomNode, basics: ElementBasics, explicitRole: string): boolean {
  return basics.tag === "table" && !explicitRole && isLayoutTable(node, basics.attrs);
}

function isTablePartInLayoutTable(
  tag: string,
  explicitRole: string,
  inLayoutTable: boolean,
): boolean {
  return inLayoutTable && TABLE_PART_TAGS.has(tag) && !explicitRole;
}

function elementAxNode(frameId: string, info: ElementBuildInfo): AxNode {
  const reasons = elementIgnoredReasons(info);
  const ax: AxNode = {
    nodeId: info.axId,
    ignored: reasons.length > 0,
    backendDOMNodeId: info.backendId,
    frameId,
  };
  applyElementSemantics(ax, info, reasons);
  return ax;
}

function elementIgnoredReasons(info: ElementBuildInfo): NonNullable<AxNode["ignoredReasons"]> {
  if (info.hidden) {
    return [ignoreReason(hiddenElementReason(info))];
  }
  if (isPresentationalElement(info)) return [ignoreReason("presentationalRole")];
  if (info.tag === "html") return [ignoreReason("uninteresting")];
  return [];
}

function hiddenElementReason(info: ElementBuildInfo): string {
  return info.selfAriaHidden
    ? "ariaHiddenElement"
    : info.ariaHidden
      ? "ariaHiddenSubtree"
      : "notRendered";
}

function isPresentationalElement(info: ElementBuildInfo): boolean {
  return info.role === "presentation" || info.role === "none" || info.demotedByTable;
}

function applyElementSemantics(
  ax: AxNode,
  info: ElementBuildInfo,
  reasons: NonNullable<AxNode["ignoredReasons"]>,
): void {
  if (reasons.length > 0) {
    ax.ignoredReasons = reasons;
    ax.role = { type: "internalRole", value: "none" };
    return;
  }
  ax.role = { type: info.explicitRole ? "role" : "internalRole", value: info.role };
  applyExposedElementProperties(ax, info);
}

function applyExposedElementProperties(ax: AxNode, info: ElementBuildInfo): void {
  if (info.name) ax.name = { type: "computedString", value: info.name };
  if (info.description) ax.description = { type: "computedString", value: info.description };
  if (info.value !== undefined) ax.value = info.value;
  if (info.props.length > 0) ax.properties = info.props;
}

function elementChildIds(
  ctx: BuildCtx,
  node: DomNode,
  info: ElementBuildInfo,
  inh: Inherited,
): string[] {
  const childIds: string[] = [];
  const childInh = childInheritance(info, inh);
  appendShadowRootChildren(ctx, node.shadowRoots, info.axId, childInh, childIds);
  appendBuiltChildren(ctx, node.children ?? [], info.axId, childInh, childIds);
  appendContentDocument(ctx, node.contentDocument, info.axId, childInh, childIds);
  return childIds;
}

function childInheritance(info: ElementBuildInfo, inh: Inherited): Inherited {
  const listDepth = info.tag === "ul" || info.tag === "ol" ? inh.listDepth + 1 : inh.listDepth;
  return {
    ariaHidden: info.ariaHidden,
    hidden: info.subtreeHidden,
    textHidden: info.hidden,
    layoutTable: info.inLayoutTable,
    listDepth,
  };
}

function appendShadowRootChildren(
  ctx: BuildCtx,
  shadowRoots: DomNode[] | undefined,
  axId: string,
  inh: Inherited,
  childIds: string[],
): void {
  for (const shadowRoot of shadowRoots ?? []) {
    appendBuiltChildren(ctx, shadowRoot.children ?? [], axId, inh, childIds);
  }
}

function appendBuiltChildren(
  ctx: BuildCtx,
  children: DomNode[],
  axId: string,
  inh: Inherited,
  childIds: string[],
): void {
  for (const child of children) appendBuiltChild(ctx, child, axId, inh, childIds);
}

function appendBuiltChild(
  ctx: BuildCtx,
  child: DomNode,
  axId: string,
  inh: Inherited,
  childIds: string[],
): void {
  const built = ctx.build(child, axId, inh);
  if (built) childIds.push(built.nodeId);
}

function appendContentDocument(
  ctx: BuildCtx,
  contentDocument: DomNode | undefined,
  axId: string,
  inh: Inherited,
  childIds: string[],
): void {
  if (!contentDocument) return;
  appendBuiltChild(ctx, contentDocument, axId, inh, childIds);
}

function ignoreReason(name: string): { name: string; value: { type: string; value: unknown } } {
  return { name, value: { type: "boolean", value: true } };
}

const TABLE_PART_TAGS = new Set([
  "tr",
  "td",
  "th",
  "thead",
  "tbody",
  "tfoot",
  "caption",
  "colgroup",
  "col",
]);

function isLayoutTable(node: DomNode, attrs: Map<string, string>): boolean {
  if (attrs.has("summary")) return false;
  return !hasDataTableSignal(node, 0);
}

function hasDataTableSignal(node: DomNode, depth: number): boolean {
  if (depth > 4) return false;
  for (const child of nodeChildren(node)) {
    if (hasTableCellSignal(child) || hasRelevantTableDescendantSignal(child, depth + 1)) {
      return true;
    }
  }
  return false;
}

function nodeChildren(node: DomNode): DomNode[] {
  return node.children ?? [];
}

function hasTableCellSignal(node: DomNode): boolean {
  if (node.nodeType !== 1) return false;
  const tag = localTag(node);
  if (tag === "caption" || tag === "th") return true;
  return tag === "td" && hasTableHeaderAttributes(node);
}

function hasTableHeaderAttributes(node: DomNode): boolean {
  const attrs = attrMap(node.attributes);
  return attrs.has("scope") || attrs.has("headers") || attrs.has("abbr");
}

function hasRelevantTableDescendantSignal(node: DomNode, depth: number): boolean {
  return !isNestedTable(node) && hasDataTableSignal(node, depth);
}

function isNestedTable(node: DomNode): boolean {
  return node.nodeType === 1 && localTag(node) === "table";
}

function localTag(node: DomNode): string {
  return (node.localName || node.nodeName || "").toLowerCase();
}

function inlineDisplayNone(style: string | undefined): boolean {
  if (!style) return false;
  return lastDisplayValue(style) === "none";
}

function lastDisplayValue(style: string): string | undefined {
  let display: string | undefined;
  let important = false;
  for (const decl of style.split(";")) {
    const parsed = parseDisplayDeclaration(decl);
    if (!parsed) continue;
    if (important && !parsed.important) continue;
    display = parsed.value;
    important = parsed.important;
  }
  return display;
}

function parseDisplayDeclaration(
  declaration: string,
): { value: string; important: boolean } | null {
  const colon = declaration.indexOf(":");
  if (colon < 0 || declaration.slice(0, colon).trim().toLowerCase() !== "display") return null;
  const raw = declaration.slice(colon + 1);
  const important = /!\s*important\s*$/i.test(raw);
  const value = raw
    .replace(/!\s*important\s*$/i, "")
    .trim()
    .toLowerCase();
  return { value, important };
}

function attrMap(flat: string[] | undefined): Map<string, string> {
  const m = new Map<string, string>();
  if (!flat) return m;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    m.set(String(flat[i] ?? "").toLowerCase(), String(flat[i + 1] ?? ""));
  }
  return m;
}

function firstToken(v: string | undefined): string {
  if (!v) return "";
  const t = v.trim().split(/\s+/)[0];
  return t ?? "";
}

const SKIP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "meta",
  "link",
  "base",
  "head",
  "title",
]);

function implicitRole(tag: string, attrs: Map<string, string>): string {
  switch (tag) {
    case "a":
    case "area":
      return linkRole(attrs);
    case "article":
      return "article";
    case "aside":
      return "complementary";
    case "blockquote":
      return "blockquote";
    case "body":
      return "generic";
    case "button":
      return "button";
    case "caption":
      return "caption";
    case "code":
      return "code";
    case "datalist":
      return "listbox";
    case "del":
      return "deletion";
    case "details":
      return "group";
    case "dfn":
      return "term";
    case "dialog":
      return "dialog";
    case "dd":
      return "definition";
    case "dt":
      return "term";
    case "em":
      return "emphasis";
    case "fieldset":
      return "group";
    case "figure":
      return "figure";
    case "footer":
      return "contentinfo";
    case "form":
      return "form";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "heading";
    case "header":
      return "banner";
    case "hr":
      return "separator";
    case "html":
      return "document";
    case "iframe":
      return "Iframe";
    case "img":
      return imageRole(attrs);
    case "input":
      return inputRole(attrs);
    case "ins":
      return "insertion";
    case "label":
      return "";
    case "li":
      return "listitem";
    case "main":
      return "main";
    case "mark":
      return "mark";
    case "math":
      return "math";
    case "menu":
      return "list";
    case "meter":
      return "meter";
    case "nav":
      return "navigation";
    case "ol":
    case "ul":
      return "list";
    case "option":
      return "option";
    case "output":
      return "status";
    case "p":
      return "paragraph";
    case "progress":
      return "progressbar";
    case "search":
      return "search";
    case "section":
      return sectionRole(attrs);
    case "select":
      return selectRole(attrs);
    case "strong":
      return "strong";
    case "sub":
      return "subscript";
    case "summary":
      return "button";
    case "sup":
      return "superscript";
    case "svg":
      return "graphics-document";
    case "table":
      return "table";
    case "textarea":
      return "textbox";
    case "tbody":
    case "thead":
    case "tfoot":
      return "rowgroup";
    case "td":
      return "cell";
    case "th":
      return headerCellRole(attrs);
    case "time":
      return "time";
    case "tr":
      return "row";
    default:
      return "";
  }
}

function linkRole(attrs: Map<string, string>): string {
  return attrs.has("href") ? "link" : "generic";
}

function imageRole(attrs: Map<string, string>): string {
  return attrs.get("alt") === "" ? "presentation" : "image";
}

function inputRole(attrs: Map<string, string>): string {
  const type = (attrs.get("type") || "text").toLowerCase();
  switch (type) {
    case "button":
    case "submit":
    case "reset":
    case "image":
      return "button";
    case "checkbox":
      return "checkbox";
    case "radio":
      return "radio";
    case "range":
      return "slider";
    case "number":
      return "spinbutton";
    case "search":
      return "searchbox";
    case "email":
    case "tel":
    case "text":
    case "url":
      return "textbox";
    case "password":
    case "hidden":
    case "file":
    case "color":
    case "date":
    case "datetime-local":
    case "month":
    case "time":
    case "week":
      return "textbox";
    default:
      return "textbox";
  }
}

function sectionRole(attrs: Map<string, string>): string {
  return attrs.has("aria-label") || attrs.has("aria-labelledby") ? "region" : "generic";
}

function selectRole(attrs: Map<string, string>): string {
  return attrs.has("multiple") || Number(attrs.get("size") ?? "0") > 1 ? "listbox" : "combobox";
}

function headerCellRole(attrs: Map<string, string>): string {
  return attrs.get("scope") === "row" ? "rowheader" : "columnheader";
}

function computeName(
  node: DomNode,
  tag: string,
  attrs: Map<string, string>,
  ctx: BuildCtx,
): string {
  const ariaName = ariaNameFromAttributes(attrs, ctx);
  if (ariaName) return ariaName;
  const elementName = elementNameFromAttributes(node, tag, attrs, ctx);
  if (elementName !== undefined) return elementName;
  const containerName = containerNameFromChild(node, tag);
  if (containerName !== undefined) return containerName;
  const contentName = contentNameFromNode(node, tag, attrs);
  if (contentName !== undefined) return contentName;
  return titleName(attrs);
}

function ariaNameFromAttributes(attrs: Map<string, string>, ctx: BuildCtx): string {
  const labelledBy = attrs.get("aria-labelledby");
  if (labelledBy) {
    const joined = textFromAriaReferences(labelledBy, ctx);
    if (joined) return joined;
  }
  const ariaLabel = attrs.get("aria-label");
  return ariaLabel && ariaLabel.trim() ? ariaLabel.trim() : "";
}

function textFromAriaReferences(ids: string, ctx: BuildCtx): string {
  const parts: string[] = [];
  for (const id of ids.trim().split(/\s+/)) {
    const backend = ctx.idAttrToBackend.get(id);
    if (backend == null) continue;
    const found = findByBackend(ctx, backend);
    if (found) parts.push(textFromSubtree(found));
  }
  return parts.join(" ").trim();
}

function elementNameFromAttributes(
  node: DomNode,
  tag: string,
  attrs: Map<string, string>,
  ctx: BuildCtx,
): string | undefined {
  const alternative = alternativeName(node, tag, attrs);
  if (alternative !== undefined) return alternative;
  return controlName(node, tag, attrs, ctx);
}

function alternativeName(
  node: DomNode,
  tag: string,
  attrs: Map<string, string>,
): string | undefined {
  if (tag === "img" || tag === "area") {
    return nonEmptyAttribute(attrs, "alt");
  }
  return tag === "input" ? inputAlternativeName(attrs) : undefined;
}

function inputAlternativeName(attrs: Map<string, string>): string | undefined {
  const type = (attrs.get("type") || "text").toLowerCase();
  const buttonName = inputButtonName(type, attrs);
  if (buttonName !== undefined) return buttonName;
  if (type === "image") return nonEmptyAttribute(attrs, "alt");
  return undefined;
}

function inputButtonName(type: string, attrs: Map<string, string>): string | undefined {
  if (!isButtonInputType(type)) return undefined;
  const value = attrs.get("value");
  if (value) return value;
  if (type === "submit") return "Submit";
  return type === "reset" ? "Reset" : undefined;
}

function isButtonInputType(type: string): boolean {
  switch (type) {
    case "button":
    case "submit":
    case "reset":
      return true;
    default:
      return false;
  }
}

function nonEmptyAttribute(attrs: Map<string, string>, name: string): string | undefined {
  const value = attrs.get(name);
  return value ? value : undefined;
}

function controlName(
  node: DomNode,
  tag: string,
  attrs: Map<string, string>,
  ctx: BuildCtx,
): string | undefined {
  if (tag === "input") return inputControlName(node, attrs, ctx);
  if (tag !== "textarea" && tag !== "select") return undefined;
  return textareaOrSelectControlName(node, tag, attrs, ctx);
}

function inputControlName(
  node: DomNode,
  attrs: Map<string, string>,
  ctx: BuildCtx,
): string | undefined {
  const label = explicitLabelName(attrs, ctx);
  if (label !== undefined) return label;
  const wrapped = nonEmptyText(findWrappingLabel(ctx, node));
  if (wrapped !== undefined) return wrapped;
  return nonEmptyAttribute(attrs, "placeholder");
}

function textareaOrSelectControlName(
  node: DomNode,
  tag: string,
  attrs: Map<string, string>,
  ctx: BuildCtx,
): string | undefined {
  const label = explicitLabelName(attrs, ctx);
  if (label !== undefined) return label;
  const wrapped = nonEmptyText(findWrappingLabel(ctx, node));
  if (wrapped !== undefined) return wrapped;
  return tag === "textarea" ? nonEmptyAttribute(attrs, "placeholder") : undefined;
}

function explicitLabelName(attrs: Map<string, string>, ctx: BuildCtx): string | undefined {
  const id = attrs.get("id");
  if (!id) return undefined;
  return nonEmptyText(findLabelFor(ctx, id));
}

function nonEmptyText(text: string): string | undefined {
  return text ? text : undefined;
}

function containerNameFromChild(node: DomNode, tag: string): string | undefined {
  const childTag = containerNameChildTag(tag);
  return childTag ? directChildText(node, childTag) : undefined;
}

function containerNameChildTag(tag: string): string | undefined {
  switch (tag) {
    case "fieldset":
      return "legend";
    case "table":
      return "caption";
    case "figure":
      return "figcaption";
    case "svg":
      return "title";
    default:
      return undefined;
  }
}

function directChildText(node: DomNode, tag: string): string | undefined {
  for (const child of node.children ?? []) {
    if (localTag(child) === tag) return textFromSubtree(child);
  }
  return undefined;
}

function contentNameFromNode(
  node: DomNode,
  tag: string,
  attrs: Map<string, string>,
): string | undefined {
  if (NAME_FROM_CONTENTS.has(tag)) {
    const text = nonEmptyTrimmedText(node);
    if (text) return text;
  }
  const explicitRole = firstToken(attrs.get("role"));
  return roleContentName(node, explicitRole);
}

function nonEmptyTrimmedText(node: DomNode): string | undefined {
  const text = textFromSubtree(node).trim();
  return text ? text : undefined;
}

function roleContentName(node: DomNode, role: string): string | undefined {
  if (role && ROLE_NAME_FROM_CONTENTS.has(role)) return nonEmptyTrimmedText(node);
  return undefined;
}

function titleName(attrs: Map<string, string>): string {
  const title = attrs.get("title");
  return title && title.trim() ? title.trim() : "";
}

function computeDescription(attrs: Map<string, string>, ctx: BuildCtx): string {
  const describedBy = attrs.get("aria-describedby");
  if (describedBy) {
    const joined = textFromAriaReferences(describedBy, ctx);
    if (joined) return joined;
  }
  const ariaDesc = attrs.get("aria-description");
  return ariaDesc && ariaDesc.trim() ? ariaDesc.trim() : "";
}

function computeValue(
  node: DomNode,
  tag: string,
  attrs: Map<string, string>,
  ctx: BuildCtx,
): AxNode["value"] {
  const live = liveValueForNode(node, ctx);
  const inputValue = inputElementValue(tag, attrs, live);
  if (inputValue !== undefined) return inputValue;
  const selectValue = selectElementValue(node, tag, attrs, ctx);
  if (selectValue !== undefined) return selectValue;
  const editableValue = contentEditableValue(node, attrs);
  if (editableValue !== undefined) return editableValue;
  const textareaValue = textareaElementValue(node, tag, live);
  if (textareaValue !== undefined) return textareaValue;
  return ariaValue(attrs);
}

function liveValueForNode(node: DomNode, ctx: BuildCtx): string | undefined {
  const backendId = node.backendNodeId;
  return typeof backendId === "number" ? ctx.liveValues.get(backendId) : undefined;
}

function inputElementValue(
  tag: string,
  attrs: Map<string, string>,
  live: string | undefined,
): AxNode["value"] {
  if (tag !== "input") return undefined;
  const type = inputType(attrs);
  const value = liveInputValue(attrs, live);
  if (isNumericInputType(type)) return numericInputValue(value);
  return value != null ? { type: "string", value } : undefined;
}

function inputType(attrs: Map<string, string>): string {
  return (attrs.get("type") || "text").toLowerCase();
}

function liveInputValue(attrs: Map<string, string>, live: string | undefined): string | undefined {
  return live !== undefined ? live : attrs.get("value");
}

function isNumericInputType(type: string): boolean {
  return type === "range" || type === "number";
}

function numericInputValue(value: string | undefined): AxNode["value"] {
  if (value == null || value === "") return undefined;
  return { type: "number", value: Number(value) };
}

function selectElementValue(
  node: DomNode,
  tag: string,
  attrs: Map<string, string>,
  ctx: BuildCtx,
): AxNode["value"] {
  if (tag !== "select" || attrs.has("multiple")) return undefined;
  const label = selectedOptionLabel(node, ctx);
  return label !== undefined ? { type: "string", value: label } : undefined;
}

function contentEditableValue(node: DomNode, attrs: Map<string, string>): AxNode["value"] {
  const editable = attrs.get("contenteditable");
  if (editable !== undefined && editable.toLowerCase() !== "false") {
    return { type: "string", value: textFromSubtree(node) };
  }
  return undefined;
}

function textareaElementValue(
  node: DomNode,
  tag: string,
  live: string | undefined,
): AxNode["value"] {
  if (tag !== "textarea") return undefined;
  if (live !== undefined) return { type: "string", value: live };
  const text = textFromSubtree(node);
  return text ? { type: "string", value: text } : undefined;
}

function ariaValue(attrs: Map<string, string>): AxNode["value"] {
  const ariaVal = attrs.get("aria-valuenow");
  if (ariaVal != null) {
    const number = Number(ariaVal);
    if (Number.isFinite(number)) return { type: "number", value: number };
  }
  const ariaValText = attrs.get("aria-valuetext");
  if (ariaValText) return { type: "string", value: ariaValText };
  return undefined;
}

function optionsOf(select: DomNode): DomNode[] {
  const out: DomNode[] = [];
  appendOptions(nodeChildren(select), out);
  return out;
}

function appendOptions(children: DomNode[], out: DomNode[]): void {
  for (const child of children) {
    const tag = localTag(child);
    if (tag === "option") out.push(child);
    else if (tag === "optgroup") appendOptgroupOptions(child, out);
  }
}

function appendOptgroupOptions(group: DomNode, out: DomNode[]): void {
  for (const option of nodeChildren(group)) {
    if (localTag(option) === "option") out.push(option);
  }
}

function selectedOptionLabel(select: DomNode, ctx: BuildCtx): string | undefined {
  const opts = optionsOf(select);
  const liveOf = (o: DomNode) =>
    typeof o.backendNodeId === "number" ? ctx.liveSelected.get(o.backendNodeId) : undefined;
  const haveLive = opts.some((o) => liveOf(o) !== undefined);
  const chosen = haveLive ? opts.find((o) => liveOf(o) === true) : markupSelected(select, opts);
  if (!chosen) return undefined;
  return attrMap(chosen.attributes).get("label") || textFromSubtree(chosen);
}

function markupSelected(select: DomNode, opts: DomNode[]): DomNode | undefined {
  const marked = lastMarkedOption(opts);
  if (marked) return marked;
  if (hasLargeSelectSize(select)) return undefined;
  return firstEnabledMarkupOption(select);
}

function lastMarkedOption(options: DomNode[]): DomNode | undefined {
  const marked = options.filter((option) => attrMap(option.attributes).has("selected"));
  if (marked.length > 0) return marked[marked.length - 1];
  return undefined;
}

function hasLargeSelectSize(select: DomNode): boolean {
  const size = Number.parseInt(attrMap(select.attributes).get("size") ?? "", 10);
  return size > 1;
}

function firstEnabledMarkupOption(select: DomNode): DomNode | undefined {
  for (const child of nodeChildren(select)) {
    if (attrMap(child.attributes).has("disabled")) continue;
    if (localTag(child) === "option") return child;
    const option = firstEnabledOptionInGroup(child);
    if (option) return option;
  }
  return undefined;
}

function firstEnabledOptionInGroup(group: DomNode): DomNode | undefined {
  if (localTag(group) !== "optgroup") return undefined;
  return nodeChildren(group).find(
    (option) => localTag(option) === "option" && !attrMap(option.attributes).has("disabled"),
  );
}

function computeProperties(
  tag: string,
  attrs: Map<string, string>,
  node: DomNode,
  ctx: BuildCtx,
  role: string,
  listDepth: number,
): NonNullable<AxNode["properties"]> {
  const out: NonNullable<AxNode["properties"]> = [];
  const push: PushAxProperty = (name, type, value) => appendAxProperty(out, name, type, value);
  addHeadingLevel(tag, push);
  addAriaLevel(attrs, push);
  addListItemLevel(role, attrs, listDepth, push);
  addResourceUrl(tag, attrs, ctx, role, push);
  addFocusableProperty(tag, attrs, push);
  addAccessKeyProperty(attrs, push);
  addAriaBooleanProperties(attrs, push);
  addAriaTristateProperties(attrs, push);
  addNativeFormProperties(tag, attrs, push);
  addInputCheckedProperty(tag, attrs, node, ctx, push);
  addOptionSelectedProperty(tag, attrs, node, ctx, push);
  addDetailsExpandedProperty(tag, attrs, push);
  addHasPopupProperty(attrs, push);
  addAriaStringProperties(attrs, push);
  addAriaNumberProperties(attrs, push);
  addInputRangeProperties(tag, attrs, push);
  return out;
}

type PushAxProperty = (name: string, type: string, value: unknown) => void;

function appendAxProperty(
  out: NonNullable<AxNode["properties"]>,
  name: string,
  type: string,
  value: unknown,
): void {
  out.push({ name, value: { type, value } });
}

function addHeadingLevel(tag: string, push: PushAxProperty): void {
  if (/^h[1-6]$/.test(tag)) push("level", "integer", Number(tag.slice(1)));
}

function addAriaLevel(attrs: Map<string, string>, push: PushAxProperty): void {
  const ariaLevel = attrs.get("aria-level");
  if (ariaLevel == null) return;
  const level = Number(ariaLevel);
  if (Number.isFinite(level)) push("level", "integer", level);
}

function addListItemLevel(
  role: string,
  attrs: Map<string, string>,
  listDepth: number,
  push: PushAxProperty,
): void {
  if (role === "listitem" && attrs.get("aria-level") == null && listDepth > 0) {
    push("level", "integer", listDepth);
  }
}

function addResourceUrl(
  tag: string,
  attrs: Map<string, string>,
  ctx: BuildCtx,
  role: string,
  push: PushAxProperty,
): void {
  if (role === "link") addLinkUrl(attrs, ctx, push);
  else if (tag === "img") addImageUrl(attrs, ctx, push);
}

function addLinkUrl(attrs: Map<string, string>, ctx: BuildCtx, push: PushAxProperty): void {
  const href = attrs.get("href");
  if (href != null) push("url", "string", absUrl(href, ctx.baseUrl) || href);
}

function addImageUrl(attrs: Map<string, string>, ctx: BuildCtx, push: PushAxProperty): void {
  const src = attrs.get("src");
  if (src != null) push("url", "string", absUrl(src, ctx.baseUrl) || src);
}

function addFocusableProperty(tag: string, attrs: Map<string, string>, push: PushAxProperty): void {
  if (isFocusable(tag, attrs)) push("focusable", "booleanOrUndefined", true);
}

function addAccessKeyProperty(attrs: Map<string, string>, push: PushAxProperty): void {
  const accessKey = attrs.get("accesskey");
  if (accessKey && !attrs.get("aria-keyshortcuts")) {
    push("keyshortcuts", "string", `Ctrl+Alt+${accessKey}`);
  }
}

const ARIA_BOOLEAN_PROPERTIES: Array<[string, string]> = [
  ["expanded", "aria-expanded"],
  ["disabled", "aria-disabled"],
  ["required", "aria-required"],
  ["readonly", "aria-readonly"],
  ["selected", "aria-selected"],
  ["modal", "aria-modal"],
  ["multiline", "aria-multiline"],
  ["multiselectable", "aria-multiselectable"],
  ["atomic", "aria-atomic"],
  ["busy", "aria-busy"],
];

function addAriaBooleanProperties(attrs: Map<string, string>, push: PushAxProperty): void {
  for (const [name, aria] of ARIA_BOOLEAN_PROPERTIES) {
    addAriaBooleanProperty(name, aria, attrs, push);
  }
}

function addAriaBooleanProperty(
  name: string,
  aria: string,
  attrs: Map<string, string>,
  push: PushAxProperty,
): void {
  const value = attrs.get(aria);
  if (value === "true") push(name, "boolean", true);
  else if (value === "false") push(name, "boolean", false);
}

function addAriaTristateProperties(attrs: Map<string, string>, push: PushAxProperty): void {
  addAriaTristateProperty("checked", "aria-checked", attrs, push);
  addAriaTristateProperty("pressed", "aria-pressed", attrs, push);
}

function addAriaTristateProperty(
  name: string,
  aria: string,
  attrs: Map<string, string>,
  push: PushAxProperty,
): void {
  const value = attrs.get(aria);
  if (value === "true" || value === "false" || value === "mixed") {
    push(name, "tristate", value);
  }
}

function addNativeFormProperties(
  tag: string,
  attrs: Map<string, string>,
  push: PushAxProperty,
): void {
  if (!hasNativeFormProperties(tag)) return;
  addNativeFormProperty("disabled", attrs, push);
  addNativeFormProperty("required", attrs, push);
  addNativeFormProperty("readonly", attrs, push);
}

function hasNativeFormProperties(tag: string): boolean {
  switch (tag) {
    case "input":
    case "textarea":
    case "select":
    case "button":
      return true;
    default:
      return false;
  }
}

function addNativeFormProperty(
  name: string,
  attrs: Map<string, string>,
  push: PushAxProperty,
): void {
  if (attrs.has(name)) push(name, "boolean", true);
}

function addInputCheckedProperty(
  tag: string,
  attrs: Map<string, string>,
  node: DomNode,
  ctx: BuildCtx,
  push: PushAxProperty,
): void {
  if (tag !== "input" || !isCheckableInput(attrs)) return;
  const checked = inputCheckedState(attrs, node, ctx);
  push("checked", "tristate", checked ? "true" : "false");
}

function isCheckableInput(attrs: Map<string, string>): boolean {
  const type = (attrs.get("type") || "text").toLowerCase();
  return type === "checkbox" || type === "radio";
}

function inputCheckedState(attrs: Map<string, string>, node: DomNode, ctx: BuildCtx): boolean {
  const backendId = node.backendNodeId;
  const liveOn = typeof backendId === "number" ? ctx.liveChecked.get(backendId) : undefined;
  return liveOn !== undefined ? liveOn : attrs.has("checked");
}

function addOptionSelectedProperty(
  tag: string,
  attrs: Map<string, string>,
  node: DomNode,
  ctx: BuildCtx,
  push: PushAxProperty,
): void {
  if (tag !== "option") return;
  const backendId = node.backendNodeId;
  const live = typeof backendId === "number" ? ctx.liveSelected.get(backendId) : undefined;
  if (live ?? attrs.has("selected")) push("selected", "boolean", true);
}

function addDetailsExpandedProperty(
  tag: string,
  attrs: Map<string, string>,
  push: PushAxProperty,
): void {
  if (tag === "details" && attrs.has("open")) push("expanded", "boolean", true);
}

function addHasPopupProperty(attrs: Map<string, string>, push: PushAxProperty): void {
  const value = attrs.get("aria-haspopup");
  if (value && value !== "false") {
    push("hasPopup", "token", value === "true" ? "menu" : value);
  }
}

const ARIA_STRING_PROPERTIES: Array<[string, string]> = [
  ["keyshortcuts", "aria-keyshortcuts"],
  ["roledescription", "aria-roledescription"],
  ["autocomplete", "aria-autocomplete"],
  ["orientation", "aria-orientation"],
  ["live", "aria-live"],
  ["relevant", "aria-relevant"],
  ["placeholder", "aria-placeholder"],
  ["valuetext", "aria-valuetext"],
];

function addAriaStringProperties(attrs: Map<string, string>, push: PushAxProperty): void {
  for (const [name, aria] of ARIA_STRING_PROPERTIES) {
    const value = attrs.get(aria);
    if (value) push(name, "string", value);
  }
}

const ARIA_NUMBER_PROPERTIES: Array<[string, string]> = [
  ["valuemin", "aria-valuemin"],
  ["valuemax", "aria-valuemax"],
  ["valuenow", "aria-valuenow"],
  ["setsize", "aria-setsize"],
  ["posinset", "aria-posinset"],
  ["colcount", "aria-colcount"],
  ["rowcount", "aria-rowcount"],
  ["colindex", "aria-colindex"],
  ["rowindex", "aria-rowindex"],
  ["colspan", "aria-colspan"],
  ["rowspan", "aria-rowspan"],
];

function addAriaNumberProperties(attrs: Map<string, string>, push: PushAxProperty): void {
  for (const [name, aria] of ARIA_NUMBER_PROPERTIES) {
    addAriaNumberProperty(name, aria, attrs, push);
  }
}

function addAriaNumberProperty(
  name: string,
  aria: string,
  attrs: Map<string, string>,
  push: PushAxProperty,
): void {
  const value = attrs.get(aria);
  if (value == null) return;
  const number = Number(value);
  if (Number.isFinite(number)) push(name, "integer", number);
}

function addInputRangeProperties(
  tag: string,
  attrs: Map<string, string>,
  push: PushAxProperty,
): void {
  if (!isRangeNumberInput(tag, attrs)) return;
  addFiniteInputNumbers(attrs, push);
}

function isRangeNumberInput(tag: string, attrs: Map<string, string>): boolean {
  if (tag !== "input") return false;
  const type = (attrs.get("type") || "text").toLowerCase();
  return type === "range" || type === "number";
}

const INPUT_RANGE_PROPERTIES: Array<[string, string]> = [
  ["valuemin", "min"],
  ["valuemax", "max"],
  ["valuenow", "value"],
];

function addFiniteInputNumbers(attrs: Map<string, string>, push: PushAxProperty): void {
  for (const [name, attr] of INPUT_RANGE_PROPERTIES) {
    const value = attrs.get(attr);
    if (value != null && Number.isFinite(Number(value))) {
      push(name, "number", Number(value));
    }
  }
}

const NAME_FROM_CONTENTS = new Set([
  "a",
  "button",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "summary",
  "th",
  "td",
  "option",
  "figcaption",
  "label",
  "legend",
]);
const ROLE_NAME_FROM_CONTENTS = new Set([
  "button",
  "cell",
  "checkbox",
  "columnheader",
  "gridcell",
  "heading",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "row",
  "rowheader",
  "switch",
  "tab",
  "tooltip",
  "treeitem",
]);

function textFromSubtree(node: DomNode, excludeBackendId?: number): string {
  const parts: string[] = [];
  appendSubtreeTextChildren(nodeChildren(node), excludeBackendId, parts);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function appendSubtreeTextChildren(
  children: DomNode[],
  excludeBackendId: number | undefined,
  parts: string[],
): void {
  for (const child of children) appendSubtreeText(child, excludeBackendId, parts);
}

function appendSubtreeText(
  node: DomNode,
  excludeBackendId: number | undefined,
  parts: string[],
): void {
  if (isExcludedTextNode(node, excludeBackendId)) return;
  if (node.nodeType === 3) {
    appendTextNode(node, parts);
    return;
  }
  if (node.nodeType !== 1) return;
  appendElementText(node, excludeBackendId, parts);
}

function isExcludedTextNode(node: DomNode, excludeBackendId: number | undefined): boolean {
  return excludeBackendId != null && node.backendNodeId === excludeBackendId;
}

function appendTextNode(node: DomNode, parts: string[]): void {
  if (node.nodeValue) parts.push(node.nodeValue);
}

function appendElementText(
  node: DomNode,
  excludeBackendId: number | undefined,
  parts: string[],
): void {
  const tag = localTag(node);
  if (SKIP_TAGS.has(tag)) return;
  const attrs = attrMap(node.attributes);
  if (isAriaHidden(attrs)) return;
  if (appendAccessibleLabel(attrs, parts)) return;
  if (tag === "img") {
    appendImageAlt(attrs, parts);
    return;
  }
  appendSubtreeTextChildren(nodeChildren(node), excludeBackendId, parts);
}

function isAriaHidden(attrs: Map<string, string>): boolean {
  return attrs.get("aria-hidden") === "true";
}

function appendAccessibleLabel(attrs: Map<string, string>, parts: string[]): boolean {
  const label = attrs.get("aria-label");
  if (label && label.trim()) {
    parts.push(label.trim());
    return true;
  }
  return false;
}

function appendImageAlt(attrs: Map<string, string>, parts: string[]): void {
  const alt = attrs.get("alt");
  if (alt) parts.push(alt);
}

function findByBackend(ctx: BuildCtx, backendId: number): DomNode | null {
  return ctx.backendToNode.get(backendId) ?? null;
}

function findLabelFor(ctx: BuildCtx, forId: string): string {
  const label = ctx.labelForId.get(forId);
  return label ? textFromSubtree(label) : "";
}

function absUrl(href: string, base: string): string {
  try {
    return new URL(href, base || undefined).toString();
  } catch {
    return "";
  }
}

function isFocusable(tag: string, attrs: Map<string, string>): boolean {
  if (attrs.has("disabled")) return false;
  if (hasExplicitFocusability(attrs)) return true;
  return isFocusableByTag(tag, attrs);
}

function hasExplicitFocusability(attrs: Map<string, string>): boolean {
  if (attrs.has("tabindex")) return true;
  const ce = attrs.get("contenteditable");
  if (ce != null && ce !== "false") return true;
  return false;
}

function isFocusableByTag(tag: string, attrs: Map<string, string>): boolean {
  switch (tag) {
    case "a":
    case "area":
      return attrs.has("href");
    case "button":
    case "input":
    case "select":
    case "textarea":
    case "summary":
    case "iframe":
      return true;
    case "audio":
    case "video":
      return attrs.has("controls");
    default:
      return false;
  }
}

function findWrappingLabel(ctx: BuildCtx, node: DomNode): string {
  const selfId = node.backendNodeId;
  if (typeof selfId !== "number") return "";
  return findWrappingLabelById(ctx, selfId);
}

type WrappingLabelStep = { label: string } | { stop: true } | { next: DomNode | undefined };

function findWrappingLabelById(ctx: BuildCtx, selfId: number): string {
  let current = ctx.parentOf.get(selfId);
  for (let depth = 0; current && depth < 8; depth++) {
    const step = wrappingLabelStep(ctx, current, selfId);
    if ("label" in step) return step.label;
    if ("stop" in step) return "";
    current = step.next;
  }
  return "";
}

function wrappingLabelStep(ctx: BuildCtx, current: DomNode, selfId: number): WrappingLabelStep {
  if (localTag(current) === "label") {
    return { label: textFromSubtree(current, selfId) };
  }
  const parentId = current.backendNodeId;
  if (typeof parentId !== "number") return { stop: true };
  return { next: ctx.parentOf.get(parentId) };
}

function collectSubtree(tree: BuiltTree, rootId: string, out: Map<string, AxNode>): void {
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (id === undefined) continue;
    collectTreeNode(tree, id, out, stack);
  }
}

function collectTreeNode(
  tree: BuiltTree,
  id: string,
  out: Map<string, AxNode>,
  stack: string[],
): void {
  if (out.has(id)) return;
  const node = tree.byId.get(id);
  if (!node) return;
  out.set(id, node);
  appendChildIdsToStack(node, stack);
}

function appendChildIdsToStack(node: AxNode, stack: string[]): void {
  for (const childId of node.childIds ?? []) stack.push(childId);
}

function collectAncestors(tree: BuiltTree, startId: string, out: Map<string, AxNode>): void {
  let cur = tree.byId.get(startId)?.parentId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const n = tree.byId.get(cur);
    if (!n) break;
    out.set(cur, n);
    cur = n.parentId;
  }
}

void ({} as Protocol.Accessibility.AXNode | undefined);
