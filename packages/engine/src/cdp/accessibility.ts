// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Builds partial accessibility trees and handles CDP Accessibility commands.

import type { Protocol } from "devtools-protocol";

import type { CdpRequest, TargetState } from "./types.ts";
import type { DispatchCtx } from "./dispatch.ts";
import { sessionOf, type SessionSoftOps } from "./page-session.ts";
import type { ReadStamp } from "@kitesurf/jsrpc-types/query-dom";
import { ensureTargetDom } from "./dom-release.ts";

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
      const tree = await buildTree(ps, target);
      const root = tree?.nodes[0];
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

    case "Accessibility.getFullAXTree": {
      const tree = await buildTree(ps, target);
      return { nodes: tree ? tree.nodes : [] };
    }

    case "Accessibility.getRootAXNode": {
      const tree = await buildTree(ps, target);
      if (!tree) throw new Error("No document loaded");
      const root = tree.nodes[0];
      if (!root) throw new Error("Empty accessibility tree");
      return { node: root };
    }

    case "Accessibility.getPartialAXTree": {
      const tree = await buildTree(ps, target);
      if (!tree) return { nodes: [] };
      const id = pickBackendId(req.params, tree);
      if (id == null) return { nodes: [] };
      const wantAncestors = req.params?.fetchRelatives !== false;
      const collected = new Map<string, AxNode>();
      collectSubtree(tree, String(id), collected);
      if (wantAncestors) collectAncestors(tree, String(id), collected);
      return { nodes: Array.from(collected.values()) };
    }

    case "Accessibility.getChildAXNodes": {
      const tree = await buildTree(ps, target);
      if (!tree) return { nodes: [] };
      const id = String(req.params?.id ?? "");
      const parent = tree.byId.get(id);
      if (!parent) return { nodes: [] };
      const nodes: AxNode[] = [];
      for (const cid of parent.childIds ?? []) {
        const n = tree.byId.get(cid);
        if (n) nodes.push(n);
      }
      return { nodes };
    }

    case "Accessibility.getAXNodeAndAncestors": {
      const tree = await buildTree(ps, target);
      if (!tree) return { nodes: [] };
      const id = pickBackendId(req.params, tree);
      if (id == null) return { nodes: [] };
      const chain: AxNode[] = [];
      let cur: string | undefined = String(id);
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const n = tree.byId.get(cur);
        if (!n) break;
        chain.push(n);
        cur = n.parentId;
      }
      return { nodes: chain };
    }

    case "Accessibility.queryAXTree": {
      const tree = await buildTree(ps, target);
      if (!tree) return { nodes: [] };
      const params = req.params ?? {};
      const rootId = pickExplicitBackendId(params);
      const wantName =
        typeof params.accessibleName === "string" ? params.accessibleName : undefined;
      const wantRole = typeof params.role === "string" ? params.role : undefined;
      const subtree = new Map<string, AxNode>();
      if (rootId == null) {
        for (const n of tree.nodes) subtree.set(n.nodeId, n);
      } else {
        collectSubtree(tree, String(rootId), subtree);
      }
      const matches: AxNode[] = [];
      for (const n of subtree.values()) {
        if (n.ignored) continue;
        if (wantRole && (n.role?.value ?? "") !== wantRole) continue;
        if (wantName != null && (n.name?.value ?? "") !== wantName) continue;
        matches.push(n);
      }
      return { nodes: matches };
    }

    default:
      // Accept unsupported Accessibility methods without a protocol error.
      return {};
  }
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

function pickBackendId(params: unknown, tree: BuiltTree): number | null {
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
  return tree.nodes[0]?.backendDOMNodeId ?? null;
}

