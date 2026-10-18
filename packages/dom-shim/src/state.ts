// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Holds per-document shim state and forward declarations used to wire module dependencies.

import type { DomHandle as WasmDomHandle } from "../../core/pkg/kitesurf_core";
import type { RawCdpMutation } from "@kitesurf/jsrpc-types/shared";
import type { DocumentImpl } from "./document.js";
import type {
  AttrCls as Attr,
  DOMTokenListCls,
  DocumentFragmentImpl,
  HtmlCollectionCls,
  NamedNodeMapCls,
  NodeListCls,
} from "./collections.js";
import type { Element } from "./element/element.js";
import type { CommentNode, NodeBase, TextNode } from "./node-base.js";
import { resetRegistries } from "./registries.js";

type DomHandle = WasmDomHandle;

export interface RuleStyleDeclarationStore {
  cssText(): string;
  cascadeText(): string;
  getPropertyValue(name: string): string;
  getPropertyPriority(name: string): string;
  setProperty(name: string, value: string, priority: string): boolean;
  hasProperty(name: string): boolean;
  removeProperty(name: string): string;
  length(): number;
  item(index: number): string;
  setCssText(cssText: string): void;
}

export type DomOperation =
  | { kind: "setAttribute"; node: number; name: string; value: string }
  | { kind: "removeAttribute"; node: number; name: string }
  | { kind: "setNodeText"; node: number; text: string }
  | { kind: "setInnerHtml"; node: number; html: string }
  | { kind: "appendChildHtml"; parent: number; html: string };

export interface AuthRectSnapshot {
  x: number;
  y: number;
  width: number;
  height: number;
  hasBox?: boolean;
}

export interface AuthScrollInfoSnapshot {
  scrollTop: number;
  scrollLeft: number;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
  clientTop: number;
  clientLeft: number;
  contentWidth: number;
  contentHeight: number;
  hasBox: boolean;
  overflowsX: boolean;
  overflowsY: boolean;
  userScrollableX: boolean;
  userScrollableY: boolean;
  stopScrollChainX: boolean;
  stopScrollChainY: boolean;
}

export interface AuthOffsetMetricsSnapshot {
  parent: number;
  top: number;
  left: number;
}

export interface ListenerEntry {
  listener: Function | { handleEvent?: unknown };
  capture: boolean;
  once: boolean;
  passive: boolean;
}

export interface BuildDocumentOpts {
  pageUrl: string;
  initialCookieString: string;
  doctypeMarker?: string | null;
  userAgent?: string | null;
  referrer?: string;
  getCurrentUrl?: () => string;
  setCurrentUrl?: (
    newUrl: string,
    kind: "hash" | "navigate" | "pushState" | "replaceState" | "historyApi",
  ) => void;
  canonicalizeInlineStyle?: (
    css: string,
  ) => Array<{ name: string; value: string; important?: boolean }>;
  parseTypedStyleValue?: (property: string, cssText: string) => unknown;
  parseTypedNumericValue?: (cssText: string) => unknown;
  parseCounterStyleRule?: (css: string, field: string, value: string) => unknown;
  serializeInlineStyle?: (css: string) => string;
  getInlinePropertyValue?: (cssText: string, property: string) => string;
  createRuleStyleDeclaration?: (
    context: "style" | "keyframe" | "font-face" | "page",
    cssText: string,
    baseUrl: string,
  ) => RuleStyleDeclarationStore;
  canonicalizePageSelectors?: (prelude: string) => string | undefined;
  getRectByAuthId?: (id: number) => AuthRectSnapshot | null;
  getScrollInfoByAuthId?: (id: number) => AuthScrollInfoSnapshot | null;
  getOffsetMetricsByAuthId?: (id: number) => AuthOffsetMetricsSnapshot | null;
  getStickyShiftByAuthId?: (id: number) => any;
  hitTestViaPaint?: (x: number, y: number) => number;
  getComputedStyleForAuthId?: (
    id: number,
    pseudo?: string,
  ) => Array<{ name: string; value: string; computed?: string; unresolved?: string }> | null;
  getComputedStyleValueForAuthId?: (id: number, name: string) => string | null;
  getExternalSheetRules?: (
    nodeId: number,
  ) => { state: "clean"; text: string } | { state: "denied" } | { state: "pending" };
  getScrollOffset?: () => { x: number; y: number } | null;
  setScrollOffset?: (x: number, y: number) => { x: number; y: number } | null;
  setWheelScrollOffset?: (x: number, y: number) => { x: number; y: number } | null;
  armTransitionDrain?: (animationListeners?: boolean) => void;
  characterSet?: string;
  encodingName?: (label: string) => string | undefined;
  percentEncodeAfterEncoding?: (
    encoding: string,
    input: string,
    set: number,
    spaceAsPlus: boolean,
  ) => string;
  encodeHtml?: (encoding: string, input: string) => Uint8Array;
}

