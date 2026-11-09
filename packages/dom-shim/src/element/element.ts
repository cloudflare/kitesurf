// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements Element attributes, queries, geometry, style, scrolling, and focus behavior.

import type { KsAttributeNamespace } from "../../../core/pkg/kitesurf_core";
import type { WrapperInfo } from "../node-base.js";
import type * as Idl from "../idl/types.generated.js";
import { makeStyleDeclaration, type StyleDeclarationBackend } from "../style-declaration.js";
import type { EventHandlerName } from "../event-handler-names.js";
import type { AttrCls as AttrImpl, DOMTokenListCls, DocumentFragmentImpl } from "../collections.js";
import {
  makeDOMTokenList,
  dom,
  makeStyleSheetStub,
  ksGlobal,
  cdpMutations,
  fastpathMarkSpecial,
  AttrCls,
  makeNamedNodeMap,
  createElementInternal,
  elementDocument,
  makeHtmlCollection,
  nodeFor,
  elementFor,
  isElementNode,
  isFragmentNode,
  scopedQuerySelector,
  scopedQuerySelectorAll,
  filterByQualifiedName,
  windowObj,
  liveWindow,
  getStickyShiftByAuthId,
  getOffsetMetricsByAuthId,
  opts,
  pageUrl,
  activeElement,
  setActiveElement,
} from "../state.js";
import { parseUrlForNode } from "../text-encoding.js";
import { recordOp, recordCdpMutation } from "../record.js";
import { ksSpan } from "../otel.js";
import { animateElement, animationsFor, type KsAnimation } from "../animations.js";
import {
  nodeScrollInfoSafe,
  fireElementScroll,
  scrollOffset,
  setScrollOffset,
} from "../layout/scroll.js";
import { hasLayoutBox, getRect } from "../layout/cheap.js";
import { isToolFormActive, isToolSubmitActive } from "../model-context.js";
import { maybeScheduleSlotchange } from "../events/slotchange.js";
import { dispatchTrustedEvent } from "../events/dispatch.js";
import {
  installConnectedNamedGlobals,
  namedGlobalIdOf,
  syncNamedGlobals,
  updateNamedGlobal,
} from "../window.js";
import {
  focusForwardedTextControl,
  forwardedClickFrom,
  labelControlFor,
  type ForwardedClick,
} from "./forms/label-activation.js";
import { runIteratorPreRemove } from "../traversal.js";
import {
  formState,
  elemNs,
  xmlOwned,
  classListCache,
  relListCache,
  htmlForCache,
  sandboxCache,
  sizesCache,
  attrNs,
  attrInstances,
  childrenCache,
} from "../registries.js";
import { getInternalState } from "../internal-state.js";
import {
  REL_SUPPORTED,
  SANDBOX_SUPPORTED,
  ELEMENT_NODE,
  HTML_NS,
  SVG_NS,
  MATHML_NS,
  DEFAULT_VIEWPORT_HEIGHT_CSS_PX,
  DEFAULT_VIEWPORT_WIDTH_CSS_PX,
  MAX_SCROLL_CHAIN_HOPS,
  GET_COMPUTED_STYLE_INTERNAL,
} from "../constants.js";
import {
  asciiLowercase,
  cssEscape,
  parseCssTextInto,
  cssPropCamelToKebab,
  cssPropToCamel,
  serializeStyleData,
  styleDeclKey,
  camelToDash,
} from "../util/strings.js";
import { validateAttrName, XML_NS, XMLNS_NS } from "../util/validation.js";
import { normalizeScrollArgs } from "../util/scroll-args.js";
import { bumpMutationSeq, markDamageNode } from "../mutations/seq.js";
import {
  mutationObserverCount,
  recordAttributeMutation,
  hasChildListObserver,
  hasSubtreeObserver,
  registerTransientObservers,
  recordChildListMutation,
} from "../mutations/observer.js";
import { KsPointerEvent, KsInputEvent, KsEvent, KsFocusEvent } from "../events/event.js";
import type { KsMouseEvent } from "../events/event.js";
import {
  NodeBase,
  isTemplateElement,
  ensureTemplateContent,
  subtreeHasCachedWrapper,
  dropUnwrappedSubtree,
  dropUnwrappedSubtrees,
} from "../node-base.js";
import type { DetachedDocument } from "../document.js";
import type { HTMLFormElement } from "./forms/form.js";
import { StylePropertyMap, makeComputedStyleMap } from "../css-typed-om.js";
import { makeDomRect, makeDomRectList } from "./rect.js";
import { idlEventHandlerNameSet, installAttrEventHandler } from "./event-handlers.js";
import {
  inputTypeOf,
  ksAttrNeedsResanitize,
  ksHandleInputTypeChange,
  ksResanitizeInputValue,
  ksPushInputText,
} from "./forms/input-state.js";
import { ksInternals } from "../internals.js";

const attributeStyleMaps = new WeakMap<object, StylePropertyMap>();
const computedStyleMaps = new WeakMap<object, ReturnType<typeof makeComputedStyleMap>>();
const inlineStyleResync = new WeakMap<object, (text: string | null) => void>();
const inlineStyleProxies = new WeakMap<object, ReturnType<typeof makeStyleDeclaration>>();
const longhandKeysCache = new Map<string, string[]>();
type PseudoElementStub = { readonly type: string; readonly element: Element };
type OffsetMetrics = { parent?: unknown; top: number; left?: unknown };

function hasOffsetTop(value: unknown): value is OffsetMetrics {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof Reflect.get(value, "top") === "number"
  );
}

function ksState() {
  return getInternalState();
}

// Replaces el's parsed namespace entries with `parsed`, read from wasm with the attribute list
// it describes. _attrFlat calls it on each refresh only, so a cached list's entries stay as
// synced; entries set by setAttributeNS (not parsed) win over parsed ones.
function syncParsedAttributeNamespaces(
  el: { _id: number },
  parsed: readonly KsAttributeNamespace[] | undefined,
): void {
  const entries = parsed?.length ? parsed : undefined;
  let nsMap = attrNs.get(el._id);
  if (!nsMap && entries === undefined) return;
  if (nsMap) {
    for (const [name, info] of nsMap) {
      if (info.parsed) nsMap.delete(name);
    }
    if (nsMap.size === 0) {
      attrNs.delete(el._id);
      nsMap = undefined;
    }
  }
  if (entries === undefined) return;
  if (!nsMap) {
    nsMap = new Map();
    attrNs.set(el._id, nsMap);
  }
  for (const info of entries) {
    const existing = nsMap.get(info.qualifiedName);
    if (existing && !existing.parsed) continue;
    nsMap.set(info.qualifiedName, {
      ns: info.namespaceURI,
      prefix: info.prefix ?? null,
      localName: info.localName,
      qname: info.qualifiedName,
      parsed: true,
    });
  }
  fastpathMarkSpecial(el._id);
}

// The attribute list of every attribute-less element; never mutated (frozen to keep it so).
const NO_ATTRIBUTES: string[] = [];
Object.freeze(NO_ATTRIBUTES);

function getFormState(id: number) {
  let s = formState.get(id);
  if (!s) {
    s = {};
    formState.set(id, s);
  }
  return s;
}

function reflectedTokenList(
  el: Element,
  cache: WeakMap<object, DOMTokenListCls>,
  attrName: string,
  supportedTokens?: ReadonlySet<string>,
) {
  const cached = cache.get(el);
  if (cached) return cached;
  const list = makeDOMTokenList(
    () => (el.hasAttribute(attrName) ? el.getAttribute(attrName) || "" : null),
    (next: string) => el.setAttribute(attrName, next),
    supportedTokens,
  );
  cache.set(el, list);
  return list;
}

function syncCheckedFromAttrs(root: { _id: number }): void {
  if (!root || typeof root._id !== "number") return;
  let inputs: Iterable<number>;
  let checked: Set<number>;
  try {
    inputs = dom.querySelectorAllInSubtree(root._id, "input[type=checkbox], input[type=radio]");
    checked = new Set(
      dom.querySelectorAllInSubtree(
        root._id,
        "input[type=checkbox][checked], input[type=radio][checked]",
      ),
    );
  } catch {
    return;
  }
  for (const id of inputs) {
    try {
      dom.setCheckboxChecked(id, checked.has(id));
    } catch {}
  }
}

function demandSvgTextOutlines(html: string, contextNs: string | null) {
  if (
    html.length !== 0 &&
    /<text[\s/>]/i.test(html) &&
    (/<svg[\s/>]/i.test(html) || contextNs === SVG_NS)
  ) {
    try {
      ksInternals.demandFontOutlines?.();
    } catch {}
  }
}

export function parseFragmentInContext(
  fragment: { _id: number },
  ns: string | null,
  localName: string,
  html: string,
): void {
  demandSvgTextOutlines(html, ns);
  const contextId = dom.createElementNS(ns ?? "", localName);
  recordOp({ kind: "setInnerHtml", node: contextId, html });
  const kids = Array.from(dom.childIds(contextId));
  for (const kid of kids) {
    dom.removeNode(kid);
    dom.appendChildNode(fragment._id, kid);
  }
  dom.dropNode(contextId);
  if (kids.length > 0) bumpMutationSeq();
  syncCheckedFromAttrs(fragment);
}

// Bind on first use. The `dom` binding is null until initState runs.
// Older wasm builds do not have these methods, so callers use recordOp instead.
let domSetAttr: ((nodeId: number, name: string, value: string) => boolean) | null = null;
let domRemoveAttr: ((nodeId: number, name: string) => boolean) | null = null;
let domAttrFnsBound = false;
function ensureDomAttrFns() {
  if (domAttrFnsBound) return;
  domAttrFnsBound = true;
  domSetAttr = dom.setAttribute.bind(dom);
  domRemoveAttr = dom.removeAttribute.bind(dom);
}

type CheckVisibilityOptions = {
  checkOpacity?: boolean;
  opacityProperty?: boolean;
  checkVisibilityCSS?: boolean;
  visibilityProperty?: boolean;
};
function flatTreeParentElement(el: Element): Element | null {
  const slot = el.assignedSlot;
  if (slot instanceof Element) return slot;
  const parent: unknown = el.parentElement;
  if (parent instanceof Element) return parent;
  const host: unknown = el.parentNode ? Reflect.get(el.parentNode, "host") : null;
  return host instanceof Element ? host : null;
}

const SVG_GEOMETRY_STYLE_PROPS = new Set(["cx", "cy", "r", "rx", "ry", "x", "y"]);

const PSEUDO_CACHE_MAX = 1024;
const pseudoElementCache = new Map<string, PseudoElementStub>();
function pseudoCachePut(key: string, value: PseudoElementStub): void {
  if (pseudoElementCache.size >= PSEUDO_CACHE_MAX) {
    const oldest = pseudoElementCache.keys().next();
    if (!oldest.done) pseudoElementCache.delete(oldest.value);
  }
  pseudoElementCache.set(key, value);
}

function setElementScrollOffset(nodeId: number, left: number, top: number) {
  // An element with no layout box has no scroll range, so a write would clamp
  // the offset it keeps while hidden to zero.
  if (nodeScrollInfoSafe(nodeId)?.hasBox === false) return false;
  let offset: unknown = null;
  try {
    offset = dom.setNodeScrollOffset(nodeId, left, top);
  } catch {
    return false;
  }
  if (!offset) return false;
  markDamageNode(nodeId);
  bumpMutationSeq();
  try {
    const el = elementFor(nodeId);
    if (el) fireElementScroll(el);
  } catch {}
  return true;
}