function pickExplicitBackendId(params: unknown): number | null {
  const p = (params ?? {}) as {
    nodeId?: number;
    backendNodeId?: number;
    objectId?: string;
  };
  if (typeof p.backendNodeId === "number" && p.backendNodeId > 0) return p.backendNodeId;
  if (typeof p.nodeId === "number" && p.nodeId > 0) return p.nodeId;
  if (typeof p.objectId === "string") {
    const m = /^(?:node|ps):(?:[^:]+:)?(\d+)$/.exec(p.objectId);
    if (m) return Number(m[1]);
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
  let displayNone = new Set<number>();
  let invisible = new Set<number>();
  let liveValues = new Map<number, string>();
  let liveChecked = new Map<number, boolean>();
  let liveSelected = new Map<number, boolean>();
  const stamps: AccessibilityReadState["stamps"] = {};
  if (ps) {
    const read = <T>(phase: string, run: () => Promise<T>): Promise<T> =>
      options.measureRead ? options.measureRead(phase, run) : run();
    const args = options.includeReadState ? { includeReadStamp: true } : {};
    const [docRes, hiddenRes, formRes] = await Promise.all([
      read("axtree.dom", () => ps.tryCall.getDocument(args)),
      read("axtree.visibility", () => ps.tryCall.notRenderedNodeIds(args)),
      read("axtree.forms", () => ps.tryCall.formStateSnapshot(args)),
    ]);
    stamps.document = docRes?.readStamp;
    stamps.visibility = hiddenRes?.readStamp;
    stamps.forms = formRes?.readStamp;
    root = (docRes?.root as DomNode | undefined) ?? null;
    if (Array.isArray(hiddenRes?.displayNone)) {
      displayNone = new Set(hiddenRes.displayNone);
    }
    if (Array.isArray(hiddenRes?.invisible)) {
      invisible = new Set(hiddenRes.invisible);
    }
    if (Array.isArray(formRes?.values)) liveValues = new Map(formRes.values);
    if (Array.isArray(formRes?.checked)) {
      liveChecked = new Map(formRes.checked);
    }
    if (Array.isArray(formRes?.selected)) liveSelected = new Map(formRes.selected);
  }
  const usedFallback = !root;
  const fallbackDom = root || options.fallback === false ? null : ensureTargetDom(target);
  if (!root && fallbackDom) {
    try {
      root = fallbackDom.getDocument() as DomNode;
    } catch {
      root = null;
    }
  }
  if (!root) return null;

  const ctx = new BuildCtx(target.frameId, displayNone, invisible);
  ctx.root = root;
  ctx.baseUrl = target.url || "";
  ctx.liveValues = liveValues;
  ctx.liveChecked = liveChecked;
  ctx.liveSelected = liveSelected;
  ctx.indexIds(root);
  const rootAx = ctx.build(root, null, {
    ariaHidden: false,
    hidden: false,
    textHidden: false,
    layoutTable: false,
    listDepth: 0,
  });
  const rootWeb: AxNode = {
    nodeId: `root-${target.frameId}`,
    ignored: false,
    role: { type: "internalRole", value: "RootWebArea" },
    chromeRole: { type: "internalRole", value: 144 },
    name: { type: "computedString", value: target.title || "" },
    value: { type: "string", value: target.url || "" },
    backendDOMNodeId: root.backendNodeId ?? 0,
    frameId: target.frameId,
    childIds: rootAx ? [rootAx.nodeId] : [],
    properties: [
      { name: "url", value: { type: "string", value: target.url || "" } },
      { name: "focusable", value: { type: "booleanOrUndefined", value: true } },
    ],
  };
  if (rootAx) rootAx.parentId = rootWeb.nodeId;
  ctx.byId.set(rootWeb.nodeId, rootWeb);
  ctx.nodes.unshift(rootWeb);
  const readState = options.includeReadState
    ? {
        stamps,
        forms: { values: liveValues, checked: liveChecked, selected: liveSelected },
        fallback: usedFallback,
      }
    : undefined;
  return { nodes: ctx.nodes, byId: ctx.byId, root, ...(readState ? { readState } : {}) };
}

interface Inherited {
  ariaHidden: boolean;
  hidden: boolean;
  textHidden: boolean;
  layoutTable: boolean;
  listDepth: number;
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
    if (typeof node.backendNodeId === "number") {
      this.backendToNode.set(node.backendNodeId, node);
    }
    if (node.nodeType === 1) {
      const attrs = attrMap(node.attributes);
      const id = attrs.get("id");
      if (id && typeof node.backendNodeId === "number") {
        this.idAttrToBackend.set(id, node.backendNodeId);
      }
      const tagName = (node.localName || node.nodeName || "").toLowerCase();
      if (tagName === "label") {
        const forId = attrs.get("for");
        if (forId && !this.labelForId.has(forId)) this.labelForId.set(forId, node);
      }
      if (tagName === "base") {
        const href = attrs.get("href");
        if (href && !this.sawBase) {
          this.sawBase = true;
          this.baseUrl = absUrl(href, this.baseUrl) || this.baseUrl;
        }
      }
    }
    for (const c of node.children ?? []) {
      if (typeof c.backendNodeId === "number") this.parentOf.set(c.backendNodeId, node);
    }
    for (const c of node.children ?? []) this.indexIds(c);
    for (const c of node.shadowRoots ?? []) this.indexIds(c);
    if (node.contentDocument) this.indexIds(node.contentDocument);
  }

  build(node: DomNode, parentAxId: string | null, inh: Inherited): AxNode | null {
    if (node.nodeType === 3) {
      const text = (node.nodeValue ?? "").replace(/\s+/g, " ").trim();
      if (!text) return null;
      const textHidden = inh.hidden || inh.textHidden;
      const tid = node.backendNodeId ?? node.nodeId ?? 0;
      const tax: AxNode = {
        nodeId: String(tid),
        ignored: textHidden,
        backendDOMNodeId: tid,
        frameId: this.frameId,
      };
      if (textHidden) {
        tax.ignoredReasons = [ignoreReason(inh.ariaHidden ? "ariaHiddenSubtree" : "notRendered")];
        tax.role = { type: "internalRole", value: "none" };
      } else {
        tax.role = { type: "internalRole", value: "StaticText" };
        tax.name = { type: "computedString", value: text };
      }
      if (parentAxId) tax.parentId = parentAxId;
      this.nodes.push(tax);
      this.byId.set(tax.nodeId, tax);
      return tax;
    }
    if (node.nodeType !== 1 && node.nodeType !== 9) return null;

    if (node.nodeType === 9) {
      let firstChild: AxNode | null = null;
      for (const c of node.children ?? []) {
        const built = this.build(c, parentAxId, inh);
        if (built && !firstChild) firstChild = built;
      }
      return firstChild;
    }

    const tag = (node.localName || node.nodeName || "").toLowerCase();
    if (SKIP_TAGS.has(tag)) return null;

    const attrs = attrMap(node.attributes);
    const backendId = node.backendNodeId ?? node.nodeId ?? 0;
    const axId = String(backendId);

    const selfAriaHidden = attrs.get("aria-hidden") === "true";
    const ariaHidden = inh.ariaHidden || selfAriaHidden;
    const uaHiddenOption =
      tag === "option" && this.inSelect(backendId) && !inlineDisplayNone(attrs.get("style"));
    // UA-hidden inputs can be absent from the layout walk's computed display.
    const hiddenInput = tag === "input" && attrs.get("type")?.trim().toLowerCase() === "hidden";
    const boxless = (this.displayNone.has(backendId) && !uaHiddenOption) || hiddenInput;
    const noBox = boxless || attrs.has("hidden");
    const subtreeHidden = inh.hidden || ariaHidden || noBox;
    const hidden = subtreeHidden || this.invisible.has(backendId);

    const explicitRole = firstToken(attrs.get("role"));
    const mapped = explicitRole || implicitRole(tag, attrs);
    const role = mapped || "generic";

    const name = computeName(node, tag, attrs, this);
    const description = computeDescription(attrs, this);
    const value = computeValue(node, tag, attrs, this);
    const props = computeProperties(tag, attrs, node, this, role, inh.listDepth);

    const isTable = tag === "table" && !explicitRole;
    const startsLayoutTable = isTable && isLayoutTable(node, attrs);
    const inLayoutTable = tag === "table" ? startsLayoutTable : inh.layoutTable;
    const demotedByTable =
      startsLayoutTable || (inh.layoutTable && TABLE_PART_TAGS.has(tag) && !explicitRole);

    const reasons: NonNullable<AxNode["ignoredReasons"]> = [];
    if (hidden) {
      if (selfAriaHidden) reasons.push(ignoreReason("ariaHiddenElement"));
      else if (ariaHidden) reasons.push(ignoreReason("ariaHiddenSubtree"));
      else reasons.push(ignoreReason("notRendered"));
    } else if (role === "presentation" || role === "none" || demotedByTable) {
      reasons.push(ignoreReason("presentationalRole"));
    } else if (tag === "html") {
      reasons.push(ignoreReason("uninteresting"));
    }
    const ignored = reasons.length > 0;

    const ax: AxNode = {
      nodeId: axId,
      ignored,
      backendDOMNodeId: backendId,
      frameId: this.frameId,
    };
    if (ignored) {
      ax.ignoredReasons = reasons;
      ax.role = { type: "internalRole", value: "none" };
    } else {
      ax.role = { type: explicitRole ? "role" : "internalRole", value: role };
      if (name) ax.name = { type: "computedString", value: name };
      if (description) ax.description = { type: "computedString", value: description };
      if (value !== undefined) ax.value = value;
      if (props.length > 0) ax.properties = props;
    }
    if (parentAxId) ax.parentId = parentAxId;

    this.nodes.push(ax);
    this.byId.set(axId, ax);

    if (noBox) return ax;

    const childInh: Inherited = {
      ariaHidden,
      hidden: subtreeHidden,
      textHidden: hidden,
      layoutTable: inLayoutTable,
      listDepth: tag === "ul" || tag === "ol" ? inh.listDepth + 1 : inh.listDepth,
    };
    const childIds: string[] = [];
    for (const sr of node.shadowRoots ?? []) {
      for (const c of sr.children ?? []) {
        const built = this.build(c, axId, childInh);
        if (built) childIds.push(built.nodeId);
      }
    }
    for (const c of node.children ?? []) {
      const built = this.build(c, axId, childInh);
      if (built) childIds.push(built.nodeId);
    }
    if (node.contentDocument) {
      const inner = this.build(node.contentDocument, axId, childInh);
      if (inner) childIds.push(inner.nodeId);
    }
    if (childIds.length > 0) ax.childIds = childIds;
    return ax;
  }
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
  let dataSignals = 0;
  const walk = (n: DomNode, depth: number): void => {
    if (dataSignals > 0 || depth > 4) return;
    for (const c of n.children ?? []) {
      if (c.nodeType !== 1) continue;
      const t = (c.localName || c.nodeName || "").toLowerCase();
      if (t === "caption") {
        dataSignals++;
        return;
      }
      if (t === "th") {
        dataSignals++;
        return;
      }
      if (t === "td") {
        const ca = attrMap(c.attributes);
        if (ca.has("scope") || ca.has("headers") || ca.has("abbr")) {
          dataSignals++;
          return;
        }
      }
      if (t === "table") continue;
      walk(c, depth + 1);
      if (dataSignals > 0) return;
    }
  };
  walk(node, 0);
  return dataSignals === 0;
}