export let dom: DomHandle = null as any;
export let pageUrl: string = "";
export let initialCookieString: string = "";
export let opts: BuildDocumentOpts | undefined = undefined;

export let getCurrentUrl: () => string = () => "";
export let setCurrentUrl:
  | ((url: string, kind: "hash" | "navigate" | "pushState" | "replaceState" | "historyApi") => void)
  | null = null;
export let getRectByAuthId: ((id: number) => AuthRectSnapshot | null) | null = null;
export let getScrollInfoByAuthId: ((id: number) => AuthScrollInfoSnapshot | null) | null = null;
export let getOffsetMetricsByAuthId: ((id: number) => AuthOffsetMetricsSnapshot | null) | null =
  null;
export let getStickyShiftByAuthId: ((id: number) => any) | null = null;
export let hitTestViaPaint: ((x: number, y: number) => number) | null = null;
export let getComputedStyleValueForAuthId: ((id: number, name: string) => string | null) | null =
  null;
export let getComputedStyleForAuthId:
  | ((
      id: number,
      pseudo?: string,
    ) => Array<{
      name: string;
      value: string;
      computed?: string;
      unresolved?: string;
    }> | null)
  | null = null;
export let armTransitionDrain: ((animationListeners?: boolean) => void) | null = null;
export let getInlinePropertyValue: ((cssText: string, property: string) => string) | null = null;
export let parseCounterStyleRule: ((css: string, field: string, value: string) => unknown) | null =
  null;
export let getExternalSheetRules:
  | ((
      nodeId: number,
    ) => { state: "clean"; text: string } | { state: "denied" } | { state: "pending" })
  | null = null;
export let getScrollOffset: (() => { x: number; y: number } | null) | null = null;
export let setScrollOffset: ((x: number, y: number) => { x: number; y: number } | null) | null =
  null;

export const ops: DomOperation[] = [];

export const cdpMutations: RawCdpMutation[] = [];

export let readyState: "loading" | "interactive" | "complete" = "loading";
export function setReadyState(s: "loading" | "interactive" | "complete"): void {
  readyState = s;
}

export let activeElement: any = null;
export function setActiveElement(el: any): void {
  activeElement = el;
}

export let cookieString: string = "";
export const cookieWrites: string[] = [];
export function setCookieString(s: string): void {
  cookieString = typeof s === "string" ? s : "";
}

export const listenerRegistry = new Map<any, Map<string, ListenerEntry[]>>();

export const WINDOW_KEY = "window";

export let documentImpl: DocumentImpl | null = null;
export function liveDocument(): DocumentImpl {
  if (documentImpl === null) throw new TypeError("dom-shim: no document is built");
  return documentImpl;
}
export let createElementInternal = (tag: string): Element => liveDocument().createElement(tag);
export let createElementNSInternal = (ns: string | null, qname: string): Element =>
  liveDocument().createElementNS(ns, qname);
export let createTextNodeInternal = (data: string): TextNode => liveDocument().createTextNode(data);
export let createCommentInternal = (data: string): CommentNode =>
  liveDocument().createComment(data);
