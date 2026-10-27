// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Builds one page generation's DOM shim and wires its document, Window, and PageScript hooks.

import type { DomHandle } from "../../core/pkg/kitesurf_core";
import type { BuildDocumentOpts } from "./state.js";

import { getInternalState } from "./internal-state.js";
import { createModelContext, acquireModelContext, ModelContext } from "./model-context.js";
import {
  ELEMENT_NODE,
  TEXT_NODE,
  COMMENT_NODE,
  DOCTYPE_NODE,
  DOCUMENT_FRAGMENT_NODE,
  HTML_NS,
} from "./constants.js";
import { dispatchTrustedEvent } from "./events/dispatch.js";
import { installCurrentScriptHook } from "./current-script.js";
import { initState } from "./state.js";
import { installFastpath } from "./fastpath.js";
import { fileInputFiles, fileInputLists } from "./file-input.js";

import {
  ops,
  cdpMutations,
  cookieWrites,
  activeElement,
  setReadyState,
  setCookieString,
} from "./state.js";
import { installWindow, stampInitialNamedGlobals } from "./window.js";
import {
  setDocumentImpl,
  setNodeFor,
  setNodePeek,
  setMakeNodeList,
  setMakeHtmlCollection,
  setMakeDOMTokenList,
  setMakeNamedNodeMap,
  setCloneSteps,
  setParseFragmentInContext,
  setDocumentId,
  setScopedQueries,
} from "./state.js";
import { MutationRecord, MutationObserverImpl } from "./mutations/observer.js";
import {
  KsEventTarget,
  NodeBase,
  CharacterDataNode,
  TextNode,
  CommentNode,
  DocumentTypeNode,
  GenericNode,
} from "./node-base.js";
import { finalizeGeneratedInterfaces, finalizeInterface, idlInterfaceMeta } from "./webidl.js";
import { CSS_TYPED_OM_WEBIDL } from "./css-typed-om.webidl.generated.js";
import {
  GLOBAL_EVENT_HANDLERS,
  WINDOW_EVENT_HANDLERS,
  ALL_EVENT_HANDLERS,
} from "./event-handler-names.js";
import {
  Element,
  HTMLElement,
  HTML_ELEMENT_INTERFACES,
  ValidityStateImpl,
  HTMLInputElement,
  HTMLTextAreaElement,
  HTMLSelectElement,
  HTMLOptionElement,
  HTMLOptGroupElement,
  HTMLButtonElement,
  HTMLLabelElement,
  HTMLFieldSetElement,
  HTMLOutputElement,
  HTMLProgressElement,
  HTMLMeterElement,
  HTMLFormElement,
  HTMLAnchorElement,
  HTMLAreaElement,
  HTMLImageElement,
  HTMLTitleElement,
  HTMLScriptElement,
  HTMLLinkElement,
  HTMLMetaElement,
  HTMLStyleElement,
  HTMLBaseElement,
  HTMLTableElement,
  HTMLTableRowElement,
  HTMLTableSectionElement,
  HTMLDetailsElement,
  HTMLDialogElement,
  resolveElementClass,
  runCloneSteps,
  runCloneStepsDeep,
  parseFragmentInContext,
  installIdlHandlersOn,
  InternalElementCtorToken,
  notifyImageResults,
  notifyStylesheetResults,
  applyDeclarativeShadowRoots,
  DOMRect,
  DOMRectReadOnly,
  DOMRectList,
} from "./element/index.js";
import { activateLabel } from "./element/element.js";
import {
  AbstractRangeImpl,
  RangeImpl,
  StaticRangeImpl,
  SelectionImpl,
  getSelection,
} from "./range.js";
import { DocumentImpl, DOMImplementationCls, DetachedDocument, XMLDocument } from "./document.js";
import { DOMParser, ParsedDocument } from "./parser.js";
import { NodeFilter, TreeWalker, NodeIterator } from "./traversal.js";
import { XPathEvaluator, XPathExpression, XPathResult } from "./xpath.js";
import { FormData } from "./form-data.js";
import "./record.js";
import "./select-dropdown.js";
import {
  AttrCls,
  NodeListCls,
  DocumentFragmentImpl,
  ShadowRootImpl,
  mintShadowRoot,
  HtmlCollectionCls,
  HTMLFormControlsCollectionCls,
  HTMLOptionsCollectionCls,
  RadioNodeListCls,
  DOMTokenListCls,
  CSSRuleInterface,
  CSSStyleSheetCtor,
  CSSOM_GLOBALS,
  NamedNodeMapCls,
  makeNodeList,
  makeHtmlCollection,
  makeDOMTokenList,
  makeNamedNodeMap,
  scopedQuerySelector,
  scopedQuerySelectorAll,
} from "./collections.js";
import {
  KsEvent,
  KsCustomEvent,
  KsSubmitEvent,
  KsHashChangeEvent,
  KsPopStateEvent,
  KsPageTransitionEvent,
  KsTransitionEvent,
  KsAnimationEvent,
  KsBeforeUnloadEvent,
  KsDeviceMotionEvent,
  KsDeviceMotionEventAcceleration,
  KsDeviceMotionEventRotationRate,
  KsDeviceOrientationEvent,
  KsDragEvent,
  KsMessageEvent,
  KsStorageEvent,
  KsTextEvent,
  KsTouchEvent,
  KsErrorEvent,
  KsPromiseRejectionEvent,
  KsUIEvent,
  KsMouseEvent,
  KsPointerEvent,
  KsFocusEvent,
  KsWheelEvent,
  KsCompositionEvent,
  KsInputEvent,
  KsKeyboardEvent,
} from "./events/event.js";
import { CSS_TYPED_OM_GLOBALS } from "./css-typed-om.js";
import {
  CanvasGradientShim,
  CanvasPatternShim,
  CanvasRenderingContext2DImpl,
  Path2D,
} from "./canvas2d.js";
import {
  cache,
  liveWrapper,
  weakWrappers,
  inputState,
  optionSelected,
  selectionState,
  customValidity,
  elemNs,
  fragmentIds,
} from "./registries.js";
import { installDetachedWrapperHooks } from "./detached-wrappers.js";