function localTag(node: DomNode): string {
  return (node.localName || node.nodeName || "").toLowerCase();
}

function inlineDisplayNone(style: string | undefined): boolean {
  if (!style) return false;
  let display: string | undefined;
  let important = false;
  for (const decl of style.split(";")) {
    const colon = decl.indexOf(":");
    if (colon < 0 || decl.slice(0, colon).trim().toLowerCase() !== "display") continue;
    const raw = decl.slice(colon + 1);
    const isImportant = /!\s*important\s*$/i.test(raw);
    if (important && !isImportant) continue;
    display = raw
      .replace(/!\s*important\s*$/i, "")
      .trim()
      .toLowerCase();
    important = isImportant;
  }
  return display === "none";
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
      return attrs.has("href") ? "link" : "generic";
    case "area":
      return attrs.has("href") ? "link" : "generic";
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
    case "img": {
      const alt = attrs.get("alt");
      if (alt === "") return "presentation";
      return "image";
    }
    case "input": {
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
      return attrs.has("aria-label") || attrs.has("aria-labelledby") ? "region" : "generic";
    case "select":
      return attrs.has("multiple") || Number(attrs.get("size") ?? "0") > 1 ? "listbox" : "combobox";
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
      return attrs.get("scope") === "row" ? "rowheader" : "columnheader";
    case "time":
      return "time";
    case "tr":
      return "row";
    default:
      return "";
  }
}