export let createDocumentFragmentInternal = (): DocumentFragmentImpl =>
  liveDocument().createDocumentFragment();
export function setDocumentImpl(d: DocumentImpl): void {
  documentImpl = d;
  const ce = d.createElement,
    ceNS = d.createElementNS,
    ct = d.createTextNode;
  const cc = d.createComment,
    cf = d.createDocumentFragment;
  createElementInternal = (tag) => ce.call(d, tag);
  createElementNSInternal = (ns, qname) => ceNS.call(d, ns, qname);
  createTextNodeInternal = (data) => ct.call(d, data);
  createCommentInternal = (data) => cc.call(d, data);
  createDocumentFragmentInternal = () => cf.call(d);
}

export let windowObj: any = null;
export function setWindowObj(w: any): void {
  windowObj = w;
}

export let windowProxy: any = null;
export function setWindowProxy(w: any): void {
  windowProxy = w;
}

export let DOCUMENT_ID: number = -1;
export function setDocumentId(id: number): void {
  DOCUMENT_ID = id;
}

export const shadowRootModes: Map<number, "open" | "closed"> = new Map();

let synthIdCounter: number = -2;
export function nextSyntheticId(): number {
  return synthIdCounter--;
}

export interface FastpathHost {
  fastpathBind?: (
    brand: (obj: unknown) => number,
    revalidate: (op?: number) => number,
    wrapper: (nid: number) => unknown,
    peek?: (nid: number) => unknown,
    nodeList?: (ids: number[]) => unknown,
  ) => void;
  fastpathMarkSpecial?: (nodeId: number) => void;
  fastpathStats?: () => string;
}

export function fastpathMarkSpecial(nodeId: number): void {
  try {
    (dom as FastpathHost | null)?.fastpathMarkSpecial?.(nodeId);
  } catch {}
}

let nodeForFn: ((nodeId: number) => any) | null = null;
export function setNodeFor(fn: (nodeId: number) => any): void {
  nodeForFn = fn;
}
export function nodeFor(nodeId: number): any {
  return nodeForFn!(nodeId);
}
// nodeFor's cache hit and nothing else (null on a miss). Pure by contract: the
// boa fast path runs it without re-arming revalidation, see fastpath.ts.
let nodePeekFn: ((nodeId: number) => unknown) | null = null;
export function setNodePeek(fn: (nodeId: number) => unknown): void {
  nodePeekFn = fn;
}
export function nodePeek(nodeId: number): unknown {
  return nodePeekFn ? nodePeekFn(nodeId) : null;
}

export type NodeListSeqKey = "mutationSeq" | "childSeq";
type MakeNodeList = (getList: () => NodeBase[], seqKey?: NodeListSeqKey) => NodeListCls;
type MakeHtmlCollection = {
  (
    getList: () => Element[],
    protoCls?: undefined,
    extras?: Record<string | symbol, unknown>,
  ): HtmlCollectionCls;
  <T extends HtmlCollectionCls>(
    getList: () => Element[],
    protoCls: { prototype: T },
    extras?: Record<string | symbol, unknown>,
  ): T;
};
type AttrConstructor = typeof import("./collections.js").AttrCls;
type HTMLFormControlsCollectionConstructor =
  typeof import("./collections.js").HTMLFormControlsCollectionCls;