type AriaReflection = Extract<keyof Idl.Element, `aria${string}` | "role">;
type EventHandlerAttributes = {
  [K in EventHandlerName]: K extends keyof Idl.HTMLBodyElement
    ? Idl.HTMLBodyElement[K]
    : Idl.EventHandler;
};
interface InstalledElementMembers
  extends
    Pick<Idl.Element, AriaReflection | "shadowRoot" | "webkitMatchesSelector" | "assignedSlot">,
    EventHandlerAttributes {}
interface Element extends InstalledElementMembers {}

// Per-interface steps that Element's own algorithms call, so an interface module overrides them
// instead of element.ts testing for its class (MODULES.md "Initialization dependencies"). Symbol
// keys keep them off the page-visible names a page's own subclass might use.
export const attributeChangeSteps = Symbol("kitesurf.attributeChangeSteps");
export const activationBehavior = Symbol("kitesurf.activationBehavior");

// The forwarded click runs this same algorithm directly, not a page-replaceable control.click().
// Forwarding data stays on the call stack so reentrant or later scripted clicks cannot inherit it.
function runClickSteps(el: Element, forwarded: ForwardedClick | null): void {
  const tag = (el.nodeName || "").toUpperCase();
  const type = tag === "INPUT" ? String(el.type || "").toLowerCase() : "";
  const isCheckable = tag === "INPUT" && (type === "checkbox" || type === "radio");

  // Disabled controls skip click. Limitation: a disabled fieldset ancestor does not.
  if (el.disabled === true) {
    return;
  }

  const setCheckedRaw = (val: boolean | undefined) => {
    let proto = Object.getPrototypeOf(el);
    while (proto) {
      const desc = Object.getOwnPropertyDescriptor(proto, "checked");
      if (desc && typeof desc.set === "function") {
        desc.set.call(el, val);
        return;
      }
      proto = Object.getPrototypeOf(proto);
    }
    el.checked = val;
  };

  let preChecked;
  let preIndeterminate;
  // Legacy pre-activation sets the checked state before dispatch; cancel restores it.
  // Limitation: radios also clear indeterminate, and cancel does not restore
  // the radio that was checked before the click.
  // https://html.spec.whatwg.org/#the-input-element
  if (isCheckable) {
    preChecked = !!el.checked;
    preIndeterminate = !!Reflect.get(el, "indeterminate");
    setCheckedRaw(type === "checkbox" ? !preChecked : true);
    Reflect.set(el, "indeterminate", false);
  }

  // A click not caused by a pointing device has pointerId -1 and no pointerType.
  // https://w3c.github.io/pointerevents/#click-auxclick-and-contextmenu
  const ev = new KsPointerEvent("click", {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: -1,
    pointerType: "",
    ...(forwarded ? forwarded.init : {}),
  });
  if (forwarded && forwarded.trusted) dispatchTrustedEvent(el, ev);
  else el.dispatchEvent(ev);

  if (isCheckable) {
    if (ev.defaultPrevented) {
      setCheckedRaw(preChecked);
      Reflect.set(el, "indeterminate", preIndeterminate);
      return;
    }
    // Activation fires input and then change, only while connected.
    // Limitation: HTML also sets composed on input.
    // https://html.spec.whatwg.org/#checkbox-state-(type=checkbox)
    if (el.isConnected) {
      try {
        dispatchTrustedEvent(el, new KsInputEvent("input", { bubbles: true, cancelable: false }));
      } catch {}
      try {
        dispatchTrustedEvent(el, new KsEvent("change", { bubbles: true, cancelable: false }));
      } catch {}
    }
  }

  if (!ev.defaultPrevented && tag === "A") {
    const rawHref = el.getAttribute && el.getAttribute("href");
    if (typeof rawHref === "string" && rawHref.length > 0) {
      try {
        if (windowObj && windowObj.location) {
          windowObj.location.href = rawHref;
        }
      } catch {}
    }
  }

  if (!ev.defaultPrevented) el[activationBehavior]();

  // Only the first summary child toggles its details. Limitation: HTML queues a
  // ToggleEvent after the open attribute changes; this fires a plain event at once.
  // https://html.spec.whatwg.org/#the-summary-element
  if (!ev.defaultPrevented) {
    let summaryEl: NodeBase | DetachedDocument | null = el;
    while (
      summaryEl &&
      summaryEl.nodeType === ELEMENT_NODE &&
      (summaryEl.nodeName || "").toUpperCase() !== "SUMMARY"
    )
      summaryEl = summaryEl.parentNode;
    const details =
      summaryEl && (summaryEl.nodeName || "").toUpperCase() === "SUMMARY"
        ? summaryEl.parentNode
        : null;
    if (details && (details.nodeName || "").toUpperCase() === "DETAILS") {
      // A DETAILS nodeName identifies an element wrapper; NodeBase types parentNode broadly.
      const detailsElement = details as Element;
      let firstSummary: NodeBase | null = null;
      const kids: ArrayLike<NodeBase> = detailsElement.childNodes || [];
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i];
        if (c && (c.nodeName || "").toUpperCase() === "SUMMARY") {
          firstSummary = c;
          break;
        }
      }
      if (firstSummary === summaryEl) {
        if (detailsElement.hasAttribute("open")) detailsElement.removeAttribute("open");
        else detailsElement.setAttribute("open", "");
        try {
          dispatchTrustedEvent(
            detailsElement,
            new KsEvent("toggle", { bubbles: false, cancelable: false }),
          );
        } catch {}
      }
    }
  }
  if (!ev.defaultPrevented) activateLabel(el);
}

// PageScript receives this function in buildDocument's private result, not on the page global.
export function activateLabel(target: unknown, original: KsMouseEvent | null = null): void {
  const control = labelControlFor(target);
  if (!control) return;
  runClickSteps(control, forwardedClickFrom(original));
  focusForwardedTextControl(control);
}

class Element extends NodeBase implements Idl.Element {
  static [Symbol.hasInstance](v: unknown): boolean {
    if (v == null) return false;
    if (this.prototype.isPrototypeOf(v)) return true;
    // ParsedDocument wrappers use this marker instead of the Element prototype.
    if (this === Element && (v as { __ks_isParsedElement?: unknown }).__ks_isParsedElement === true)
      return true;
    return false;
  }
  declare _attrFlatCache: string[] | null;
  declare _attrFlatCacheSeq: number;
  declare _typeCheckSeq: number;
  // Set on the documentElement wrapper once document.documentElement has
  // stamped the viewport-sized client and scroll getters on it.
  declare rootStamped?: true;
  get form(): HTMLFormElement | null {
    return null;
  }
  set form(_v: HTMLFormElement | null) {}
  // Runs after setAttribute or removeAttribute changes an attribute of an HTML element; value is
  // null for a removal. Limitation: the other attribute mutation paths do not run it.
  // https://dom.spec.whatwg.org/#concept-element-attributes-change-ext
  [attributeChangeSteps](_localName: string, _value: string | null): void {}
  // Runs after a click() dispatch nobody canceled. Limitation: click() itself still runs the
  // checkbox, anchor, summary and label steps.
  // https://dom.spec.whatwg.org/#eventtarget-activation-behavior
  [activationBehavior](): void {}
  constructor(nodeId: number, info: WrapperInfo) {
    super(nodeId, info);
    this._attrFlatCache = null;
  }
  get tagName() {
    const ns = elemNs.get(this._id);
    const isXmlDoc = xmlOwned.has(this._id);
    if (ns) {
      if (isXmlDoc || ns.ns !== HTML_NS) {
        return ns.qname;
      }
      return ns.qname.replace(/[a-z]/g, (c) => c.toUpperCase());
    }
    return this._info.nodeName;
  }
  get nodeName() {
    return this.tagName;
  }
  get localName() {
    const ns = elemNs.get(this._id);
    if (ns) {
      // createElement keeps a colon in the name; only createElementNS uses a prefix.
      // https://dom.spec.whatwg.org/#dom-document-createelement
      if (ns.viaNS === false) return ns.qname;
      const colon = ns.qname.indexOf(":");
      return colon >= 0 ? ns.qname.slice(colon + 1) : ns.qname;
    }
    return this._info.localName || "";
  }
  get namespaceURI() {
    const wasmNs = this._info?.namespaceURI;
    if (typeof wasmNs === "string" && wasmNs) return wasmNs;
    const entry = elemNs.get(this._id);
    if (entry !== undefined && entry.ns == null) {
      const liveName = String(this._info?.nodeName || "").toLowerCase();
      const qname = entry.qname.toLowerCase();
      const colon = qname.indexOf(":");
      const local = colon >= 0 ? qname.slice(colon + 1) : qname;
      if (!liveName || liveName === qname || liveName === local) {
        return entry.ns;
      }
    }
    return HTML_NS;
  }
  get prefix() {
    const entry = elemNs.get(this._id);
    if (!entry) return null;
    if (entry.viaNS === false) return null;
    const colon = entry.qname.indexOf(":");
    return colon >= 0 ? entry.qname.slice(0, colon) : null;
  }
  get id() {
    return this.getAttribute("id") || "";
  }
  set id(value) {
    this.setAttribute("id", String(value));
  }
  get className() {
    return this.getAttribute("class") || "";
  }
  set className(value) {
    this.setAttribute("class", String(value));
  }
  get sheet(): Idl.CSSStyleSheet | null {
    const tag = this.tagName;
    if (tag === "STYLE") {
      return makeStyleSheetStub(this);
    }
    if (tag === "LINK") {
      const rel = (this.getAttribute("rel") || "").toLowerCase();
      if (rel.split(/\s+/).includes("stylesheet")) {
        return makeStyleSheetStub(this);
      }
    }
    return null;
  }

  _attrFlat(): string[] {
    const curSeqEarly = ksState().attrSeq | 0;
    if (this._attrFlatCache !== null && this._attrFlatCacheSeq === curSeqEarly) {
      return this._attrFlatCache;
    }
    this._attrFlatCache = null;
    // attributeList, not nodeInfo: _info stays the identity record nodeFor shares between
    // elements of one name, rather than a full per-element record.
    try {
      const fresh = dom.attributeList(this._id);
      const arr = fresh?.attributes ?? NO_ATTRIBUTES;
      this._attrFlatCache = arr;
      this._attrFlatCacheSeq = curSeqEarly;
      if (fresh) syncParsedAttributeNamespaces(this, fresh.attributeNamespaces);
      return arr;
    } catch {
      return NO_ATTRIBUTES;
    }
  }

  get classList() {
    const cached = classListCache.get(this);
    if (cached) return cached;
    const list = makeDOMTokenList(
      () => (this.hasAttribute("class") ? this.getAttribute("class") || "" : null),
      (next: string) => this.setAttribute("class", next),
    );
    classListCache.set(this, list);
    return list;
  }
  set classList(v) {
    this.setAttribute("class", String(v));
  }

  get relList(): Idl.DOMTokenList | undefined {
    const ns = this.namespaceURI;
    const local = this.localName;
    const isHtml = ns === HTML_NS;
    const isSvg = ns === SVG_NS;
    const isMathMl = ns === MATHML_NS;
    const ok =
      (isHtml && (local === "a" || local === "area" || local === "link")) ||
      ((isSvg || isMathMl) && local === "a");
    if (!ok) return undefined;
    return reflectedTokenList(this, relListCache, "rel", REL_SUPPORTED);
  }
  set relList(v) {
    if (this.relList === undefined) return;
    this.setAttribute("rel", String(v));
  }