function computeName(
  node: DomNode,
  tag: string,
  attrs: Map<string, string>,
  ctx: BuildCtx,
): string {
  const labelledBy = attrs.get("aria-labelledby");
  if (labelledBy) {
    const parts: string[] = [];
    for (const id of labelledBy.trim().split(/\s+/)) {
      const backend = ctx.idAttrToBackend.get(id);
      if (backend == null) continue;
      const found = findByBackend(ctx, backend);
      if (found) parts.push(textFromSubtree(found));
    }
    const joined = parts.join(" ").trim();
    if (joined) return joined;
  }
  const ariaLabel = attrs.get("aria-label");
  if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

  if (tag === "img" || tag === "area") {
    const alt = attrs.get("alt");
    if (alt) return alt;
  }
  if (tag === "input") {
    const type = (attrs.get("type") || "text").toLowerCase();
    if (type === "button" || type === "submit" || type === "reset") {
      const v = attrs.get("value");
      if (v) return v;
      if (type === "submit") return "Submit";
      if (type === "reset") return "Reset";
    }
    if (type === "image") {
      const alt = attrs.get("alt");
      if (alt) return alt;
    }
    const idAttr = attrs.get("id");
    if (idAttr) {
      const labelText = findLabelFor(ctx, idAttr);
      if (labelText) return labelText;
    }
    const wrapped = findWrappingLabel(ctx, node);
    if (wrapped) return wrapped;
    const ph = attrs.get("placeholder");
    if (ph) return ph;
  }
  if (tag === "textarea" || tag === "select") {
    const idAttr = attrs.get("id");
    if (idAttr) {
      const labelText = findLabelFor(ctx, idAttr);
      if (labelText) return labelText;
    }
    const wrapped = findWrappingLabel(ctx, node);
    if (wrapped) return wrapped;
    if (tag === "textarea") {
      const ph = attrs.get("placeholder");
      if (ph) return ph;
    }
  }
  if (tag === "fieldset") {
    for (const c of node.children ?? []) {
      if ((c.localName || c.nodeName).toLowerCase() === "legend") {
        return textFromSubtree(c);
      }
    }
  }
  if (tag === "table") {
    for (const c of node.children ?? []) {
      if ((c.localName || c.nodeName).toLowerCase() === "caption") {
        return textFromSubtree(c);
      }
    }
  }
  if (tag === "figure") {
    for (const c of node.children ?? []) {
      if ((c.localName || c.nodeName).toLowerCase() === "figcaption") {
        return textFromSubtree(c);
      }
    }
  }
  if (tag === "svg") {
    for (const c of node.children ?? []) {
      if ((c.localName || c.nodeName).toLowerCase() === "title") {
        return textFromSubtree(c);
      }
    }
  }

  if (NAME_FROM_CONTENTS.has(tag)) {
    const t = textFromSubtree(node).trim();
    if (t) return t;
  }
  const explicitRole = firstToken(attrs.get("role"));
  if (explicitRole && ROLE_NAME_FROM_CONTENTS.has(explicitRole)) {
    const t = textFromSubtree(node).trim();
    if (t) return t;
  }

  const title = attrs.get("title");
  if (title && title.trim()) return title.trim();
  return "";
}