type HTMLOptionsCollectionConstructor = typeof import("./collections.js").HTMLOptionsCollectionCls;
type QualifiedNameFilter = typeof import("./collections.js").filterByQualifiedName;
type StyleSheetStubFactory = typeof import("./collections.js").makeStyleSheetStub;
let makeNodeListFn: MakeNodeList | null = null;
let makeHtmlCollectionFn: MakeHtmlCollection | null = null;
type MakeDOMTokenList = (
  read: () => string | null,
  write: (value: string) => void,
  supported?: ReadonlySet<string>,
) => DOMTokenListCls;
let makeDOMTokenListFn: MakeDOMTokenList | null = null;
type MakeNamedNodeMap = (
  list: Attr[],
  byName: Record<string, Attr>,
  owner?: Element | null,
  refresh?: (() => void) | null,
) => NamedNodeMapCls;
let makeNamedNodeMapFn: MakeNamedNodeMap | null = null;
export function setMakeNodeList(fn: MakeNodeList): void {
  makeNodeListFn = fn;
}
export function setMakeHtmlCollection(fn: MakeHtmlCollection): void {
  makeHtmlCollectionFn = fn;
}
export function setMakeDOMTokenList(fn: MakeDOMTokenList): void {
  makeDOMTokenListFn = fn;
}
export function setMakeNamedNodeMap(fn: MakeNamedNodeMap): void {
  makeNamedNodeMapFn = fn;
}
export function makeNodeList(getList: () => NodeBase[], seqKey?: NodeListSeqKey): NodeListCls {
  return makeNodeListFn!(getList, seqKey);
}
export function makeHtmlCollection(
  getList: () => Element[],
  protoCls?: undefined,
  extras?: Record<string | symbol, unknown>,
): HtmlCollectionCls;
export function makeHtmlCollection<T extends HtmlCollectionCls>(
  getList: () => Element[],
  protoCls: { prototype: T },
  extras?: Record<string | symbol, unknown>,
): T;
export function makeHtmlCollection(
  getList: () => Element[],
  protoCls?: { prototype: HtmlCollectionCls },
  extras?: Record<string | symbol, unknown>,
): HtmlCollectionCls {
  if (protoCls === undefined) return makeHtmlCollectionFn!(getList, undefined, extras);
  return makeHtmlCollectionFn!(getList, protoCls, extras);
}
export function makeDOMTokenList(
  read: () => string | null,
  write: (value: string) => void,
  supported?: ReadonlySet<string>,
): DOMTokenListCls {
  return makeDOMTokenListFn!(read, write, supported);
}
export function makeNamedNodeMap(
  list: Attr[],
  byName: Record<string, Attr>,
  owner?: Element | null,
  refresh?: (() => void) | null,
): NamedNodeMapCls {
  return makeNamedNodeMapFn!(list, byName, owner, refresh);
}

function wired<T>(slot: T | null, name: string): T {
  if (slot === null) throw new TypeError(`dom-shim: ${name} is not wired`);
  return slot;
}
type CloneStep = (src: NodeBase, clone: NodeBase) => void;
let cloneSteps: CloneStep | null = null;
let cloneStepsDeep: CloneStep | null = null;
export function setCloneSteps(s: CloneStep, sd: CloneStep): void {
  cloneSteps = s;
  cloneStepsDeep = sd;
}
export function runCloneSteps(...args: Parameters<CloneStep>): void {
  wired(cloneSteps, "runCloneSteps")(...args);
}
export function runCloneStepsDeep(...args: Parameters<CloneStep>): void {
  wired(cloneStepsDeep, "runCloneStepsDeep")(...args);
}

type ParseFragmentInContext = (
  fragment: { _id: number },
  ns: string | null,
  localName: string,
  html: string,
) => void;
let parseFragmentInContextFn: ParseFragmentInContext | null = null;
export function setParseFragmentInContext(fn: ParseFragmentInContext): void {
  parseFragmentInContextFn = fn;
}
export function parseFragmentInContext(...args: Parameters<ParseFragmentInContext>): void {
  wired(parseFragmentInContextFn, "parseFragmentInContext")(...args);
}

type ScopedQuery = (rootId: number, selector: string) => any;
let scopedQuerySelectorFn: ScopedQuery | null = null;
let scopedQuerySelectorAllFn: ScopedQuery | null = null;
export function setScopedQueries(qs: any, qsa: any): void {
  scopedQuerySelectorFn = qs;
  scopedQuerySelectorAllFn = qsa;
}
export function scopedQuerySelector(...args: Parameters<ScopedQuery>): ReturnType<ScopedQuery> {
  return wired(scopedQuerySelectorFn, "scopedQuerySelector")(...args);
}
export function scopedQuerySelectorAll(...args: Parameters<ScopedQuery>): ReturnType<ScopedQuery> {
  return wired(scopedQuerySelectorAllFn, "scopedQuerySelectorAll")(...args);
}