  get htmlFor(): Idl.DOMTokenList | string | undefined {
    if (this.namespaceURI !== HTML_NS) return undefined;
    if (this.localName !== "output") return undefined;
    return reflectedTokenList(this, htmlForCache, "for");
  }
  set htmlFor(v) {
    if (this.htmlFor === undefined) return;
    this.setAttribute("for", String(v));
  }

  get sandbox(): Idl.DOMTokenList | undefined {
    if (this.namespaceURI !== HTML_NS) return undefined;
    if (this.localName !== "iframe") return undefined;
    return reflectedTokenList(this, sandboxCache, "sandbox", SANDBOX_SUPPORTED);
  }
  set sandbox(v) {
    if (this.sandbox === undefined) return;
    this.setAttribute("sandbox", String(v));
  }

  get sizes(): Idl.DOMTokenList | string | undefined {
    if (this.namespaceURI !== HTML_NS) return undefined;
    if (this.localName !== "link") return undefined;
    return reflectedTokenList(this, sizesCache, "sizes");
  }
  set sizes(v) {
    if (this.sizes === undefined) return;
    this.setAttribute("sizes", String(v));
  }

  getAttribute(name: string) {
    if (typeof name !== "string") return null;
    // Only an HTML element lowercases the name. The namespace is read only
    // for a name that lowercasing would change, which keeps this path cheap.
    // Limitation: the document is not checked to be an HTML document.
    // https://dom.spec.whatwg.org/#dom-element-getattribute
    const lower = asciiLowercase(name);
    const lookup = lower === name || this.namespaceURI === HTML_NS ? lower : name;
    const flat = this._attrFlat();
    const nsMap = attrNs.get(this._id);
    for (let i = 0; i < flat.length; i += 2) {
      const wasmKey = flat[i];
      let exposed = wasmKey;
      if (nsMap) {
        const info = nsMap.get(wasmKey);
        if (info && info.qname) exposed = info.qname;
      }
      if (exposed === lookup) return flat[i + 1];
    }
    return null;
  }
  hasAttribute(name: string) {
    // The captured getter, not this.getAttribute: a page override must not answer for it.
    return elementAttributes.get.call(this, name) !== null;
  }
  hasAttributes() {
    return this._attrFlat().length > 0;
  }
  setAttribute(name: string, value: string | Idl.TrustedType) {
    const nm = String(name ?? "");
    validateAttrName(nm);
    const isHtmlElement = this.namespaceURI === HTML_NS;
    const finalName = isHtmlElement ? asciiLowercase(nm) : nm;
    const customAttributeHook =
      ksInternals.customElementObservesAttribute?.(this, finalName) &&
      typeof ksInternals.notifyCustomElementAttributeChanged === "function"
        ? ksInternals.notifyCustomElementAttributeChanged
        : null;
    const oldValue =
      mutationObserverCount() === 0 && !customAttributeHook ? null : this.getAttribute(finalName);
    const needsResanitize = ksAttrNeedsResanitize(this, finalName);
    const oldInputType = needsResanitize && finalName === "type" ? inputTypeOf(this) : null;
    this._attrFlatCache = null;
    const strValue = String(value);
    ensureDomAttrFns();
    if (domSetAttr) {
      // The old name has to be read before the write; the deferred path updates it in recordOp.
      const previousId = finalName === "id" ? namedGlobalIdOf(this._id) : null;
      if (domSetAttr(this._id, finalName, strValue)) {
        bumpMutationSeq({ attribute: finalName, node: this._id });
        if (finalName === "id") updateNamedGlobal(previousId, strValue);
        if (ksInternals.cdpDomActive) {
          cdpMutations.push({
            kind: "attributeModified",
            nodeId: this._id,
            name: finalName,
            value: strValue,
          });
        }
      }
    } else {
      recordOp({
        kind: "setAttribute",
        node: this._id,
        name: finalName,
        value: strValue,
      });
    }
    recordAttributeMutation(this._id, finalName, null, oldValue);
    if (customAttributeHook) {
      customAttributeHook(this, finalName, oldValue, strValue, null);
    }
    if (finalName === "style") {
      const resync = inlineStyleResync.get(this);
      if (resync) resync(strValue);
    }
    if (finalName === "slot") {
      try {
        maybeScheduleSlotchange(dom.parentId(this._id));
      } catch {}
    } else if (finalName === "name") {
      maybeScheduleSlotchange(this._id);
    }
    if (
      isHtmlElement &&
      (finalName === "src" || finalName === "srcdoc") &&
      this.localName === "iframe" &&
      this.isConnected
    ) {
      const iframeSrcHook = getInternalState().afterIframeSrcChange;
      if (typeof iframeSrcHook === "function") {
        try {
          iframeSrcHook(this);
        } catch {}
      }
    }
    if (isHtmlElement) this[attributeChangeSteps](finalName, strValue);
    if (
      finalName.length > 2 &&
      finalName.charCodeAt(0) === 111 &&
      finalName.charCodeAt(1) === 110 &&
      idlEventHandlerNameSet.has(finalName)
    ) {
      installAttrEventHandler(this, finalName, strValue);
    }
    if (needsResanitize) {
      if (oldInputType != null) ksHandleInputTypeChange(this, oldInputType);
      else ksResanitizeInputValue(this);
    }
  }
  removeAttribute(name: string) {
    if (typeof name !== "string" || name.length === 0) return;
    const elNs = elemNs.get(this._id);
    const isHtmlElement = !elNs || elNs.ns === HTML_NS;
    const lookup = isHtmlElement ? asciiLowercase(name) : name;
    const customAttributeHook =
      ksInternals.customElementObservesAttribute?.(this, lookup) &&
      typeof ksInternals.notifyCustomElementAttributeChanged === "function"
        ? ksInternals.notifyCustomElementAttributeChanged
        : null;
    const flat = this._attrFlat();
    const nsMap = attrNs.get(this._id);
    let wasmKey: string | null = null;
    for (let i = 0; i < flat.length; i += 2) {
      const k = flat[i];
      let exposed = k;
      if (nsMap) {
        const info = nsMap.get(k);
        if (info && info.qname) exposed = info.qname;
      }
      if (exposed === lookup) {
        wasmKey = k;
        break;
      }
    }
    if (wasmKey === null) return;
    const needsResanitize = ksAttrNeedsResanitize(this, lookup);
    const oldInputType = needsResanitize && lookup === "type" ? inputTypeOf(this) : null;
    const cache = attrInstances.get(this);
    if (cache) {
      const attr = cache.get(wasmKey);
      if (attr) {
        attr._ownerElement = null;
        cache.delete(wasmKey);
      }
    }
    const removingNs = nsMap && nsMap.get(wasmKey);
    const oldValue =
      mutationObserverCount() === 0 && !customAttributeHook
        ? null
        : (() => {
            const flat2 = this._attrFlat();
            for (let j = 0; j < flat2.length; j += 2) {
              if (flat2[j] === wasmKey) return flat2[j + 1];
            }
            return null;
          })();
    if (nsMap) nsMap.delete(wasmKey);
    this._attrFlatCache = null;
    ensureDomAttrFns();
    if (domRemoveAttr) {
      const previousId = wasmKey === "id" ? namedGlobalIdOf(this._id) : null;
      if (domRemoveAttr(this._id, wasmKey)) {
        bumpMutationSeq({ attribute: wasmKey, node: this._id });
        if (wasmKey === "id") updateNamedGlobal(previousId, null);
        if (ksInternals.cdpDomActive) {
          cdpMutations.push({
            kind: "attributeRemoved",
            nodeId: this._id,
            name: wasmKey,
          });
        }
      }
    } else {
      recordOp({
        kind: "removeAttribute",
        node: this._id,
        name: wasmKey,
      });
    }
    const exposedName = removingNs ? removingNs.qname : lookup;
    const exposedNs = removingNs ? removingNs.ns : null;
    recordAttributeMutation(this._id, exposedName, exposedNs, oldValue);
    if (customAttributeHook) {
      customAttributeHook(
        this,
        removingNs ? removingNs.localName : lookup,
        oldValue,
        null,
        exposedNs,
      );
    }
    if (exposedName === "style") {
      const resync = inlineStyleResync.get(this);
      if (resync) resync(null);
    }
    if (
      isHtmlElement &&
      (lookup === "src" || lookup === "srcdoc") &&
      this.localName === "iframe" &&
      this.isConnected
    ) {
      const iframeSrcHook = getInternalState().afterIframeSrcChange;
      if (typeof iframeSrcHook === "function") {
        try {
          iframeSrcHook(this);
        } catch {}
      }
    }
    if (isHtmlElement) this[attributeChangeSteps](lookup, null);
    if (lookup === "slot") {
      try {
        maybeScheduleSlotchange(dom.parentId(this._id));
      } catch {}
    } else if (lookup === "name") {
      maybeScheduleSlotchange(this._id);
    }
    if (needsResanitize) {
      if (oldInputType != null) ksHandleInputTypeChange(this, oldInputType);
      else ksResanitizeInputValue(this);
    }
  }
  toggleAttribute(name: string, force?: boolean) {
    validateAttrName(String(name ?? ""));
    const lower = asciiLowercase(String(name));
    const has = this.getAttribute(lower) !== null;
    if (force === true) {
      if (!has) this.setAttribute(lower, "");
      return true;
    }
    if (force === false) {
      if (has) this.removeAttribute(lower);
      return false;
    }
    if (has) {
      this.removeAttribute(lower);
      return false;
    }
    this.setAttribute(lower, "");
    return true;
  }
  setAttributeNS(namespace: string | null, qualifiedName: string, value: string | Idl.TrustedType) {
    // Limitation: DOM splits at the first colon, so "a:b:c" is valid there.
    // This rejects it.
    // https://dom.spec.whatwg.org/#validate-and-extract
    const qn = String(qualifiedName ?? "");
    validateAttrName(qn);
    const colonCount = (qn.match(/:/g) || []).length;
    if (colonCount > 0) {
      const ci = qn.indexOf(":");
      if (colonCount > 1 || ci === 0 || ci === qn.length - 1) {
        throw new DOMException(
          "'" + qn + "' is not a valid qualified attribute name",
          "InvalidCharacterError",
        );
      }
    }
    qualifiedName = qn;
    const ns = namespace ? String(namespace) : null;
    const colon = qualifiedName.indexOf(":");
    const prefix = colon >= 0 ? qualifiedName.slice(0, colon) : null;
    const localName = colon >= 0 ? qualifiedName.slice(colon + 1) : qualifiedName;
    const customAttributeHook =
      ksInternals.customElementObservesAttribute?.(this, localName) &&
      typeof ksInternals.notifyCustomElementAttributeChanged === "function"
        ? ksInternals.notifyCustomElementAttributeChanged
        : null;
    if (prefix && !ns) {
      throw new DOMException(
        "setAttributeNS: prefix '" + prefix + "' requires a non-null namespace",
        "NamespaceError",
      );
    }
    if (prefix === "xml" && ns !== XML_NS) {
      throw new DOMException(
        "setAttributeNS: 'xml' prefix is reserved for the XML namespace",
        "NamespaceError",
      );
    }
    if ((qualifiedName === "xmlns" || prefix === "xmlns") && ns !== XMLNS_NS) {
      throw new DOMException(
        "setAttributeNS: 'xmlns' qualifies only the XMLNS namespace",
        "NamespaceError",
      );
    }
    if (ns === XMLNS_NS && qualifiedName !== "xmlns" && prefix !== "xmlns") {
      throw new DOMException(
        "setAttributeNS: XMLNS namespace requires the 'xmlns' qname or prefix",
        "NamespaceError",
      );
    }
    const flat = this._attrFlat();
    // Wasm keeps only qualified names, so namespace identity lives in this side table.
    // Nodes using it stay off the Rust fast path, which sees only the flattened key.
    let nsMap = attrNs.get(this._id);
    if (!nsMap) {
      nsMap = new Map();
      attrNs.set(this._id, nsMap);
      fastpathMarkSpecial(this._id);
    }
    let existingKey: string | null = null;
    for (const [k, info] of nsMap) {
      if (info.ns === ns && info.localName === localName) {
        existingKey = k;
        break;
      }
    }
    let finalKey: string;
    if (existingKey) {
      finalKey = existingKey;
    } else {
      if (nsMap.has(qualifiedName)) {
        finalKey = "\u0000" + (ns || "") + "\u0000" + qualifiedName;
      } else {
        let collides = false;
        for (let i = 0; i < flat.length; i += 2) {
          if (flat[i] === qualifiedName) {
            collides = true;
            break;
          }
        }
        finalKey = collides ? "\u0000" + (ns || "") + "\u0000" + qualifiedName : qualifiedName;
      }
    }
    let oldValue: string | null = null;
    if (existingKey) {
      for (let i = 0; i < flat.length; i += 2) {
        if (flat[i] === existingKey) {
          oldValue = flat[i + 1];
          break;
        }
      }
    }
    nsMap.set(finalKey, { ns, prefix, localName, qname: qualifiedName });
    this._attrFlatCache = null;
    const strValue = String(value);
    recordOp({
      kind: "setAttribute",
      node: this._id,
      name: finalKey,
      value: strValue,
    });
    recordAttributeMutation(this._id, localName, ns, oldValue);
    if (customAttributeHook) {
      customAttributeHook(this, localName, oldValue, strValue, ns);
    }
  }
  getAttributeNS(namespace: string | null, localName: string) {
    if (typeof localName !== "string") return null;
    const ns = namespace ? String(namespace) : null;
    // Parsed namespaces live in a sidecar that only `_attrFlat` fills, and this reads the
    // sidecar before the flat list.
    this._attrFlat();
    const nsMap = attrNs.get(this._id);
    if (nsMap) {
      for (const [qname, info] of nsMap) {
        if (info.ns !== ns || info.localName !== localName) continue;
        const flat = this._attrFlat();
        for (let i = 0; i < flat.length; i += 2) {
          if (flat[i] === qname) return flat[i + 1];
        }
        return null;
      }
    }
    if (ns === null) {
      const flat = this._attrFlat();
      for (let i = 0; i < flat.length; i += 2) {
        if (flat[i] === localName && (!nsMap || !nsMap.has(localName))) {
          return flat[i + 1];
        }
      }
    }
    return null;
  }
  hasAttributeNS(namespace: string | null, localName: string) {
    return this.getAttributeNS(namespace, localName) !== null;
  }
  removeAttributeNS(namespace: string | null, localName: string) {
    if (typeof localName !== "string" || localName.length === 0) return;
    const ns = namespace ? String(namespace) : null;
    const elNs = elemNs.get(this._id);
    const runsChangeSteps = ns === null && (!elNs || elNs.ns === HTML_NS);
    // Same sidecar as `getAttributeNS`: refresh it before deciding a namespaced one is absent.
    this._attrFlat();
    const customAttributeHook =
      ksInternals.customElementObservesAttribute?.(this, localName) &&
      typeof ksInternals.notifyCustomElementAttributeChanged === "function"
        ? ksInternals.notifyCustomElementAttributeChanged
        : null;
    const nsMap = attrNs.get(this._id);
    const cache = attrInstances.get(this);
    if (nsMap) {
      for (const [wasmKey, info] of nsMap) {
        if (info.ns !== ns || info.localName !== localName) continue;
        const attr = cache?.get(wasmKey);
        if (attr) {
          attr._ownerElement = null;
          cache?.delete(wasmKey);
        }
        let oldValue: string | null = null;
        const flat = this._attrFlat();
        for (let i = 0; i < flat.length; i += 2) {
          if (flat[i] === wasmKey) {
            oldValue = flat[i + 1];
            break;
          }
        }
        this._attrFlatCache = null;
        recordOp({
          kind: "removeAttribute",
          node: this._id,
          name: wasmKey,
        });
        nsMap.delete(wasmKey);
        recordAttributeMutation(this._id, localName, ns, oldValue);
        if (customAttributeHook) {
          customAttributeHook(this, localName, oldValue, null, ns);
        }
        if (runsChangeSteps) this[attributeChangeSteps](localName, null);
        return;
      }
    }
    if (ns === null) {
      const flat = this._attrFlat();
      for (let i = 0; i < flat.length; i += 2) {
        if (flat[i] !== localName || (nsMap && nsMap.has(localName))) continue;
        const attr = cache?.get(localName);
        if (attr) {
          attr._ownerElement = null;
          cache?.delete(localName);
        }
        const oldValue = flat[i + 1];
        this._attrFlatCache = null;
        recordOp({
          kind: "removeAttribute",
          node: this._id,
          name: localName,
        });
        recordAttributeMutation(this._id, localName, null, oldValue);
        if (customAttributeHook) {
          customAttributeHook(this, localName, oldValue, null, null);
        }
        if (runsChangeSteps) this[attributeChangeSteps](localName, null);
        return;
      }
    }
  }