function computeDescription(attrs: Map<string, string>, ctx: BuildCtx): string {
  const describedBy = attrs.get("aria-describedby");
  if (describedBy) {
    const parts: string[] = [];
    for (const id of describedBy.trim().split(/\s+/)) {
      const backend = ctx.idAttrToBackend.get(id);
      if (backend == null) continue;
      const found = findByBackend(ctx, backend);
      if (found) parts.push(textFromSubtree(found));
    }
    const joined = parts.join(" ").trim();
    if (joined) return joined;
  }
  const ariaDesc = attrs.get("aria-description");
  if (ariaDesc && ariaDesc.trim()) return ariaDesc.trim();
  return "";
}

function computeValue(
  _node: DomNode,
  tag: string,
  attrs: Map<string, string>,
  ctx: BuildCtx,
): AxNode["value"] {
  const backendId = _node.backendNodeId;
  const live = typeof backendId === "number" ? ctx.liveValues.get(backendId) : undefined;
  if (tag === "input") {
    const type = (attrs.get("type") || "text").toLowerCase();
    const v = live !== undefined ? live : attrs.get("value");
    if (type === "range" || type === "number") {
      if (v != null && v !== "") return { type: "number", value: Number(v) };
    } else if (v != null) {
      return { type: "string", value: v };
    }
  }
  if (tag === "select" && !attrs.has("multiple")) {
    const label = selectedOptionLabel(_node, ctx);
    if (label !== undefined) return { type: "string", value: label };
  }
  // A contenteditable editing host is a text field whose value is its text, as Chrome reports it;
  // without it a host that took typing read as empty, and a client typed into it again.
  const editable = attrs.get("contenteditable");
  if (editable !== undefined && editable.toLowerCase() !== "false") {
    return { type: "string", value: textFromSubtree(_node) };
  }
  if (tag === "textarea") {
    if (live !== undefined) return { type: "string", value: live };
    const v = textFromSubtree(_node);
    if (v) return { type: "string", value: v };
  }
  const ariaVal = attrs.get("aria-valuenow");
  if (ariaVal != null) {
    const n = Number(ariaVal);
    if (Number.isFinite(n)) return { type: "number", value: n };
  }
  const ariaValText = attrs.get("aria-valuetext");
  if (ariaValText) return { type: "string", value: ariaValText };
  return undefined;
}

