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

const buildDocumentBody = function buildDocument(dom: DomHandle, opts: BuildDocumentOpts) {
  initState(dom, opts.pageUrl, opts.initialCookieString, opts);
  installDetachedWrapperHooks(dom);
  installCurrentScriptHook();
  const getCurrentUrl =
    typeof opts.getCurrentUrl === "function" ? opts.getCurrentUrl : () => opts.pageUrl;
  ksState().lastMutationAt = Date.now();

  function makeNamedAccessProxy(node, localName) {
    const isForm = localName === "form";
    return new Proxy(node, {
      get(t, prop, receiver) {
        if (typeof prop === "symbol" || prop in t) {
          return Reflect.get(t, prop, receiver);
        }
        if (typeof prop !== "string" || prop === "" || prop.startsWith("__")) {
          return undefined;
        }
        try {
          if (/^\d+$/.test(prop)) {
            const list = isForm
              ? Reflect.get(t, "elements", receiver)
              : Reflect.get(t, "options", receiver);
            return list ? list[prop] : undefined;
          }
          if (isForm) {
            const m = Reflect.get(t, "namedItem", receiver);
            if (typeof m === "function") {
              return m.call(receiver, prop) ?? undefined;
            }
          }
        } catch {}
        return undefined;
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

  function nodeFor(nodeId) {
    if (nodeId == null || nodeId < 0) return null;
    const cached = liveWrapper(nodeId);
    if (cached) {
      const curSeq = ksState().mutationSeq | 0;
      if (cached._typeCheckSeq === curSeq) {
        return cached;
      }
      if (nodeId === DOCUMENT_ID) return cached;
      try {
        if (dom.parentId(nodeId) >= 0) return cached;
      } catch {}
    }
    let info;
    try {
      info = dom.nodeInfo(nodeId);
    } catch {
      evictCachedNode(nodeId);
      return null;
    }
    if (!info) {
      evictCachedNode(nodeId);
      return null;
    }
    if (cached) {
      const cachedType = cached._info && cached._info.nodeType;
      const tagStable =
        info.nodeType !== ELEMENT_NODE ||
        !cached._info ||
        cached._info.localName === info.localName;
      if (cachedType === info.nodeType && tagStable) {
        cached._info = info;
        cached._typeCheckSeq = ksState().mutationSeq | 0;
        cached._attrFlatCache = null;
        return cached;
      }
      evictCachedNode(nodeId);
    }
    let node;
    if (info.nodeType === ELEMENT_NODE) {
      if (fragmentIds.has(nodeId)) {
        node = new DocumentFragmentImpl(nodeId, info);
      } else {
        const elemNsEntry = elemNs.get(nodeId);
        const elemNsValue = elemNsEntry ? elemNsEntry.ns : HTML_NS;
        const Cls = resolveElementClass(info.localName, elemNsValue);
        node = new Cls(nodeId, info, InternalElementCtorToken);
        if (elemNsValue === HTML_NS && (info.localName === "form" || info.localName === "select")) {
          node = makeNamedAccessProxy(node, info.localName);
        }
      }
    } else if (info.nodeType === TEXT_NODE) {
      node = new TextNode(nodeId, info);
    } else if (info.nodeType === COMMENT_NODE) {
      node = new CommentNode(nodeId, info);
    } else if (info.nodeType === DOCTYPE_NODE) {
      node = new DocumentTypeNode(nodeId, info);
    } else if (info.nodeType === DOCUMENT_FRAGMENT_NODE) {
      node = mintShadowRoot(nodeId, info);
    } else {
      node = new GenericNode(nodeId, info);
    }
    node._typeCheckSeq = ksState().mutationSeq | 0;
    cache.set(nodeId, node);
    return node;
  }
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

  function installAsOwn(target: any, sourceProto: any, names: string[]) {
    if (!target || !target.prototype || !sourceProto) return;
    for (const name of names) {
      if (Object.prototype.hasOwnProperty.call(target.prototype, name)) {
        const existing = Object.getOwnPropertyDescriptor(target.prototype, name);
        if (existing && existing.enumerable === false && existing.configurable !== false) {
          try {
            Object.defineProperty(target.prototype, name, { ...existing, enumerable: true });
          } catch {}
        }
        continue;
      }
      const desc = Object.getOwnPropertyDescriptor(sourceProto, name);
      if (!desc) continue;
      try {
        const newDesc: PropertyDescriptor = {
          configurable: true,
          enumerable: true,
        };
        if (desc.get || desc.set) {
          newDesc.get = desc.get;
          newDesc.set = desc.set;
        } else {
          newDesc.value = desc.value;
          newDesc.writable = true;
        }
        Object.defineProperty(target.prototype, name, newDesc);
      } catch {}
    }
  }
  const CHILD_NODE_METHODS = ["before", "after", "replaceWith", "remove"];
  const PARENT_NODE_METHODS = ["append", "prepend", "replaceChildren"];
  for (const cls of [Element, CharacterDataNode, DocumentTypeNode]) {
    installAsOwn(cls, NodeBase.prototype, CHILD_NODE_METHODS);
  }
  for (const cls of [Element, DocumentImpl, DocumentFragmentImpl]) {
    installAsOwn(cls, NodeBase.prototype, PARENT_NODE_METHODS);
  }
  installAsOwn(HTMLElement, Element.prototype, ["click", "focus", "blur"]);

  function forceEnumerableProtoOwnProps(klass: any) {
    if (!klass || !klass.prototype) return;
    const proto = klass.prototype;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") continue;
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (!desc) continue;
      if (desc.enumerable === true) continue;
      if (desc.configurable === false) continue;
      try {
        Object.defineProperty(proto, name, { ...desc, enumerable: true });
      } catch {}
    }
  }
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
  if (!Object.prototype.hasOwnProperty.call(Element.prototype, "webkitMatchesSelector")) {
    Object.defineProperty(Element.prototype, "webkitMatchesSelector", {
      value: function (selector: string) {
        return this.matches(selector);
      },
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
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
    getOrigin: () => {
      try {
        return new URL(getCurrentUrl()).origin;
      } catch {
        return "";
      }
    },
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

  const BRANDED_NODE = { brandOps: true, brandDuck: true, brandAttrs: true };
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

  for (const name of Object.keys(
    HTML_ELEMENT_INTERFACES,
  ) as (keyof typeof HTML_ELEMENT_INTERFACES)[]) {
    finalizeInterface(HTML_ELEMENT_INTERFACES[name], idlInterfaceMeta(name, BRANDED_NODE));
  }

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