  _syncAttrEntries(list: AttrImpl[], byName: Record<string, AttrImpl>): void {
    const flat = this._attrFlat();
    const ownerElement = this;
    list.length = 0;
    for (const key in byName) delete byName[key];
    const nsMap = attrNs.get(this._id);
    let cache = attrInstances.get(this);
    if (!cache) {
      cache = new Map();
      attrInstances.set(this, cache);
    }
    const seenNames = new Set();
    for (let i = 0; i < flat.length; i += 2) {
      const wasmKey = flat[i];
      const value = flat[i + 1];
      seenNames.add(wasmKey);
      let namespaceURI: string | null = null;
      let prefix: string | null = null;
      let localName = wasmKey;
      let exposedName = wasmKey;
      const nsInfo = nsMap && nsMap.get(wasmKey);
      if (nsInfo) {
        namespaceURI = nsInfo.ns;
        prefix = nsInfo.prefix;
        localName = nsInfo.localName;
        exposedName = nsInfo.qname || wasmKey;
      } else {
        // setAttribute uses the whole name as the local name, even with a colon.
        // https://dom.spec.whatwg.org/#dom-element-setattribute
        prefix = null;
        localName = wasmKey;
        exposedName = wasmKey;
      }
      let attr = cache.get(wasmKey);
      if (!attr) {
        const createdAttr: AttrImpl = Object.create(AttrCls.prototype);
        createdAttr._name = exposedName;
        createdAttr._namespaceURI = namespaceURI;
        createdAttr._prefix = prefix;
        createdAttr._localName = localName;
        createdAttr._ownerElement = ownerElement;
        cache.set(wasmKey, createdAttr);
        attr = createdAttr;
      }
      attr._value = value;
      attr._nodeValue = value;
      attr._textContent = value;
      list.push(attr);
      if (!(exposedName in byName)) byName[exposedName] = attr;
    }
    for (const cachedName of Array.from(cache.keys())) {
      if (!seenNames.has(cachedName)) {
        const stale = cache.get(cachedName);
        if (stale) stale._ownerElement = null;
        cache.delete(cachedName);
      }
    }
  }

  get attributes() {
    // Refresh the live NamedNodeMap when the mutation sequence changes.
    const list: AttrImpl[] = [];
    const byName: Record<string, AttrImpl> = Object.create(null);
    let syncedSeq = -1;
    const refresh = () => {
      const seq = ksState().mutationSeq | 0;
      if (seq === syncedSeq) return;
      syncedSeq = seq;
      this._syncAttrEntries(list, byName);
    };
    refresh();
    return makeNamedNodeMap(list, byName, this, refresh);
  }

  getAttributeNode(name: string) {
    const all = this.attributes;
    if (!all) return null;
    const named = typeof all.getNamedItem === "function" ? all.getNamedItem(String(name)) : null;
    return named || null;
  }
  getAttributeNodeNS(namespaceURI: string | null, localName: string) {
    const all = this.attributes;
    if (!all) return null;
    const named =
      typeof all.getNamedItemNS === "function"
        ? all.getNamedItemNS(namespaceURI, String(localName))
        : null;
    return named || null;
  }
  setAttributeNode(attr: AttrImpl) {
    if (!attr || typeof attr !== "object") {
      throw new (ksGlobal.DOMException || Error)(
        "setAttributeNode: argument must be an Attr",
        "TypeError",
      );
    }
    const owner = attr._ownerElement;
    if (owner && owner !== this) {
      throw new DOMException(
        "setAttributeNode: attribute is already in use by another element",
        "InUseAttributeError",
      );
    }
    const previous = this.getAttributeNode(attr.name);
    if (previous && previous !== attr) {
      previous._ownerElement = null;
    }
    const ns = attr.namespaceURI;
    if (ns) {
      this.setAttributeNS(ns, attr.name, attr.value || "");
    } else {
      this.setAttribute(attr.name, attr.value || "");
    }
    let cache = attrInstances.get(this);
    if (!cache) {
      cache = new Map();
      attrInstances.set(this, cache);
    }
    attr._ownerElement = this;
    cache.set(attr.name, attr);
    return previous;
  }
  setAttributeNodeNS(attr: AttrImpl) {
    return this.setAttributeNode(attr);
  }
  removeAttributeNode(attr: AttrImpl) {
    if (!attr) {
      throw new DOMException("removeAttributeNode: argument is null", "NotFoundError");
    }
    if (attr._ownerElement !== this) {
      throw new DOMException(
        "removeAttributeNode: attribute is not owned by this element",
        "NotFoundError",
      );
    }
    const ns = attr.namespaceURI;
    if (ns) {
      this.removeAttributeNS(ns, attr.localName || attr.name);
    } else {
      this.removeAttribute(attr.name);
    }
    attr._ownerElement = null;
    return attr;
  }

  getAttributeNames() {
    const flat = this._attrFlat();
    const nsMap = attrNs.get(this._id);
    const out: string[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      const wasmKey = flat[i];
      const info = nsMap && nsMap.get(wasmKey);
      out.push(info && info.qname ? info.qname : wasmKey);
    }
    return out;
  }