function ksState() {
  return getInternalState();
}

export { armKsOtel, ksSpan } from "./otel.js";
import {
  KsAnimation,
  KsAnimationEffect,
  KsAnimationPlaybackEvent,
  KsAnimationTimeline,
  KsDocumentTimeline,
  KsKeyframeEffect,
} from "./animations.js";

// nodePeek bypasses fastpath revalidation, so capture its intrinsics before page scripts run.
const peekMapGet = Map.prototype.get;
const peekHasOwn = Object.prototype.hasOwnProperty;
const peekApply = Reflect.apply;
const peekGopd = Object.getOwnPropertyDescriptor;
const CHILD_NODE_METHODS = ["before", "after", "replaceWith", "remove"];
const PARENT_NODE_METHODS = ["append", "prepend", "replaceChildren"];
const BRANDED_NODE = { brandOps: true, brandDuck: true, brandAttrs: true };

type NodeInfo = NonNullable<ReturnType<DomHandle["nodeInfo"]>>;

function currentUrlGetter(opts: BuildDocumentOpts): () => string {
  return typeof opts.getCurrentUrl === "function" ? opts.getCurrentUrl : () => opts.pageUrl;
}

function currentOrigin(getUrl: () => string): string {
  try {
    return new URL(getUrl()).origin;
  } catch {
    return "";
  }
}

function isEligibleNamedAccess(prop: PropertyKey): prop is string {
  return typeof prop === "string" && prop !== "" && !prop.startsWith("__");
}

function namedListItem(node: NodeBase, prop: string, receiver: unknown, isForm: boolean): unknown {
  const list = Reflect.get(node, isForm ? "elements" : "options", receiver);
  return list ? list[prop] : undefined;
}

function namedFormItem(node: NodeBase, prop: string, receiver: unknown): unknown {
  const method = Reflect.get(node, "namedItem", receiver);
  if (typeof method === "function") return method.call(receiver, prop) ?? undefined;
  return undefined;
}

function readNamedFallback(
  node: NodeBase,
  prop: string,
  receiver: unknown,
  isForm: boolean,
): unknown {
  try {
    if (/^\d+$/.test(prop)) return namedListItem(node, prop, receiver, isForm);
    if (!isForm) return undefined;
    return namedFormItem(node, prop, receiver);
  } catch {}
  return undefined;
}