function optionsOf(select: DomNode): DomNode[] {
  const out: DomNode[] = [];
  for (const c of select.children ?? []) {
    const tag = (c.localName || c.nodeName || "").toLowerCase();
    if (tag === "option") out.push(c);
    else if (tag === "optgroup")
      for (const o of c.children ?? [])
        if ((o.localName || o.nodeName || "").toLowerCase() === "option") out.push(o);
  }
  return out;
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
  const marked = opts.filter((o) => attrMap(o.attributes).has("selected"));
  if (marked.length > 0) return marked[marked.length - 1];
  const size = Number.parseInt(attrMap(select.attributes).get("size") ?? "", 10);
  if (size > 1) return undefined;
  for (const c of select.children ?? []) {
    const tag = localTag(c);
    if (attrMap(c.attributes).has("disabled")) continue;
    if (tag === "option") return c;
    if (tag !== "optgroup") continue;
    const inGroup = (c.children ?? []).find(
      (o) => localTag(o) === "option" && !attrMap(o.attributes).has("disabled"),
    );
    if (inGroup) return inGroup;
  }
  return undefined;
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
  const push = (name: string, type: string, value: unknown) => {
    out.push({ name, value: { type, value } });
  };

  if (/^h[1-6]$/.test(tag)) {
    push("level", "integer", Number(tag.slice(1)));
  }
  const ariaLevel = attrs.get("aria-level");
  if (ariaLevel != null) {
    const n = Number(ariaLevel);
    if (Number.isFinite(n)) push("level", "integer", n);
  }
  if (role === "listitem" && ariaLevel == null && listDepth > 0) {
    push("level", "integer", listDepth);
  }

  if (role === "link") {
    const href = attrs.get("href");
    if (href != null) push("url", "string", absUrl(href, ctx.baseUrl) || href);
  } else if (tag === "img") {
    const src = attrs.get("src");
    if (src != null) push("url", "string", absUrl(src, ctx.baseUrl) || src);
  }

  if (isFocusable(tag, attrs)) push("focusable", "booleanOrUndefined", true);

  const accessKey = attrs.get("accesskey");
  if (accessKey && !attrs.get("aria-keyshortcuts")) {
    push("keyshortcuts", "string", `Ctrl+Alt+${accessKey}`);
  }

  const bool = (name: string, aria: string) => {
    const v = attrs.get(aria);
    if (v === "true") push(name, "boolean", true);
    else if (v === "false") push(name, "boolean", false);
  };
  bool("expanded", "aria-expanded");
  bool("disabled", "aria-disabled");
  bool("required", "aria-required");
  bool("readonly", "aria-readonly");
  bool("selected", "aria-selected");
  bool("modal", "aria-modal");
  bool("multiline", "aria-multiline");
  bool("multiselectable", "aria-multiselectable");
  bool("atomic", "aria-atomic");
  bool("busy", "aria-busy");

  const tristate = (name: string, aria: string) => {
    const v = attrs.get(aria);
    if (v === "true" || v === "false" || v === "mixed") {
      push(name, "tristate", v);
    }
  };
  tristate("checked", "aria-checked");
  tristate("pressed", "aria-pressed");

  if (tag === "input" || tag === "textarea" || tag === "select" || tag === "button") {
    if (attrs.has("disabled")) push("disabled", "boolean", true);
    if (attrs.has("required")) push("required", "boolean", true);
    if (attrs.has("readonly")) push("readonly", "boolean", true);
  }
  if (tag === "input") {
    const type = (attrs.get("type") || "text").toLowerCase();
    if (type === "checkbox" || type === "radio") {
      const backendId = node.backendNodeId;
      const liveOn = typeof backendId === "number" ? ctx.liveChecked.get(backendId) : undefined;
      const on = liveOn !== undefined ? liveOn : attrs.has("checked");
      push("checked", "tristate", on ? "true" : "false");
    }
  }
  if (tag === "option") {
    const backendId = node.backendNodeId;
    const live = typeof backendId === "number" ? ctx.liveSelected.get(backendId) : undefined;
    if (live ?? attrs.has("selected")) push("selected", "boolean", true);
  }
  if (tag === "details" && attrs.has("open")) {
    push("expanded", "boolean", true);
  }

  const hasPopup = attrs.get("aria-haspopup");
  if (hasPopup && hasPopup !== "false") {
    push("hasPopup", "token", hasPopup === "true" ? "menu" : hasPopup);
  }

  const strProps: Array<[string, string]> = [
    ["keyshortcuts", "aria-keyshortcuts"],
    ["roledescription", "aria-roledescription"],
    ["autocomplete", "aria-autocomplete"],
    ["orientation", "aria-orientation"],
    ["live", "aria-live"],
    ["relevant", "aria-relevant"],
    ["placeholder", "aria-placeholder"],
    ["valuetext", "aria-valuetext"],
  ];
  for (const [name, aria] of strProps) {
    const v = attrs.get(aria);
    if (v) push(name, "string", v);
  }
  const numProps: Array<[string, string]> = [
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
  for (const [name, aria] of numProps) {
    const v = attrs.get(aria);
    if (v != null) {
      const n = Number(v);
      if (Number.isFinite(n)) push(name, "integer", n);
    }
  }

  if (tag === "input") {
    const type = (attrs.get("type") || "text").toLowerCase();
    if (type === "range" || type === "number") {
      const min = attrs.get("min");
      const max = attrs.get("max");
      const val = attrs.get("value");
      if (min != null && Number.isFinite(Number(min))) push("valuemin", "number", Number(min));
      if (max != null && Number.isFinite(Number(max))) push("valuemax", "number", Number(max));
      if (val != null && Number.isFinite(Number(val))) push("valuenow", "number", Number(val));
    }
  }

  return out;
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
  const walk = (n: DomNode) => {
    if (excludeBackendId != null && n.backendNodeId === excludeBackendId) return;
    if (n.nodeType === 3) {
      if (n.nodeValue) parts.push(n.nodeValue);
      return;
    }
    if (n.nodeType !== 1) return;
    const tag = (n.localName || n.nodeName || "").toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    const attrs = attrMap(n.attributes);
    if (attrs.get("aria-hidden") === "true") return;
    const label = attrs.get("aria-label");
    if (label && label.trim()) {
      parts.push(label.trim());
      return;
    }
    if (tag === "img") {
      const alt = attrs.get("alt");
      if (alt) parts.push(alt);
      return;
    }
    for (const c of n.children ?? []) walk(c);
  };
  for (const c of node.children ?? []) walk(c);
  return parts.join(" ").replace(/\s+/g, " ").trim();
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
  if (attrs.has("tabindex")) return true;
  const ce = attrs.get("contenteditable");
  if (ce != null && ce !== "false") return true;
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
  let cur = ctx.parentOf.get(selfId);
  for (let depth = 0; cur && depth < 8; depth++) {
    const tag = (cur.localName || cur.nodeName || "").toLowerCase();
    if (tag === "label") return textFromSubtree(cur, selfId);
    const pid = cur.backendNodeId;
    if (typeof pid !== "number") return "";
    cur = ctx.parentOf.get(pid);
  }
  return "";
}

function collectSubtree(tree: BuiltTree, rootId: string, out: Map<string, AxNode>): void {
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (id === undefined) continue;
    if (out.has(id)) continue;
    const n = tree.byId.get(id);
    if (!n) continue;
    out.set(id, n);
    for (const cid of n.childIds ?? []) stack.push(cid);
  }
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