  get innerHTML() {
    if (isTemplateElement(this._id)) {
      const frag = ensureTemplateContent(this._id);
      return dom.innerHTML(frag._id);
    }
    return dom.innerHTML(this._id);
  }
  set innerHTML(value) {
    // [LegacyNullToEmptyString]: null becomes "", but undefined stays "undefined".
    // https://webidl.spec.whatwg.org/#LegacyNullToEmptyString
    const htmlText = value === null ? "" : String(value);
    demandSvgTextOutlines(htmlText, this.namespaceURI);
    ksSpan("dom.innerHTML", { html_bytes: htmlText.length }, () => this.__setInnerHTML(htmlText));
  }
  __setInnerHTML(htmlText: string): void {
    maybeScheduleSlotchange(this._id);
    // Keep old child wrappers for childList records that expose them in removedNodes.
    if (isTemplateElement(this._id)) {
      const frag = ensureTemplateContent(this._id);
      const observed = hasChildListObserver(frag._id);
      const transientlyObserved = hasSubtreeObserver(frag._id);
      const oldChildIds = Array.from(dom.childIds(frag._id));
      const oldChildren = observed ? Array.from<NodeBase>(frag.childNodes) : null;
      if (transientlyObserved) {
        for (const childId of oldChildIds) {
          if (observed || subtreeHasCachedWrapper(childId)) {
            registerTransientObservers(childId);
          }
        }
      }
      recordOp({ kind: "setInnerHtml", node: frag._id, html: htmlText });
      if (!observed) dropUnwrappedSubtrees(oldChildIds);
      if (oldChildren) {
        const newChildren = Array.from<NodeBase>(frag.childNodes);
        if (oldChildren.length > 0 || newChildren.length > 0) {
          recordChildListMutation(frag, newChildren, oldChildren, null, null);
        }
      }
      syncCheckedFromAttrs(frag);
      return;
    }
    const observed = hasChildListObserver(this._id);
    const transientlyObserved = hasSubtreeObserver(this._id);
    const oldChildIds = Array.from(dom.childIds(this._id));
    const oldChildren = observed ? Array.from<NodeBase>(this.childNodes) : null;
    if (transientlyObserved) {
      for (const childId of oldChildIds) {
        if (observed || subtreeHasCachedWrapper(childId)) {
          registerTransientObservers(childId);
        }
      }
    }
    recordOp({ kind: "setInnerHtml", node: this._id, html: htmlText });
    // The replaced children are detached but still exist in wasm, so their ids are readable. A
    // dropped subtree captured and forgot its names already, so only the kept ones are left.
    for (const childId of oldChildIds) {
      if (!observed && dropUnwrappedSubtree(childId)) continue;
      syncNamedGlobals(childId);
    }
    // New markup brings its own ids; without one there is nothing to install. HTML lowercases
    // attribute names, so the guard cannot be case-sensitive.
    if (/id/i.test(htmlText)) installConnectedNamedGlobals(this._id);
    if (oldChildren) {
      const newChildren = Array.from<NodeBase>(this.childNodes);
      if (oldChildren.length > 0 || newChildren.length > 0) {
        recordChildListMutation(this, newChildren, oldChildren, null, null);
      }
    }
    syncCheckedFromAttrs(this);
  }
  get content(): DocumentFragmentImpl | undefined {
    if (!isTemplateElement(this._id)) return undefined;
    return ensureTemplateContent(this._id);
  }
  get outerHTML() {
    return dom.outerHTML(this._id);
  }
  set outerHTML(value) {
    const htmlText = value === null ? "" : String(value);
    ksSpan("dom.outerHTML", { html_bytes: htmlText.length }, () => this.__setOuterHTML(htmlText));
  }
  // Limitation: HTML returns silently without a parent and uses the parent as context.
  // This throws and parses inside a temporary div.
  // https://html.spec.whatwg.org/#dom-element-outerhtml
  __setOuterHTML(htmlText: string): void {
    const parent = this.parentNode;
    if (!parent) {
      throw new (ksGlobal.DOMException || Error)(
        "Cannot set outerHTML on an element with no parent",
        "NoModificationAllowedError",
      );
    }
    if (!isElementNode(parent) && !isFragmentNode(parent)) {
      throw new (ksGlobal.DOMException || Error)(
        "Cannot set outerHTML when parent is not an Element or DocumentFragment",
        "NoModificationAllowedError",
      );
    }
    const tmp: Element = createElementInternal("div");
    tmp.innerHTML = htmlText;
    const moved: NodeBase[] = Array.from<NodeBase>(tmp.childNodes);
    const prevSibling = this.previousSibling || null;
    const nextSibling = this.nextSibling || null;
    const refId = this._id;
    for (const k of moved) {
      if (typeof k._id !== "number" || k._id < 0) continue;
      try {
        dom.removeNode(k._id);
      } catch {}
      dom.insertBeforeNode(parent._id, k._id, refId);
      installConnectedNamedGlobals(k._id);
    }
    const removedSelfId = this._id;
    runIteratorPreRemove(this);
    try {
      dom.removeNode(this._id);
    } catch {}
    syncNamedGlobals(removedSelfId);
    bumpMutationSeq();
    let prevForCdp = prevSibling ? prevSibling._id : 0;
    for (const k of moved) {
      if (typeof k._id !== "number" || k._id < 0) continue;
      recordCdpMutation({
        kind: "childNodeInserted",
        parentNodeId: parent._id,
        previousNodeId: prevForCdp,
        nodeId: k._id,
      });
      prevForCdp = k._id;
    }
    recordCdpMutation({
      kind: "childNodeRemoved",
      parentNodeId: parent._id,
      nodeId: removedSelfId,
    });
    recordChildListMutation(parent, moved, [this], prevSibling, nextSibling);
  }
  get innerText(): string | undefined {
    const ns = this.namespaceURI;
    if (ns === SVG_NS || ns === MATHML_NS) {
      // SVG and MathML wrappers share HTMLElement's class but have no innerText value.
      return undefined;
    }
    try {
      const s: unknown = dom.innerTextRendered(this._id);
      if (typeof s === "string") return s;
    } catch {}
    // An element's textContent is never null; only a document's is.
    return this.textContent ?? "";
  }
  set innerText(value) {
    const v = value === null ? "" : String(value);
    const ns = this.namespaceURI;
    if (ns === SVG_NS || ns === MATHML_NS) {
      Object.defineProperty(this, "innerText", {
        value: v,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      return;
    }
    const nodes = renderedTextFragmentNodes(v, elementDocument(this));
    this.textContent = "";
    for (const n of nodes) this.appendChild(n);
  }

  get children() {
    const id = this._id;
    const cached = childrenCache.get(this);
    if (cached) return cached;
    const coll = makeHtmlCollection(() => {
      const ids = Array.from(dom.childIds(id));
      const out: Element[] = [];
      for (const cid of ids) {
        const n = nodeFor(cid);
        if (isElementNode(n)) out.push(n);
      }
      return out;
    });
    childrenCache.set(this, coll);
    return coll;
  }

  get firstElementChild(): Element | null {
    const kids = this.children;
    return kids.length > 0 ? kids[0] : null;
  }
  get lastElementChild(): Element | null {
    const kids = this.children;
    return kids.length > 0 ? kids[kids.length - 1] : null;
  }
  get childElementCount() {
    return this.children.length;
  }

  querySelector(selector: string) {
    if (arguments.length < 1) {
      throw new TypeError(
        "Failed to execute 'querySelector' on 'Element': 1 argument required, but only 0 present.",
      );
    }
    return scopedQuerySelector(this._id, selector);
  }
  querySelectorAll(selector: string) {
    if (arguments.length < 1) {
      throw new TypeError(
        "Failed to execute 'querySelectorAll' on 'Element': 1 argument required, but only 0 present.",
      );
    }
    return scopedQuerySelectorAll(this._id, selector);
  }
  getElementsByTagName(name: string) {
    const id = this._id;
    const qname = String(name);
    return makeHtmlCollection(() => {
      try {
        const cand = Array.from<Element>(scopedQuerySelectorAll(id, "*"));
        if (qname === "*") return cand;
        return filterByQualifiedName(cand, qname);
      } catch {
        return [];
      }
    });
  }
  getElementsByTagNameNS(namespace: string | null, localName: string) {
    const id = this._id;
    const ns =
      namespace === null || namespace === undefined || namespace === "" ? null : String(namespace);
    const ln = String(localName);
    return makeHtmlCollection(() => {
      try {
        const cand = Array.from<Element>(scopedQuerySelectorAll(id, "*"));
        return cand.filter((el) => {
          const elNs = el.namespaceURI || null;
          if (ns !== "*" && elNs !== ns) return false;
          if (ln === "*") return true;
          return (el.localName || "") === ln;
        });
      } catch {
        return [];
      }
    });
  }
  getElementsByClassName(name: string) {
    const id = this._id;
    const cls = String(name)
      .split(/[\t\n\f\r ]+/)
      .filter(Boolean);
    if (cls.length === 0) return makeHtmlCollection(() => []);
    const sel = cls.map((c) => "." + cssEscape(c)).join("");
    return makeHtmlCollection(() => {
      try {
        return Array.from<Element>(scopedQuerySelectorAll(id, sel));
      } catch {
        return [];
      }
    });
  }
  matches(selector: string) {
    if (arguments.length < 1) {
      throw new TypeError(
        "Failed to execute 'matches' on 'Element': 1 argument required, but only 0 present.",
      );
    }
    {
      const bare = String(selector).trim();
      if (bare === ":tool-form-active") return isToolFormActive(this);
      if (bare === ":tool-submit-active") return isToolSubmitActive(this);
    }
    const sel = String(selector);
    try {
      return !!dom.matchesInSubtree(this._id, sel);
    } catch (err) {
      // Selector failures may be Error objects or plain objects with a message.
      const e = err as { message?: unknown } | null | undefined;
      throw new DOMException(
        "Failed to execute 'matches' on 'Element': '" +
          sel +
          "' is not a valid selector. " +
          (e && e.message ? e.message : String(e)),
        "SyntaxError",
      );
    }
  }
  closest(selector: string) {
    if (arguments.length < 1) {
      throw new TypeError(
        "Failed to execute 'closest' on 'Element': 1 argument required, but only 0 present.",
      );
    }
    const sel = String(selector);
    try {
      const matchedId = dom.closestInTree(this._id, sel);
      return matchedId >= 0 ? elementFor(matchedId) : null;
    } catch (err) {
      // Selector failures may be Error objects or plain objects with a message.
      const e = err as { message?: unknown } | null | undefined;
      throw new DOMException(
        "Failed to execute 'closest' on 'Element': '" +
          sel +
          "' is not a valid selector. " +
          (e && e.message ? e.message : String(e)),
        "SyntaxError",
      );
    }
  }
  // Limitation: there is no click-in-progress flag. Activation runs for this element
  // or its summary ancestor instead of through the dispatch path.
  // https://html.spec.whatwg.org/#dom-click
  click(): void {
    runClickSteps(this, null);
  }
  getClientRects() {
    if (!hasLayoutBox(this._id)) {
      return makeDomRectList([]);
    }
    const rect = getRect(this._id);
    return makeDomRectList([makeDomRect(rect.x, rect.y, rect.width, rect.height)]);
  }
  getBoundingClientRect() {
    const rect = getRect(this._id);
    return makeDomRect(rect.x, rect.y, rect.width, rect.height);
  }
  checkVisibility(options?: CheckVisibilityOptions) {
    if (!this.isConnected || !hasLayoutBox(this._id)) return false;
    const gcs = (el: Element) => ksGlobal.getComputedStyle(el);
    if (options?.checkOpacity || options?.opacityProperty) {
      for (let el: Element | null = this; el; el = flatTreeParentElement(el)) {
        if (gcs(el).opacity === "0") return false;
      }
    }
    if (options?.checkVisibilityCSS || options?.visibilityProperty) {
      if (gcs(this).visibility !== "visible") return false;
    }
    return true;
  }
  animate(keyframes: object | null, options?: number | Idl.KeyframeAnimationOptions): KsAnimation {
    return animateElement(this, keyframes, options);
  }
  // Limitation: script animations only. CSS animations and transitions run in stylo and
  // never become Animation objects, so they are not listed here.
  getAnimations(options?: Idl.GetAnimationsOptions): KsAnimation[] {
    return animationsFor(this, !!options?.subtree);
  }
  // Approximation: the spec parses a pseudo-element selector, so "before" returns
  // null there; this accepts it.
  // https://drafts.csswg.org/css-pseudo-4/#dom-element-pseudo
  pseudo(type: string): PseudoElementStub | null {
    let t = String(type);
    if (t.startsWith("::")) t = t.slice(2);
    else if (t.startsWith(":")) t = t.slice(1);
    t = t.toLowerCase();
    if (t !== "before" && t !== "after" && t !== "marker") return null;
    const key = this._id + ":" + t;
    const cached = pseudoElementCache.get(key);
    if (cached) return cached;
    const obj: PseudoElementStub = Object.create(null);
    Object.defineProperty(obj, "type", { value: "::" + t, enumerable: true });
    Object.defineProperty(obj, "element", { value: this, enumerable: true });
    Object.defineProperty(obj, Symbol.toStringTag, { value: "CSSPseudoElement" });
    pseudoCachePut(key, obj);
    return obj;
  }
  scrollIntoViewIfNeeded(_centerIfNeeded?: boolean): void {
    this.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  scrollIntoView(arg?: boolean | Idl.ScrollIntoViewOptions): void {
    let block: string, inline: string;
    if (arg === false) {
      block = "end";
      inline = "nearest";
    } else if (arg === true || arg == null) {
      block = "start";
      inline = "nearest";
    } else if (typeof arg === "object") {
      block = String(arg.block ?? "start");
      inline = String(arg.inline ?? "nearest");
    } else {
      block = "start";
      inline = "nearest";
    }

    const computeAxis = (
      elPos: number,
      elSize: number,
      viewSize: number,
      curScroll: number,
      mode: string,
    ) => {
      switch (mode) {
        case "start":
          return elPos;
        case "end":
          return elPos + elSize - viewSize;
        case "center":
          return elPos + elSize / 2 - viewSize / 2;
        case "nearest": {
          if (elPos >= curScroll && elPos + elSize <= curScroll + viewSize) {
            return curScroll;
          }
          if (elPos < curScroll) return elPos;
          return elPos + elSize - viewSize;
        }
        default:
          return elPos;
      }
    };

    const htmlId = dom.querySelector("html");
    const targetVr = getRect(this._id);
    const targetSize = { w: targetVr.width, h: targetVr.height };

    let elViewportX = targetVr.x;
    let elViewportY = targetVr.y;
    // Limitation: css-position-3 targets a sticky box at its offset position.
    // This subtracts the shift and targets the unshifted position.
    // https://drafts.csswg.org/css-position-3/#stickypos-scroll
    try {
      const sh = getStickyShiftByAuthId && getStickyShiftByAuthId(this._id);
      if (sh && sh.length >= 2) {
        elViewportX -= Number(sh[0]) || 0;
        elViewportY -= Number(sh[1]) || 0;
      }
    } catch {}

    let cur = this._id;
    let safety = 0;
    try {
      cur = dom.parentId(cur);
    } catch {
      cur = -1;
    }

    while (cur != null && cur >= 0 && cur !== htmlId && safety < MAX_SCROLL_CHAIN_HOPS) {
      safety++;
      const info = nodeScrollInfoSafe(cur);
      if (info && (info.overflowsX || info.overflowsY)) {
        const containerVr = getRect(cur);
        const elInContentX = elViewportX - containerVr.x + info.scrollLeft;
        const elInContentY = elViewportY - containerVr.y + info.scrollTop;
        const targetScrollY = info.overflowsY
          ? Math.max(
              0,
              Math.min(
                computeAxis(elInContentY, targetSize.h, info.clientHeight, info.scrollTop, block),
                info.scrollHeight,
              ),
            )
          : info.scrollTop;
        const targetScrollX = info.overflowsX
          ? Math.max(
              0,
              Math.min(
                computeAxis(elInContentX, targetSize.w, info.clientWidth, info.scrollLeft, inline),
                info.scrollWidth,
              ),
            )
          : info.scrollLeft;
        if (targetScrollY !== info.scrollTop || targetScrollX !== info.scrollLeft) {
          if (setElementScrollOffset(cur, targetScrollX, targetScrollY)) {
            elViewportY += info.scrollTop - targetScrollY;
            elViewportX += info.scrollLeft - targetScrollX;
          }
        }
      }
      try {
        cur = dom.parentId(cur);
      } catch {
        break;
      }
    }

    const cur2 = scrollOffset();
    const viewportH = Number(ksGlobal.innerHeight) || DEFAULT_VIEWPORT_HEIGHT_CSS_PX;
    const viewportW = Number(ksGlobal.innerWidth) || DEFAULT_VIEWPORT_WIDTH_CSS_PX;
    const docTop = elViewportY + cur2.y;
    const docLeft = elViewportX + cur2.x;
    const targetY = computeAxis(docTop, targetSize.h, viewportH, cur2.y, block);
    const targetX = computeAxis(docLeft, targetSize.w, viewportW, cur2.x, inline);
    setScrollOffset(Math.max(0, targetX), Math.max(0, targetY));
  }
  scrollTo(_xOrOptions?: unknown, _y?: unknown): Promise<void> {
    const self = this;
    const args = arguments;
    return (async () => {
      const norm = normalizeScrollArgs(args, "scrollTo");
      if (norm === null) return;
      const info = nodeScrollInfoSafe(self._id);
      const curX = info ? info.scrollLeft : 0;
      const curY = info ? info.scrollTop : 0;
      const left = norm.left == null ? curX : norm.left;
      const top = norm.top == null ? curY : norm.top;
      const htmlId = dom.querySelector("html");
      const bodyId = dom.querySelector("body");
      if (self._id === htmlId || self._id === bodyId) {
        setScrollOffset(Math.max(0, left), Math.max(0, top));
        return;
      }
      if (!info) return;
      // Without a box there is no scroll range to clamp against; writing would
      // reset the offset the element keeps while its ancestor is hidden.
      if (info.hasBox === false) return;
      const nx = Math.max(0, Math.min(left, info.scrollWidth));
      const ny = Math.max(0, Math.min(top, info.scrollHeight));
      if (nx === info.scrollLeft && ny === info.scrollTop) return;
      let offset: unknown = null;
      try {
        offset = dom.setNodeScrollOffset(self._id, nx, ny);
      } catch {
        return;
      }
      if (!offset) return;
      markDamageNode(self._id);
      bumpMutationSeq();
      fireElementScroll(self);
    })();
  }
  scroll(_options?: Idl.ScrollToOptions): Promise<void>;
  scroll(_x: number, _y: number): Promise<void>;
  scroll(...args: [xOrOptions?: unknown, y?: unknown]): Promise<void> {
    return this.scrollTo(...args);
  }
  scrollBy(_options?: Idl.ScrollToOptions): Promise<void>;
  scrollBy(_x: number, _y: number): Promise<void>;
  scrollBy(_xOrOptions?: unknown, _y?: unknown): Promise<void> {
    const self = this;
    const args = arguments;
    return (async () => {
      const norm = normalizeScrollArgs(args, "scrollBy");
      if (norm === null) return;
      const dx = norm.left == null ? 0 : norm.left;
      const dy = norm.top == null ? 0 : norm.top;
      const htmlId = dom.querySelector("html");
      const bodyId = dom.querySelector("body");
      if (self._id === htmlId || self._id === bodyId) {
        const off = scrollOffset();
        setScrollOffset(Math.max(0, off.x + dx), Math.max(0, off.y + dy));
        return;
      }
      const info = nodeScrollInfoSafe(self._id);
      if (!info) return;
      await self.scrollTo(info.scrollLeft + dx, info.scrollTop + dy);
    })();
  }
  get scrollTop() {
    const htmlId = dom.querySelector("html");
    if (this._id === htmlId) return scrollOffset().y;
    const info = nodeScrollInfoSafe(this._id);
    return info ? Math.round(info.scrollTop) : 0;
  }
  set scrollTop(v) {
    const htmlId = dom.querySelector("html");
    if (this._id === htmlId) {
      const cur = scrollOffset();
      setScrollOffset(cur.x, Number(v) || 0);
      return;
    }
    const info = nodeScrollInfoSafe(this._id);
    if (!info) return;
    if (info.hasBox === false) return;
    if (!info.overflowsY) return;
    const next = Math.max(0, Math.min(Number(v) || 0, info.scrollHeight));
    if (next === info.scrollTop) return;
    let offset: unknown = null;
    try {
      offset = dom.setNodeScrollOffset(this._id, info.scrollLeft, next);
    } catch {
      return;
    }
    if (!offset) return;
    markDamageNode(this._id);
    bumpMutationSeq();
    fireElementScroll(this);
  }
  get scrollLeft() {
    const htmlId = dom.querySelector("html");
    if (this._id === htmlId) return scrollOffset().x;
    const info = nodeScrollInfoSafe(this._id);
    return info ? Math.round(info.scrollLeft) : 0;
  }
  set scrollLeft(v) {
    const htmlId = dom.querySelector("html");
    if (this._id === htmlId) {
      const cur = scrollOffset();
      setScrollOffset(Number(v) || 0, cur.y);
      return;
    }
    const info = nodeScrollInfoSafe(this._id);
    if (!info) return;
    if (info.hasBox === false) return;
    if (!info.overflowsX) return;
    const next = Math.max(0, Math.min(Number(v) || 0, info.scrollWidth));
    if (next === info.scrollLeft) return;
    let offset: unknown = null;
    try {
      offset = dom.setNodeScrollOffset(this._id, next, info.scrollTop);
    } catch {
      return;
    }
    if (!offset) return;
    markDamageNode(this._id);
    bumpMutationSeq();
    fireElementScroll(this);
  }
  get scrollWidth() {
    const info = nodeScrollInfoSafe(this._id);
    if (info) return Math.round(info.clientWidth + info.scrollWidth);
    const rect = getRect(this._id);
    return Math.round(rect.width);
  }
  get scrollHeight() {
    const info = nodeScrollInfoSafe(this._id);
    if (info) return Math.round(info.clientHeight + info.scrollHeight);
    const rect = getRect(this._id);
    return Math.round(rect.height);
  }
  get clientWidth() {
    const info = nodeScrollInfoSafe(this._id);
    if (info) return Math.round(info.clientWidth);
    const rect = getRect(this._id);
    return Math.round(rect.width);
  }
  get clientHeight() {
    const info = nodeScrollInfoSafe(this._id);
    if (info) return Math.round(info.clientHeight);
    const rect = getRect(this._id);
    return Math.round(rect.height);
  }
  get clientTop() {
    const info = nodeScrollInfoSafe(this._id);
    return info ? Math.round(info.clientTop) : 0;
  }
  get clientLeft() {
    const info = nodeScrollInfoSafe(this._id);
    return info ? Math.round(info.clientLeft) : 0;
  }
  get offsetWidth(): number {
    return Math.round(getRect(this._id).width);
  }
  get offsetHeight(): number {
    return Math.round(getRect(this._id).height);
  }
  _offsetMetrics(): OffsetMetrics {
    const read = (getMetrics: ((id: number) => unknown) | null) => {
      if (!getMetrics) return null;
      const metrics = getMetrics(this._id);
      return hasOffsetTop(metrics) ? metrics : null;
    };
    try {
      const metrics = read(getOffsetMetricsByAuthId);
      if (metrics) return metrics;
    } catch {}
    try {
      const metrics = read((id: number) => dom.offsetMetrics(id));
      if (metrics) return metrics;
    } catch {}
    const rect = getRect(this._id);
    const scroll = scrollOffset();
    return { parent: -1, top: rect.y + scroll.y, left: rect.x + scroll.x };
  }
  get offsetParent(): Element | null {
    const metrics = this._offsetMetrics();
    const parentId = Number(metrics.parent);
    return parentId >= 0 ? elementFor(parentId) : null;
  }
  get offsetTop(): number {
    return Math.round(this._offsetMetrics().top);
  }
  get offsetLeft(): number {
    // Math.round preserves numeric coercion for the legacy wasm metrics field.
    return Math.round(this._offsetMetrics().left as number);
  }
  get currentCSSZoom() {
    return 1;
  }
  // Cache the [SameObject] CSSStyleProperties proxy.
  // https://drafts.csswg.org/cssom/#dom-elementcssinlinestyle-style
  get style(): ReturnType<typeof makeStyleDeclaration> {
    let st = inlineStyleProxies.get(this);
    if (!st) {
      const target = this;
      const data: Record<string, string> = Object.create(null);

      const canon =
        opts && typeof opts.canonicalizeInlineStyle === "function"
          ? opts.canonicalizeInlineStyle
          : null;
      const serializeCanon =
        opts && typeof opts.serializeInlineStyle === "function" ? opts.serializeInlineStyle : null;
      const getCanonValue =
        opts && typeof opts.getInlinePropertyValue === "function"
          ? opts.getInlinePropertyValue
          : null;

      const rawValues: Record<string, string> = Object.create(null);

      const existing = target.getAttribute && target.getAttribute("style");
      if (existing) parseCssTextInto(String(existing), data);
      if (existing) parseCssTextInto(String(existing), rawValues);

      let suspendFlush = false;
      const shorthandValues: Record<string, string> = Object.create(null);
      const parsedValues = new Map<
        string,
        {
          value: string;
          declarations: Array<{ name: string; value: string; important?: boolean }>;
        }
      >();
      function recanonicalize() {
        if (!canon) return;
        for (const k of parsedValues.keys()) {
          if (data[k] === undefined) parsedValues.delete(k);
        }
        const preKeys = Object.keys(data);
        const preValues: Record<string, string> = {};
        for (const k of preKeys) preValues[k] = String(data[k]);
        for (const k of preKeys) delete data[k];

        for (const k of preKeys) {
          const rawVal = preValues[k];
          if (rawVal == null || rawVal === "") continue;
          if (SVG_GEOMETRY_STYLE_PROPS.has(k) && String(target.namespaceURI || "") === SVG_NS) {
            data[k] = rawVal;
            continue;
          }
          const dashName = cssPropCamelToKebab(k);
          let parsed: Array<{ name: string; value: string; important?: boolean }>;
          const cached = parsedValues.get(k);
          if (cached?.value === rawVal) {
            parsed = cached.declarations;
          } else {
            try {
              parsed = canon(`${dashName}: ${rawVal}`);
            } catch {
              parsed = [];
            }
            if (!Array.isArray(parsed) || parsed.length === 0) {
              delete shorthandValues[k];
              delete rawValues[k];
              parsedValues.delete(k);
              continue;
            }
            parsedValues.set(k, { value: rawVal, declarations: parsed });
          }
          for (const decl of parsed) {
            if (!decl || typeof decl.name !== "string") continue;
            const longKey = cssPropToCamel(decl.name);
            data[longKey] = decl.important ? `${decl.value} !important` : decl.value;
          }
          const isLonghandWrite = parsed.length === 1 && cssPropToCamel(parsed[0].name) === k;
          if (isLonghandWrite) {
            delete shorthandValues[k];
          } else {
            shorthandValues[k] = rawVal;
          }
        }
      }
      const serializeBlock = (): string => {
        const raw = serializeStyleData(data);
        if (!serializeCanon || !raw) return raw;
        try {
          const canon = serializeCanon(raw);
          return canon || raw;
        } catch {
          return raw;
        }
      };
      const closeRawValue = (v: string): string => {
        const closers: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
        const stack: string[] = [];
        let quote: string | null = null;
        let comment = false;
        for (let i = 0; i < v.length; i++) {
          const c = v[i];
          if (comment) {
            if (c === "*" && v[i + 1] === "/") {
              comment = false;
              i++;
            }
            continue;
          }
          if (quote) {
            if (c === "\\") i++;
            else if (c === quote) quote = null;
            continue;
          }
          if (c === "\\") i++;
          else if (c === '"' || c === "'") quote = c;
          else if (c === "/" && v[i + 1] === "*") {
            comment = true;
            i++;
          } else if (closers[c]) stack.push(closers[c]);
          else if (c === stack[stack.length - 1]) stack.pop();
        }
        let out = v;
        if (comment) out += "*/";
        if (quote) out += quote;
        while (stack.length) out += stack.pop();
        return out;
      };
      const serializeRawAttr = (): string => {
        const parts: string[] = [];
        for (const k of Object.keys(rawValues)) {
          const dashName = cssPropCamelToKebab(k);
          parts.push(dashName + ": " + closeRawValue(rawValues[k]) + ";");
        }
        return parts.join(" ");
      };
      let flushing = false;
      const flush = () => {
        if (suspendFlush) return;
        recanonicalize();
        const raw = serializeRawAttr();
        flushing = true;
        try {
          target.setAttribute("style", raw || serializeBlock());
        } finally {
          flushing = false;
        }
      };
      inlineStyleResync.set(target, (text: string | null) => {
        if (flushing) return;
        for (const k of Object.keys(data)) delete data[k];
        for (const k of Object.keys(rawValues)) delete rawValues[k];
        for (const k of Object.keys(shorthandValues)) delete shorthandValues[k];
        if (text) {
          parseCssTextInto(text, data);
          parseCssTextInto(text, rawValues);
        }
      });
      const expandCoveringRawKeys = (removedKey: string) => {
        if (!canon) {
          for (const k of Object.keys(rawValues)) delete rawValues[k];
          for (const k of Object.keys(data)) rawValues[k] = String(data[k]);
          return;
        }
        const removedDash = cssPropCamelToKebab(removedKey);
        for (const k of Object.keys(rawValues)) {
          if (k === removedKey) continue;
          const dashName = cssPropCamelToKebab(k);
          let parsed: Array<{ name: string; value: string; important?: boolean }>;
          try {
            parsed = canon(`${dashName}: ${rawValues[k]}`) || [];
          } catch {
            parsed = [];
          }
          if (parsed.length <= 1) continue;
          if (!parsed.some((d) => d && d.name === removedDash)) continue;
          const entries = Object.entries(rawValues);
          for (const kk of Object.keys(rawValues)) delete rawValues[kk];
          for (const [kk, vv] of entries) {
            if (kk !== k) {
              rawValues[kk] = vv;
              continue;
            }
            for (const d of parsed) {
              if (!d || typeof d.name !== "string" || d.name === removedDash) continue;
              const camel = cssPropToCamel(d.name);
              const dv = data[camel];
              rawValues[camel] =
                dv !== undefined ? String(dv) : d.important ? `${d.value} !important` : d.value;
            }
          }
        }
      };
      const dropRawKey = (key: string, hadInData: boolean) => {
        const hadRaw = rawValues[key] !== undefined;
        if (hadRaw) delete rawValues[key];
        if (!hadInData && !hadRaw) return;
        expandCoveringRawKeys(key);
      };
      const longhandKeysOf = (key: string): string[] => {
        if (!canon || key.startsWith("--")) return [];
        let keys = longhandKeysCache.get(key);
        if (keys) return keys;
        let parsed: Array<{ name: string }>;
        try {
          parsed = canon(`${cssPropCamelToKebab(key)}: inherit`) || [];
        } catch {
          parsed = [];
        }
        keys = [];
        for (const d of parsed) {
          if (d && typeof d.name === "string") keys.push(cssPropToCamel(d.name));
        }
        longhandKeysCache.set(key, keys);
        return keys;
      };
      const removeKey = (key: string) => {
        const had = data[key] !== undefined;
        delete data[key];
        delete shorthandValues[key];
        dropRawKey(key, had);
        let touched = had;
        for (const lh of longhandKeysOf(key)) {
          if (lh === key || data[lh] === undefined) continue;
          delete data[lh];
          dropRawKey(lh, true);
          touched = true;
        }
        if (!touched) return;
        for (const s of Object.keys(shorthandValues)) {
          if (longhandKeysOf(s).some((lh) => data[lh] === undefined)) delete shorthandValues[s];
        }
      };
      const setRawKey = (key: string, v: string) => {
        delete rawValues[key];
        rawValues[key] = v;
      };
      const writeWithRestore = (key: string, v: string) => {
        const prevData = data[key];
        const prevRaw = rawValues[key];
        data[key] = v;
        setRawKey(key, v);
        flush();
        if (prevData === undefined) return;
        const dropped =
          data[key] === undefined &&
          rawValues[key] === undefined &&
          shorthandValues[key] === undefined;
        if (!dropped) return;
        data[key] = prevData;
        if (prevRaw !== undefined) setRawKey(key, prevRaw);
        flush();
      };

      // getPropertyValue and the property reads share this: the declared
      // value without !important, else Stylo's shorthand assembly, else the
      // authored shorthand text.
      const readProperty = (key: string, dashName: string): string => {
        if (data[key] != null) return String(data[key]).replace(/\s*!important\s*$/i, "");
        if (getCanonValue) {
          const raw = serializeStyleData(data);
          if (raw) {
            try {
              const v = getCanonValue(raw, dashName);
              if (v) return v;
            } catch {
              /* fall through */
            }
          }
        }
        if (shorthandValues[key] != null) return shorthandValues[key];
        return "";
      };
      const setCssText = (text: unknown) => {
        suspendFlush = true;
        for (const k of Object.keys(data)) delete data[k];
        for (const k of Object.keys(rawValues)) delete rawValues[k];
        parseCssTextInto(String(text == null ? "" : text), data);
        parseCssTextInto(String(text == null ? "" : text), rawValues);
        suspendFlush = false;
        flush();
      };
      // [LegacyNullToEmptyString]: an empty value removes the property.
      const writeProperty = (key: string, value: unknown) => {
        const v = value == null ? "" : String(value);
        if (v === "") {
          removeKey(key);
          flush();
        } else {
          writeWithRestore(key, v);
        }
      };
      const backend: StyleDeclarationBackend = {
        cssText: serializeBlock,
        setCssText,
        length: () => Object.keys(data).length,
        item(index) {
          const key = Object.keys(data)[index];
          return key === undefined ? "" : cssPropCamelToKebab(key);
        },
        getPropertyValue(name) {
          const dashName = String(name);
          return readProperty(cssPropToCamel(dashName), dashName);
        },
        getPropertyPriority(name) {
          const v = data[cssPropToCamel(String(name))];
          return v != null && /!important\s*$/i.test(String(v)) ? "important" : "";
        },
        setProperty(name, value) {
          writeProperty(cssPropToCamel(String(name)), value);
        },
        removeProperty(name) {
          const key = cssPropToCamel(String(name));
          const prev =
            data[key] != null
              ? String(data[key])
              : shorthandValues[key] != null
                ? shorthandValues[key]
                : "";
          removeKey(key);
          flush();
          return prev;
        },
        parentRule: () => null,
        *names() {
          for (const key of Object.keys(data)) yield cssPropCamelToKebab(key);
        },
      };

      // The CSS properties, camelCase or kebab-case.
      st = makeStyleDeclaration(backend, {
        get(_t, prop) {
          const key = styleDeclKey(prop);
          if (typeof key !== "string") return "";
          return readProperty(key, cssPropCamelToKebab(key));
        },
        set(_t, prop, value) {
          const key = styleDeclKey(prop);
          if (typeof key !== "string") return false;
          writeProperty(key, value);
          return true;
        },
        has(_t, prop) {
          const key = styleDeclKey(prop);
          if (typeof key !== "string") return false;
          if (key.startsWith("--") || /^(?:webkit|moz|ms|o)-/.test(String(prop))) return false;
          if (key in data) return true;
          if (typeof prop === "string" && !prop.includes("-") && /^(?:moz|ms|o)[A-Z]/.test(prop)) {
            return false;
          }
          return longhandKeysOf(key).length > 0;
        },
        deleteProperty(_t, prop) {
          const key = styleDeclKey(prop);
          if (typeof key !== "string") return Reflect.deleteProperty(_t, prop);
          const had = key in data;
          delete data[key];
          if (had) {
            dropRawKey(key, true);
            flush();
          }
          return true;
        },
        // The declared properties stay the declaration's own keys.
        ownKeys: () => Object.keys(data),
        getOwnPropertyDescriptor(_t, prop) {
          if (typeof prop !== "string" || !(prop in data)) return undefined;
          return { value: data[prop], writable: true, enumerable: true, configurable: true };
        },
      });
      inlineStyleProxies.set(this, st);
    }
    return st;
  }
  get attributeStyleMap(): StylePropertyMap {
    let map = attributeStyleMaps.get(this);
    if (!map) {
      map = new StylePropertyMap(() => this.style);
      attributeStyleMaps.set(this, map);
    }
    return map;
  }
  computedStyleMap() {
    let map = computedStyleMaps.get(this);
    if (!map) {
      map = makeComputedStyleMap(
        this,
        (element) => liveWindow()[GET_COMPUTED_STYLE_INTERNAL](element, undefined, true),
        this.attributeStyleMap,
      );
      computedStyleMaps.set(this, map);
    }
    return map;
  }
  set style(value) {
    this.setAttribute("style", String(value));
  }
  get value(): string | number {
    const s = formState.get(this._id);
    if (s && s.value !== undefined) return s.value;
    return this.getAttribute("value") ?? "";
  }
  set value(v: unknown) {
    const next = String(v);
    getFormState(this._id).value = next;
    const tag = typeof this.tagName === "string" ? this.tagName.toUpperCase() : "";
    if (tag === "INPUT" || tag === "TEXTAREA") {
      ksPushInputText(this, next);
    } else {
      bumpMutationSeq();
    }
  }
  get checked(): boolean | undefined {
    const s = formState.get(this._id);
    if (s && "checked" in s) return s.checked;
    return this.hasAttribute("checked");
  }
  set checked(v) {
    const next = !!v;
    const s = getFormState(this._id);
    if (s.checked === next) return;
    s.checked = next;
    const tag = typeof this.tagName === "string" ? this.tagName.toUpperCase() : "";
    if (tag === "INPUT") {
      try {
        dom.setCheckboxChecked(this._id, next);
      } catch {}
    }
    markDamageNode(this._id);
    bumpMutationSeq();
  }
  get disabled(): boolean {
    return this.hasAttribute("disabled");
  }
  set disabled(v) {
    if (v) this.setAttribute("disabled", "");
    else this.removeAttribute("disabled");
  }
  get placeholder(): string {
    return this.getAttribute("placeholder") ?? "";
  }
  set placeholder(v) {
    this.setAttribute("placeholder", String(v));
  }
  get type(): string {
    return elementAttributes.get.call(this, "type") ?? "";
  }
  set type(v) {
    elementAttributes.set.call(this, "type", String(v));
  }
  // URL reflection: a missing value gives "" and an invalid value stays raw.
  // Parsing uses the node document's encoding for non-ASCII queries.
  // https://html.spec.whatwg.org/#reflecting-content-attributes-in-idl-attributes
  get href(): string {
    const raw = elementAttributes.get.call(this, "href");
    if (raw == null) return "";
    try {
      return parseUrlForNode(this, raw, this.baseURI || pageUrl || undefined).toString();
    } catch {
      return raw;
    }
  }
  set href(v) {
    elementAttributes.set.call(this, "href", String(v));
  }
  get src(): string {
    const raw = elementAttributes.get.call(this, "src");
    if (raw == null) return "";
    try {
      return parseUrlForNode(this, raw, this.baseURI || pageUrl || undefined).toString();
    } catch {
      return raw;
    }
  }
  set src(v) {
    elementAttributes.set.call(this, "src", String(v));
  }
  select(): void {}
  setSelectionRange(_start: number, _end: number, _dir?: string): void {}

  // HTML, SVG and MathML elements expose dataset. Names with an ASCII uppercase
  // letter after data- are not exposed.
  // https://html.spec.whatwg.org/#concept-domstringmap-pairs
  get dataset(): Idl.DOMStringMap | undefined {
    const ns = this.namespaceURI;
    if (ns !== HTML_NS && ns !== SVG_NS && ns !== MATHML_NS) {
      // Other namespaces share this wrapper but have no dataset property.
      return undefined;
    }
    const target = this;
    function dashToCamel(suffix: string) {
      if (/[A-Z]/.test(suffix)) return null;
      return suffix.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    }
    function listDataAttrs() {
      const out: string[] = [];
      const seen = new Set();
      try {
        for (const a of target.attributes || []) {
          if (!a) continue;
          const nm = a.name || a.nodeName;
          if (typeof nm !== "string" || !nm.startsWith("data-")) continue;
          const camel = dashToCamel(nm.slice(5));
          if (camel === null) continue;
          if (seen.has(camel)) continue;
          seen.add(camel);
          out.push(camel);
        }
      } catch {}
      return out;
    }
    // A hyphen before an ASCII lowercase letter cannot be converted back, so set throws.
    // https://html.spec.whatwg.org/#dom-domstringmap-setitem
    function isInvalidDatasetName(name: string) {
      return /-[a-z]/.test(name);
    }
    const DSM = ksGlobal.DOMStringMap;
    const backing: Record<string, string> = Object.create(
      DSM && DSM.prototype ? DSM.prototype : Object.prototype,
    );
    return new Proxy(backing, {
      get(t, prop, receiver) {
        if (typeof prop === "string" && !isInvalidDatasetName(prop)) {
          const v = target.getAttribute("data-" + camelToDash(prop));
          if (v !== null) return v;
        }
        return Reflect.get(t, prop, receiver);
      },
      set(_t, prop, value) {
        if (typeof prop !== "string") return false;
        if (isInvalidDatasetName(prop)) {
          throw new DOMException(
            "dataset name contains '-' followed by a lowercase ASCII letter",
            "SyntaxError",
          );
        }
        target.setAttribute("data-" + camelToDash(prop), String(value));
        return true;
      },
      has(t, prop) {
        if (typeof prop === "string" && !isInvalidDatasetName(prop)) {
          if (target.hasAttribute("data-" + camelToDash(prop))) return true;
        }
        return Reflect.has(t, prop);
      },
      deleteProperty(_t, prop) {
        if (typeof prop !== "string") return false;
        if (isInvalidDatasetName(prop)) return true;
        target.removeAttribute("data-" + camelToDash(prop));
        return true;
      },
      ownKeys() {
        return listDataAttrs();
      },
      getOwnPropertyDescriptor(_t, prop) {
        if (typeof prop !== "string") return undefined;
        if (!listDataAttrs().includes(prop)) return undefined;
        return {
          value: target.getAttribute("data-" + camelToDash(prop)),
          writable: true,
          enumerable: true,
          configurable: true,
        };
      },
    });
  }
  // Fires blur, focusout, focus, then focusin. Limitation: this does not check whether
  // the element can take focus or scroll it into view.
  // https://w3c.github.io/uievents/#events-focusevent-event-order
  focus(): void {
    const old = activeElement;
    if (old === this) return;
    setActiveElement(this);
    try {
      if (typeof this._id === "number" && this._id >= 0) {
        dom.setFocus(this._id);
        if (old) markDamageNode(old._id);
        markDamageNode(this._id);
        bumpMutationSeq();
      }
    } catch {}
    if (old) {
      try {
        old.dispatchEvent(
          new KsFocusEvent("blur", {
            bubbles: false,
            cancelable: false,
            composed: true,
            relatedTarget: this,
          }),
        );
      } catch {}
      try {
        old.dispatchEvent(
          new KsFocusEvent("focusout", {
            bubbles: true,
            cancelable: false,
            composed: true,
            relatedTarget: this,
          }),
        );
      } catch {}
    }
    try {
      this.dispatchEvent(
        new KsFocusEvent("focus", {
          bubbles: false,
          cancelable: false,
          composed: true,
          relatedTarget: old || null,
        }),
      );
    } catch {}
    try {
      this.dispatchEvent(
        new KsFocusEvent("focusin", {
          bubbles: true,
          cancelable: false,
          composed: true,
          relatedTarget: old || null,
        }),
      );
    } catch {}
  }
  blur(): void {
    if (activeElement !== this) return;
    setActiveElement(null);
    try {
      dom.clearFocus();
      markDamageNode(this._id);
      bumpMutationSeq();
    } catch {}
    try {
      this.dispatchEvent(
        new KsFocusEvent("blur", {
          bubbles: false,
          cancelable: false,
          composed: true,
          relatedTarget: null,
        }),
      );
    } catch {}
    try {
      this.dispatchEvent(
        new KsFocusEvent("focusout", {
          bubbles: true,
          cancelable: false,
          composed: true,
          relatedTarget: null,
        }),
      );
    } catch {}
  }
  // Limitation: pointer capture does not persist between input events.
  hasPointerCapture(_pointerId: number) {
    return false;
  }
  setPointerCapture(_pointerId: number) {}
  releasePointerCapture(_pointerId: number) {}
}

// DOM marks these members [Unscopable], so `with` blocks cannot resolve them.
// https://webidl.spec.whatwg.org/#Unscopable
Object.defineProperty(Element.prototype, Symbol.unscopables, {
  value: Object.freeze({
    append: true,
    prepend: true,
    after: true,
    before: true,
    replaceWith: true,
    remove: true,
    replaceChildren: true,
    slot: true,
  }),
  configurable: true,
  enumerable: false,
  writable: false,
});
type TextFragmentDocument = {
  createTextNode(data: string): NodeBase;
  createElement(localName: string): NodeBase;
};
// Each CRLF, CR or LF becomes a <br>. Text between them becomes a Text node.
// https://html.spec.whatwg.org/#rendered-text-fragment
function renderedTextFragmentNodes(value: unknown, doc: TextFragmentDocument): NodeBase[] {
  const nodes: NodeBase[] = [];
  const s = String(value);
  let run = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\r" || ch === "\n") {
      if (run) {
        nodes.push(doc.createTextNode(run));
        run = "";
      }
      nodes.push(doc.createElement("br"));
      i += ch === "\r" && s[i + 1] === "\n" ? 2 : 1;
    } else {
      run += ch;
      i += 1;
    }
  }
  if (run) nodes.push(doc.createTextNode(run));
  return nodes;
}

// Reflection reads and writes the content attribute directly, as a native accessor does. A
// page override of an element's setAttribute (consent blockers set one) that assigns the
// matching property would otherwise re-enter it without end.
const elementAttributes = {
  get: Element.prototype.getAttribute,
  set: Element.prototype.setAttribute,
  has: Element.prototype.hasAttribute,
  remove: Element.prototype.removeAttribute,
};

export { Element, elementAttributes, renderedTextFragmentNodes };