function namedAccessProperty(
  node: NodeBase,
  prop: PropertyKey,
  receiver: unknown,
  isForm: boolean,
): unknown {
  if (typeof prop === "symbol" || prop in node) return Reflect.get(node, prop, receiver);
  if (!isEligibleNamedAccess(prop)) return undefined;
  return readNamedFallback(node, prop, receiver, isForm);
}

function makeNamedAccessProxy(node: NodeBase, localName: string): NodeBase {
  const isForm = localName === "form";
  return new Proxy(node, {
    get(target, prop, receiver) {
      return namedAccessProperty(target, prop, receiver, isForm);
    },
  });
}

function evictCachedNode(nodeId: number): void {
  cache.delete(nodeId);
  weakWrappers.delete(nodeId);
  inputState.delete(nodeId);
  optionSelected.delete(nodeId);
  selectionState.delete(nodeId);
  customValidity.delete(nodeId);
  fileInputFiles.delete(nodeId);
  fileInputLists.delete(nodeId);
}

function isInvalidNodeId(nodeId: number): boolean {
  return nodeId == null || nodeId < 0;
}

function cachedWrapperIsCurrent(
  domHandle: DomHandle,
  nodeId: number,
  documentId: () => number,
  cached: NodeBase,
): boolean {
  const currentSeq = ksState().mutationSeq | 0;
  if (cached._typeCheckSeq === currentSeq) return true;
  if (nodeId === documentId()) return true;
  try {
    if (domHandle.parentId(nodeId) >= 0) return true;
  } catch {}
  return false;
}

function currentCachedNode(
  domHandle: DomHandle,
  nodeId: number,
  documentId: () => number,
  cached: NodeBase | undefined,
): NodeBase | undefined {
  return cached && cachedWrapperIsCurrent(domHandle, nodeId, documentId, cached)
    ? cached
    : undefined;
}

function readNodeInfo(domHandle: DomHandle, nodeId: number): NodeInfo | null {
  try {
    const info = domHandle.nodeInfo(nodeId);
    return info || null;
  } catch {
    evictCachedNode(nodeId);
    return null;
  }
}

function cachedNodeMatchesInfo(cached: NodeBase, info: NodeInfo): boolean {
  const cachedType = cached._info && cached._info.nodeType;
  const tagStable =
    info.nodeType !== ELEMENT_NODE || !cached._info || cached._info.localName === info.localName;
  return cachedType === info.nodeType && tagStable;
}

function refreshCachedNode(cached: NodeBase, nodeId: number, info: NodeInfo): NodeBase | null {
  if (cachedNodeMatchesInfo(cached, info)) {
    cached._info = info;
    cached._typeCheckSeq = ksState().mutationSeq | 0;
    cached._attrFlatCache = null;
    return cached;
  }
  evictCachedNode(nodeId);
  return null;
}

function refreshCachedNodeIfPresent(
  cached: NodeBase | undefined,
  nodeId: number,
  info: NodeInfo,
): NodeBase | null {
  return cached ? refreshCachedNode(cached, nodeId, info) : null;
}

function shouldUseNamedAccess(localName: string, namespace: string | null): boolean {
  return namespace === HTML_NS && (localName === "form" || localName === "select");
}

function createElementNode(nodeId: number, info: NodeInfo): NodeBase {
  if (fragmentIds.has(nodeId)) return new DocumentFragmentImpl(nodeId, info);
  const elemNsEntry = elemNs.get(nodeId);
  const elemNsValue = elemNsEntry ? elemNsEntry.ns : HTML_NS;
  const Cls = resolveElementClass(info.localName, elemNsValue);
  const node = new Cls(nodeId, info, InternalElementCtorToken);
  return shouldUseNamedAccess(info.localName, elemNsValue)
    ? makeNamedAccessProxy(node, info.localName)
    : node;
}

function createNonElementNode(nodeId: number, info: NodeInfo): NodeBase {
  switch (info.nodeType) {
    case TEXT_NODE:
      return new TextNode(nodeId, info);
    case COMMENT_NODE:
      return new CommentNode(nodeId, info);
    case DOCTYPE_NODE:
      return new DocumentTypeNode(nodeId, info);
    case DOCUMENT_FRAGMENT_NODE:
      return mintShadowRoot(nodeId, info);
    default:
      return new GenericNode(nodeId, info);
  }
}