export let AttrCls: AttrConstructor;
export let HTMLFormControlsCollectionCls: HTMLFormControlsCollectionConstructor;
export let HTMLOptionsCollectionCls: HTMLOptionsCollectionConstructor;
export let OPTIONS_OWNER_SYM: symbol | null = null;
export let filterByQualifiedName: QualifiedNameFilter;
export let makeStyleSheetStub: StyleSheetStubFactory;
export function setCollectionsClasses(
  attr: AttrConstructor,
  hfcc: HTMLFormControlsCollectionConstructor,
  filterQN: QualifiedNameFilter,
  sheetStub: StyleSheetStubFactory,
  hoc?: HTMLOptionsCollectionConstructor,
  ownerSym?: symbol,
): void {
  AttrCls = attr;
  HTMLFormControlsCollectionCls = hfcc;
  filterByQualifiedName = filterQN;
  makeStyleSheetStub = sheetStub;
  if (hoc) HTMLOptionsCollectionCls = hoc;
  if (ownerSym) OPTIONS_OWNER_SYM = ownerSym;
}

export function initState(d: DomHandle, url: string, cookies: string, o?: BuildDocumentOpts): void {
  dom = d;
  pageUrl = url;
  initialCookieString = cookies;
  opts = o;

  getCurrentUrl = o && typeof o.getCurrentUrl === "function" ? o.getCurrentUrl : () => url;
  setCurrentUrl = o && typeof o.setCurrentUrl === "function" ? o.setCurrentUrl : null;
  getRectByAuthId = o && typeof o.getRectByAuthId === "function" ? o.getRectByAuthId : null;
  getScrollInfoByAuthId =
    o && typeof o.getScrollInfoByAuthId === "function" ? o.getScrollInfoByAuthId : null;
  getOffsetMetricsByAuthId =
    o && typeof o.getOffsetMetricsByAuthId === "function" ? o.getOffsetMetricsByAuthId : null;
  getStickyShiftByAuthId =
    o && typeof o.getStickyShiftByAuthId === "function" ? o.getStickyShiftByAuthId : null;
  hitTestViaPaint = o && typeof o.hitTestViaPaint === "function" ? o.hitTestViaPaint : null;
  getComputedStyleForAuthId =
    o && typeof o.getComputedStyleForAuthId === "function" ? o.getComputedStyleForAuthId : null;
  getComputedStyleValueForAuthId =
    o && typeof o.getComputedStyleValueForAuthId === "function"
      ? o.getComputedStyleValueForAuthId
      : null;
  armTransitionDrain =
    o && typeof o.armTransitionDrain === "function" ? o.armTransitionDrain : null;
  getInlinePropertyValue =
    o && typeof o.getInlinePropertyValue === "function" ? o.getInlinePropertyValue : null;
  parseCounterStyleRule =
    o && typeof o.parseCounterStyleRule === "function" ? o.parseCounterStyleRule : null;
  getExternalSheetRules =
    o && typeof o.getExternalSheetRules === "function" ? o.getExternalSheetRules : null;
  getScrollOffset = o && typeof o.getScrollOffset === "function" ? o.getScrollOffset : null;
  setScrollOffset = o && typeof o.setScrollOffset === "function" ? o.setScrollOffset : null;

  ops.length = 0;
  cdpMutations.length = 0;
  cookieWrites.length = 0;
  readyState = "loading";
  activeElement = null;
  cookieString = typeof cookies === "string" ? cookies : "";
  listenerRegistry.clear();

  documentImpl = null;
  windowObj = null;
  windowProxy = null;

  resetRegistries();
}

export type ShimGlobal = typeof globalThis & Record<PropertyKey, any>;

// PageScript and the shim install dynamic hooks on this page-realm global.
export const ksGlobal = globalThis as ShimGlobal;
