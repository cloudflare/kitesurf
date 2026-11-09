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
  fastpathMarkSpecial,
} from "./state.js";
import { elementAttributes } from "./element/element.js";
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
// UA <select> dropdown overlay — installs ksInternals.toggleSelectDropdown
// for page-script's click default action.
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
  registerFormProxy,
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

// Members a form's named controls never override, though HTML lets them: the engine walks trees
// and reads attributes through these, so a control named parentNode would loop every ancestor
// walk. Pages do not rely on clobbering them. The form's own members (id, action, submit,
// elements, ...) stay overridable.
const ELEMENT_TREE_MEMBERS = [
  "namespaceURI",
  "prefix",
  "localName",
  "tagName",
  "attributes",
  "shadowRoot",
  "assignedSlot",
  "hasAttributes",
  "getAttributeNames",
  "getAttribute",
  "getAttributeNS",
  "setAttribute",
  "setAttributeNS",
  "removeAttribute",
  "removeAttributeNS",
  "toggleAttribute",
  "hasAttribute",
  "hasAttributeNS",
  "getAttributeNode",
  "getAttributeNodeNS",
  "setAttributeNode",
  "setAttributeNodeNS",
  "removeAttributeNode",
  "attachShadow",
  "closest",
  "matches",
  "webkitMatchesSelector",
  "getElementsByTagName",
  "getElementsByTagNameNS",
  "getElementsByClassName",
  "insertAdjacentElement",
  "insertAdjacentText",
  "insertAdjacentHTML",
  "children",
  "firstElementChild",
  "lastElementChild",
  "childElementCount",
  "previousElementSibling",
  "nextElementSibling",
  "prepend",
  "append",
  "replaceChildren",
  "moveBefore",
  "querySelector",
  "querySelectorAll",
  "before",
  "after",
  "replaceWith",
  "remove",
];
let formOwnMembers: Set<string> | null = null;
const isFormOwnMember = (name: string): boolean => {
  if (!formOwnMembers) {
    formOwnMembers = new Set([
      ...Object.getOwnPropertyNames(KsEventTarget.prototype),
      ...Object.getOwnPropertyNames(NodeBase.prototype),
      ...ELEMENT_TREE_MEMBERS,
    ]);
  }
  return formOwnMembers.has(name);
};
// A canonical array index stays the indexed getter's, ahead of a control named "0".
const isArrayIndex = (name: string): boolean =>
  /^(?:0|[1-9]\d*)$/.test(name) && Number(name) < 4294967295;

const buildDocumentBody = function buildDocument(dom: DomHandle, opts: BuildDocumentOpts) {
  initState(dom, opts.pageUrl, opts.initialCookieString, opts);
  installDetachedWrapperHooks(dom);
  installCurrentScriptHook();
  const getCurrentUrl =
    typeof opts.getCurrentUrl === "function" ? opts.getCurrentUrl : () => opts.pageUrl;
  ksState().lastMutationAt = Date.now();

  function makeNamedAccessProxy(node: Element, localName: string) {
    const isForm = localName === "form";
    // HTMLFormElement is [LegacyOverrideBuiltIns]: a listed control's id or name reads ahead of
    // the form's own members, so form.id can be an <input name="id">. Indices, tree members and
    // names starting with "_" stay ours. The fast path reads id from the tree, so it skips forms.
    // https://html.spec.whatwg.org/#the-form-element
    let namesSeq = -1;
    let names = new Set<string>();
    let resolving = false;
    const supportedNames = (t: Element, receiver: unknown): Set<string> => {
      const seq = ksState().mutationSeq | 0;
      if (seq === namesSeq) return names;
      const next = new Set<string>();
      const list: unknown = Reflect.get(t, "elements", receiver);
      const len = Number(Reflect.get(Object(list), "length")) || 0;
      for (let i = 0; i < len; i++) {
        const el: unknown = Reflect.get(Object(list), i);
        if (!(el instanceof Element)) continue;
        const id = elementAttributes.get.call(el, "id");
        if (id) next.add(id);
        const name = elementAttributes.get.call(el, "name");
        if (name) next.add(name);
      }
      names = next;
      namesSeq = seq;
      return names;
    };
    // The control or RadioNodeList a supported name reads, else undefined.
    const namedOverride = (t: Element, prop: string, receiver: unknown): unknown => {
      if (resolving || prop === "" || prop[0] === "_") return undefined;
      if (isArrayIndex(prop) || isFormOwnMember(prop)) return undefined;
      resolving = true;
      try {
        if (!supportedNames(t, receiver).has(prop)) return undefined;
        const m: unknown = Reflect.get(t, "namedItem", receiver);
        if (typeof m !== "function") return undefined;
        const named: unknown = m.call(receiver, prop);
        return named ?? undefined;
      } catch {
        return undefined;
      } finally {
        resolving = false;
      }
    };
    if (isForm) fastpathMarkSpecial(node._id);
    const proxy = new Proxy(node, {
      get(t, prop, receiver) {
        if (isForm && typeof prop === "string") {
          const named = namedOverride(t, prop, receiver);
          if (named !== undefined) return named;
        }
        if (typeof prop === "symbol" || prop in t) {
          return Reflect.get(t, prop, receiver);
        }
        if (typeof prop !== "string" || prop === "" || prop.startsWith("__")) {
          return undefined;
        }
        try {
          if (/^\d+$/.test(prop)) {
            const list: unknown = isForm
              ? Reflect.get(t, "elements", receiver)
              : Reflect.get(t, "options", receiver);
            // elements and options are collection objects.
            return list ? (Reflect.get(Object(list), prop) as unknown) : undefined;
          }
          if (isForm) {
            const m: unknown = Reflect.get(t, "namedItem", receiver);
            if (typeof m === "function") {
              const named: unknown = m.call(receiver, prop);
              return named ?? undefined;
            }
          }
        } catch {}
        return undefined;
      },
    });
    if (isForm) registerFormProxy(proxy, node);
    return proxy;
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

  function nodeFor(nodeId: number): NodeBase | null {
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
    // Map.prototype.get on the wrapper cache.
    const cached: NodeBase | undefined = peekApply(peekMapGet, cache, [nodeId]);
    if (!cached) return null;
    const stamp = peekGopd(cached, "_typeCheckSeq");
    if (!stamp || !peekApply(peekHasOwn, stamp, ["value"])) return null;
    return stamp.value === (ksState().mutationSeq | 0) ? cached : null;
  });

  const DOCUMENT_ID = dom.documentNodeId();

  installIdlHandlersOn(DocumentImpl.prototype);

  // An interface class: what these helpers read off it.
  type InterfaceClass = { readonly prototype: object };
  function installAsOwn(
    target: InterfaceClass | null | undefined,
    sourceProto: object | null | undefined,
    names: string[],
  ) {
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

  function forceEnumerableProtoOwnProps(klass: InterfaceClass | null | undefined) {
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

  const { window, Window } = installWindow(document);

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
    setReadyState: (s: unknown) => {
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
    setCookieString: (s: string) => {
      setCookieString(s);
    },
    nodeFor: (id: number) => nodeFor(id),
    notifyImageResults: (nodeIds: Iterable<unknown> | null | undefined, ok: boolean) =>
      notifyImageResults(nodeIds, ok),
    notifyStylesheetResults: (url: string, ok: boolean) => notifyStylesheetResults(url, ok),
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
export { setInlineHandlerGate } from "./element/event-handlers.js";