function createNodeFromInfo(nodeId: number, info: NodeInfo): NodeBase {
  return info.nodeType === ELEMENT_NODE
    ? createElementNode(nodeId, info)
    : createNonElementNode(nodeId, info);
}

function createNodeFor(
  domHandle: DomHandle,
  documentId: () => number,
): (nodeId: number) => NodeBase | null {
  const nodeFor = function nodeFor(nodeId: number): NodeBase | null {
    if (isInvalidNodeId(nodeId)) return null;
    const cached = liveWrapper(nodeId);
    const current = currentCachedNode(domHandle, nodeId, documentId, cached);
    if (current) return current;
    const info = readNodeInfo(domHandle, nodeId);
    if (!info) return null;
    const refreshed = refreshCachedNodeIfPresent(cached, nodeId, info);
    if (refreshed) return refreshed;
    const node = createNodeFromInfo(nodeId, info);
    node._typeCheckSeq = ksState().mutationSeq | 0;
    cache.set(nodeId, node);
    return node;
  };
  return nodeFor;
}

function makeEnumerableOwnDescriptor(source: PropertyDescriptor): PropertyDescriptor {
  const descriptor: PropertyDescriptor = { configurable: true, enumerable: true };
  if (source.get || source.set) {
    descriptor.get = source.get;
    descriptor.set = source.set;
  } else {
    descriptor.value = source.value;
    descriptor.writable = true;
  }
  return descriptor;
}

function makeExistingMemberEnumerable(proto: any, name: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(proto, name);
  if (!descriptor || descriptor.enumerable !== false || descriptor.configurable === false) return;
  try {
    Object.defineProperty(proto, name, { ...descriptor, enumerable: true });
  } catch {}
}

function installOwnMember(targetProto: any, sourceProto: any, name: string): void {
  if (Object.prototype.hasOwnProperty.call(targetProto, name)) {
    makeExistingMemberEnumerable(targetProto, name);
    return;
  }
  const source = Object.getOwnPropertyDescriptor(sourceProto, name);
  if (!source) return;
  try {
    Object.defineProperty(targetProto, name, makeEnumerableOwnDescriptor(source));
  } catch {}
}

function installAsOwn(target: any, sourceProto: any, names: string[]): void {
  if (!target || !target.prototype || !sourceProto) return;
  for (const name of names) installOwnMember(target.prototype, sourceProto, name);
}

function installNodeMethodsAsOwn(): void {
  for (const cls of [Element, CharacterDataNode, DocumentTypeNode]) {
    installAsOwn(cls, NodeBase.prototype, CHILD_NODE_METHODS);
  }
  for (const cls of [Element, DocumentImpl, DocumentFragmentImpl]) {
    installAsOwn(cls, NodeBase.prototype, PARENT_NODE_METHODS);
  }
  installAsOwn(HTMLElement, Element.prototype, ["click", "focus", "blur"]);
}

function forceEnumerableProtoOwnProps(klass: any): void {
  if (!klass || !klass.prototype) return;
  const proto = klass.prototype;
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === "constructor") continue;
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (!descriptor) continue;
    if (descriptor.enumerable === true) continue;
    if (descriptor.configurable === false) continue;
    try {
      Object.defineProperty(proto, name, { ...descriptor, enumerable: true });
    } catch {}
  }
}

function finalizeEnumerableInterfaces(): void {
  for (const cls of [
    NodeBase,
    Element,
    HTMLElement,
    CharacterDataNode,
    DocumentTypeNode,
    DocumentImpl,
    DocumentFragmentImpl,
    HTMLInputElement,
    HTMLTextAreaElement,
    HTMLSelectElement,
    HTMLOptionElement,
    HTMLOptGroupElement,
    HTMLButtonElement,
    HTMLLabelElement,
    HTMLFieldSetElement,
    HTMLOutputElement,
    HTMLProgressElement,
    HTMLMeterElement,
    HTMLFormElement,
    HTMLAnchorElement,
    HTMLAreaElement,
    HTMLImageElement,
    HTMLLinkElement,
    HTMLScriptElement,
    HTMLMetaElement,
    HTMLStyleElement,
    HTMLBaseElement,
    HTMLTableElement,
    HTMLTableRowElement,
    HTMLTableSectionElement,
    HTMLTitleElement,
    HTMLDetailsElement,
    HTMLDialogElement,
  ]) {
    forceEnumerableProtoOwnProps(cls);
  }
}

function installWebkitMatchesSelector(): void {
  if (Object.prototype.hasOwnProperty.call(Element.prototype, "webkitMatchesSelector")) return;
  Object.defineProperty(Element.prototype, "webkitMatchesSelector", {
    value: function (selector: string) {
      return this.matches(selector);
    },
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

function finalizeCssomInterfaces(): void {
  for (const name of [
    "CSSRule",
    "CSSGroupingRule",
    "CSSStyleRule",
    "CSSImportRule",
    "CSSPageRule",
    "CSSMarginRule",
    "CSSNamespaceRule",
    "CSSKeyframeRule",
    "CSSKeyframesRule",
    "MediaList",
    "CSSStyleDeclaration",
    "StyleSheet",
    "CSSStyleSheet",
  ] as const) {
    finalizeInterface(
      CSSOM_GLOBALS[name],
      idlInterfaceMeta(name, { brandOps: true, brandAttrs: true }),
    );
  }
}

function finalizeHtmlElementInterfaces(): void {
  for (const name of Object.keys(
    HTML_ELEMENT_INTERFACES,
  ) as (keyof typeof HTML_ELEMENT_INTERFACES)[]) {
    finalizeInterface(HTML_ELEMENT_INTERFACES[name], idlInterfaceMeta(name, BRANDED_NODE));
  }
}

const buildDocumentBody = function buildDocument(dom: DomHandle, opts: BuildDocumentOpts) {
  initState(dom, opts.pageUrl, opts.initialCookieString, opts);
  installDetachedWrapperHooks(dom);
  installCurrentScriptHook();
  const getCurrentUrl = currentUrlGetter(opts);
  ksState().lastMutationAt = Date.now();
  const nodeFor = createNodeFor(dom, () => DOCUMENT_ID);
  setNodeFor(nodeFor);
  // nodeFor's first branch only. The stamp is read as an own data property so a
  // page-defined _typeCheckSeq accessor (or Object.prototype.value) never runs.
  setNodePeek((nodeId) => {
    const cached = peekApply(peekMapGet, cache, [nodeId]);
    if (!cached) return null;
    const stamp = peekGopd(cached, "_typeCheckSeq");
    if (!stamp || !peekApply(peekHasOwn, stamp, ["value"])) return null;
    return stamp.value === (ksState().mutationSeq | 0) ? cached : null;
  });

  const DOCUMENT_ID = dom.documentNodeId();

  installIdlHandlersOn(DocumentImpl.prototype);
  installNodeMethodsAsOwn();
  finalizeEnumerableInterfaces();
  installWebkitMatchesSelector();
  setMakeNodeList(makeNodeList);
  setMakeHtmlCollection(makeHtmlCollection);
  setMakeDOMTokenList(makeDOMTokenList);
  setMakeNamedNodeMap(makeNamedNodeMap);
  setCloneSteps(runCloneSteps, runCloneStepsDeep);
  setParseFragmentInContext(parseFragmentInContext);
  setDocumentId(DOCUMENT_ID);
  setScopedQueries(scopedQuerySelector, scopedQuerySelectorAll);

  const document = new DocumentImpl();
  document._doctypeMarker = opts.doctypeMarker ?? null;
  cache.set(DOCUMENT_ID, document);
  setDocumentImpl(document);

  const { window, Window } = installWindow(document, dom);

  createModelContext({
    getWindow: () => window,
    getDocument: () => document,
    getOrigin: () => currentOrigin(getCurrentUrl),
  });
  {
    const mcDescriptor = Object.getOwnPropertyDescriptor(
      {
        get modelContext() {
          return acquireModelContext(this);
        },
      },
      "modelContext",
    ) as PropertyDescriptor;
    mcDescriptor.configurable = true;
    mcDescriptor.enumerable = true;
    Object.defineProperty(DetachedDocument.prototype, "modelContext", mcDescriptor);
    Object.defineProperty(DocumentImpl.prototype, "modelContext", mcDescriptor);
    Object.defineProperty(ParsedDocument.prototype, "modelContext", mcDescriptor);
  }

  finalizeInterface(KsEventTarget, idlInterfaceMeta("EventTarget", { brandOps: true }));
  finalizeInterface(NodeBase, idlInterfaceMeta("Node", BRANDED_NODE));
  finalizeInterface(Element, idlInterfaceMeta("Element", BRANDED_NODE));
  finalizeInterface(HTMLElement, idlInterfaceMeta("HTMLElement", BRANDED_NODE));
  finalizeInterface(
    KsAnimationTimeline,
    idlInterfaceMeta("AnimationTimeline", { brandAttrs: true }),
  );
  finalizeInterface(
    KsDocumentTimeline,
    idlInterfaceMeta("DocumentTimeline", { parent: KsAnimationTimeline }),
  );
  finalizeInterface(KsAnimationEffect, idlInterfaceMeta("AnimationEffect", { brandOps: true }));
  finalizeInterface(
    KsKeyframeEffect,
    idlInterfaceMeta("KeyframeEffect", { parent: KsAnimationEffect, brandOps: true }),
  );
  finalizeInterface(
    KsAnimation,
    idlInterfaceMeta("Animation", { parent: KsEventTarget, brandOps: true }),
  );
  finalizeInterface(
    ModelContext,
    idlInterfaceMeta("ModelContext", {
      parent: KsEventTarget,
      methodLengths: { getTools: 0, executeTool: 1 },
      brandOps: true,
      brandAttrs: true,
      promiseOps: ["getTools", "executeTool"],
    }),
  );
  finalizeInterface(
    CharacterDataNode,
    idlInterfaceMeta("CharacterData", {
      ...BRANDED_NODE,
      strictInstance: true,
    }),
  );
  finalizeInterface(TextNode, idlInterfaceMeta("Text", { ...BRANDED_NODE, strictInstance: true }));
  finalizeInterface(
    CommentNode,
    idlInterfaceMeta("Comment", { ...BRANDED_NODE, strictInstance: true }),
  );
  finalizeInterface(
    DocumentTypeNode,
    idlInterfaceMeta("DocumentType", {
      ...BRANDED_NODE,
      strictInstance: true,
    }),
  );
  finalizeInterface(DocumentFragmentImpl, idlInterfaceMeta("DocumentFragment", BRANDED_NODE));
  finalizeInterface(ShadowRootImpl, idlInterfaceMeta("ShadowRoot", BRANDED_NODE));
  finalizeInterface(AttrCls, idlInterfaceMeta("Attr", { ...BRANDED_NODE, parent: NodeBase }));
  installIdlHandlersOn(DetachedDocument.prototype);
  finalizeInterface(DetachedDocument, idlInterfaceMeta("Document", BRANDED_NODE));
  finalizeInterface(DocumentImpl, idlInterfaceMeta("Document", BRANDED_NODE));
  finalizeInterface(XMLDocument, idlInterfaceMeta("XMLDocument"));
  finalizeInterface(
    DOMImplementationCls,
    idlInterfaceMeta("DOMImplementation", { brandOps: true }),
  );
  finalizeInterface(NodeListCls, idlInterfaceMeta("NodeList"));
  finalizeInterface(RadioNodeListCls, idlInterfaceMeta("RadioNodeList"));
  finalizeInterface(HtmlCollectionCls, idlInterfaceMeta("HTMLCollection"));
  finalizeInterface(HTMLFormControlsCollectionCls, idlInterfaceMeta("HTMLFormControlsCollection"));
  finalizeInterface(HTMLOptionsCollectionCls, idlInterfaceMeta("HTMLOptionsCollection"));
  finalizeInterface(
    DOMTokenListCls,
    idlInterfaceMeta("DOMTokenList", { brandOps: true, brandAttrs: true }),
  );
  finalizeInterface(NamedNodeMapCls, idlInterfaceMeta("NamedNodeMap"));
  finalizeInterface(AbstractRangeImpl, idlInterfaceMeta("AbstractRange", { brandAttrs: true }));
  finalizeInterface(RangeImpl, idlInterfaceMeta("Range", { brandOps: true, brandAttrs: true }));
  finalizeInterface(
    SelectionImpl,
    idlInterfaceMeta("Selection", { brandOps: true, brandAttrs: true }),
  );
  finalizeInterface(StaticRangeImpl, idlInterfaceMeta("StaticRange", { brandAttrs: true }));
  finalizeInterface(
    TreeWalker,
    idlInterfaceMeta("TreeWalker", { brandOps: true, brandAttrs: true }),
  );
  finalizeInterface(
    NodeIterator,
    idlInterfaceMeta("NodeIterator", { brandOps: true, brandAttrs: true }),
  );
  finalizeInterface(
    XPathResult,
    idlInterfaceMeta("XPathResult", { brandOps: true, brandAttrs: true }),
  );
  finalizeInterface(XPathExpression, idlInterfaceMeta("XPathExpression", { brandOps: true }));
  finalizeInterface(FormData, idlInterfaceMeta("FormData", { brandOps: true }));
  finalizeInterface(XPathEvaluator, idlInterfaceMeta("XPathEvaluator", { brandOps: true }));
  finalizeInterface(MutationObserverImpl, idlInterfaceMeta("MutationObserver", { brandOps: true }));
  finalizeInterface(MutationRecord, idlInterfaceMeta("MutationRecord", { brandAttrs: true }));
  finalizeInterface(DOMParser, idlInterfaceMeta("DOMParser", { brandOps: true }));
  finalizeInterface(ValidityStateImpl, idlInterfaceMeta("ValidityState", { brandAttrs: true }));
  finalizeInterface(
    DOMRectReadOnly,
    idlInterfaceMeta("DOMRectReadOnly", { brandOps: true, brandAttrs: true }),
  );
  finalizeInterface(DOMRect, idlInterfaceMeta("DOMRect", { brandOps: true, brandAttrs: true }));
  finalizeInterface(
    DOMRectList,
    idlInterfaceMeta("DOMRectList", { brandOps: true, brandAttrs: true }),
  );
  // The CSSOM interfaces in the pinned IDL. Their members already throw on a
  // foreign receiver; this pins arity, enumerability and accessor names.
  finalizeCssomInterfaces();
  finalizeInterface(CanvasGradientShim, idlInterfaceMeta("CanvasGradient", { brandOps: true }));
  finalizeInterface(CanvasPatternShim, idlInterfaceMeta("CanvasPattern", { brandOps: true }));
  // The forwarders already check the receiver (canvas2d.ts); this pins
  // name, arity and enumerability.
  finalizeInterface(
    CanvasRenderingContext2DImpl,
    idlInterfaceMeta("CanvasRenderingContext2D", {
      brandOps: true,
      brandAttrs: true,
    }),
  );

  const bag = {
    document,
    window,
    eventHandlerNames: {
      global: GLOBAL_EVENT_HANDLERS,
      window: WINDOW_EVENT_HANDLERS,
      all: ALL_EVENT_HANDLERS,
    },
    Window,
    Event: KsEvent,
    CustomEvent: KsCustomEvent,
    SubmitEvent: KsSubmitEvent,
    FormData,
    UIEvent: KsUIEvent,
    FocusEvent: KsFocusEvent,
    WheelEvent: KsWheelEvent,
    CompositionEvent: KsCompositionEvent,
    InputEvent: KsInputEvent,
    MouseEvent: KsMouseEvent,
    PointerEvent: KsPointerEvent,
    KeyboardEvent: KsKeyboardEvent,
    HashChangeEvent: KsHashChangeEvent,
    PopStateEvent: KsPopStateEvent,
    PageTransitionEvent: KsPageTransitionEvent,
    TransitionEvent: KsTransitionEvent,
    AnimationEvent: KsAnimationEvent,
    Animation: KsAnimation,
    AnimationEffect: KsAnimationEffect,
    KeyframeEffect: KsKeyframeEffect,
    AnimationTimeline: KsAnimationTimeline,
    DocumentTimeline: KsDocumentTimeline,
    AnimationPlaybackEvent: KsAnimationPlaybackEvent,
    ErrorEvent: KsErrorEvent,
    PromiseRejectionEvent: KsPromiseRejectionEvent,
    BeforeUnloadEvent: KsBeforeUnloadEvent,
    DeviceMotionEvent: KsDeviceMotionEvent,
    DeviceMotionEventAcceleration: KsDeviceMotionEventAcceleration,
    DeviceMotionEventRotationRate: KsDeviceMotionEventRotationRate,
    DeviceOrientationEvent: KsDeviceOrientationEvent,
    DragEvent: KsDragEvent,
    MessageEvent: KsMessageEvent,
    StorageEvent: KsStorageEvent,
    TextEvent: KsTextEvent,
    TouchEvent: KsTouchEvent,
    Element,
    HTMLElement,
    ...HTML_ELEMENT_INTERFACES,
    htmlElementInterfaces: HTML_ELEMENT_INTERFACES,
    Node: NodeBase,
    EventTarget: KsEventTarget,
    Text: TextNode,
    Comment: CommentNode,
    CharacterData: CharacterDataNode,
    ProcessingInstruction: TextNode,
    CDATASection: TextNode,
    Document: DetachedDocument,
    XMLDocument,
    DocumentType: DocumentTypeNode,
    DOMImplementation: DOMImplementationCls,
    HTMLCollection: HtmlCollectionCls,
    HTMLFormControlsCollection: HTMLFormControlsCollectionCls,
    HTMLOptionsCollection: HTMLOptionsCollectionCls,
    RadioNodeList: RadioNodeListCls,
    NodeList: NodeListCls,
    DocumentFragment: DocumentFragmentImpl,
    ShadowRoot: ShadowRootImpl,
    DOMTokenList: DOMTokenListCls,
    NamedNodeMap: NamedNodeMapCls,
    ModelContext,
    MutationObserver: MutationObserverImpl,
    MutationRecord,
    DOMParser,
    CSSStyleSheet: CSSStyleSheetCtor,
    CSSRule: CSSRuleInterface,
    ...(CSSOM_GLOBALS as Omit<typeof CSSOM_GLOBALS, "CSSStyleSheet" | "CSSRule">),
    ...CSS_TYPED_OM_GLOBALS,
    Path2D,
    CanvasRenderingContext2D: CanvasRenderingContext2DImpl,
    CanvasGradient: CanvasGradientShim,
    CanvasPattern: CanvasPatternShim,
    DOMRect,
    DOMRectReadOnly,
    DOMRectList,
    AbstractRange: AbstractRangeImpl,
    Range: RangeImpl,
    StaticRange: StaticRangeImpl,
    Selection: SelectionImpl,
    getSelection: getSelection,
    Attr: AttrCls,
    ValidityState: ValidityStateImpl,
    NodeFilter,
    TreeWalker,
    NodeIterator,
    XPathResult,
    XPathExpression,
    XPathEvaluator,
    setReadyState: (s) => {
      if (s === "loading" || s === "interactive" || s === "complete") {
        setReadyState(s);
      }
    },
    drainCookieWrites: () => {
      if (cookieWrites.length === 0) return [];
      const out = cookieWrites.slice();
      cookieWrites.length = 0;
      return out;
    },
    setCookieString: (s) => {
      setCookieString(s);
    },
    nodeFor: (id) => nodeFor(id),
    notifyImageResults: (nodeIds, ok) => notifyImageResults(nodeIds, ok),
    notifyStylesheetResults: (url, ok) => notifyStylesheetResults(url, ok),
    getActiveElement: () => activeElement,
    getOpLog: () => ops,
    drainCdpMutations: () => {
      if (cdpMutations.length === 0) return [];
      const out = cdpMutations.slice();
      cdpMutations.length = 0;
      return out;
    },
    __ks_dispatchTrustedEvent: dispatchTrustedEvent,
    __ks_activateLabel: activateLabel,
    stampInitialNamedGlobals: stampInitialNamedGlobals,
    applyDeclarativeShadowRoots: () => applyDeclarativeShadowRoots(document),
  };

  finalizeGeneratedInterfaces(bag, CSS_TYPED_OM_WEBIDL);

  finalizeHtmlElementInterfaces();

  installFastpath(document);

  return bag;
};

/** Builds the per-navigation DOM globals and PageScript hooks over the supplied wasm DOM. */
export const buildDocument: (
  dom: DomHandle,
  opts: BuildDocumentOpts,
) => ReturnType<typeof buildDocumentBody> = buildDocumentBody;

export {
  listModelContextTools,
  stopModelContextToolWatch,
  callModelContextTool,
  cancelModelContextTool,
  setModelContextTaskScheduler,
} from "./model-context.js";
export { setControlValueAsUser } from "./user-control.js";
export { decodeHtmlBytes } from "./html-encoding.js";
export { parseUrlForNode } from "./text-encoding.js";
export {
  detachedWrapperStats,
  setWrapperSweepScheduler,
  sweepDetachedWrappers,
} from "./detached-wrappers.js";
export { setAnimationTaskScheduler } from "./animations.js";
