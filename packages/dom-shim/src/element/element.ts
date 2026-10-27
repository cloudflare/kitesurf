// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements Element attributes, queries, geometry, style, scrolling, and focus behavior.

import type * as Idl from "../idl/types.generated.js";
import { makeStyleDeclaration, type StyleDeclarationBackend } from "../style-declaration.js";
import type { EventHandlerName } from "../event-handler-names.js";
import type { AttrCls as AttrImpl, DOMTokenListCls } from "../collections.js";
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
  documentImpl as document,
  makeHtmlCollection,
  nodeFor,
  scopedQuerySelector,
  scopedQuerySelectorAll,
  filterByQualifiedName,
  windowObj,
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
import {
  stampDetachedSubtreeNamedGlobals,
  stampNamedGlobal,
  stampSubtreeNamedGlobals,
} from "../window.js";
import { dispatchTrustedEvent } from "../events/dispatch.js";
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
  DOCUMENT_FRAGMENT_NODE,
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
import { normalizeScrollArgs, type NormalizedScrollArgs } from "../util/scroll-args.js";
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
  dropUnwrappedSubtrees,
} from "../node-base.js";
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

const attributeStyleMaps = new WeakMap<object, StylePropertyMap>();
const computedStyleMaps = new WeakMap<object, ReturnType<typeof makeComputedStyleMap>>();
const inlineStyleResync = new WeakMap<object, (text: string | null) => void>();
const inlineStyleProxies = new WeakMap<object, ReturnType<typeof makeStyleDeclaration>>();
const longhandKeysCache = new Map<string, string[]>();
const parsedAttributeNamespaceSync = new WeakMap<object, { info: unknown; attrSeq: number }>();
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

function isAttributeNamespaceRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clearParsedAttributeNamespaces(
  el: { _id: number },
  nsMap: NonNullable<ReturnType<typeof attrNs.get>>,
) {
  for (const [name, info] of nsMap) {
    if (info.parsed) nsMap.delete(name);
  }
  if (nsMap.size === 0) {
    attrNs.delete(el._id);
    return undefined;
  }
  return nsMap;
}

function isParsedNamespaceEntry(info: Record<string, unknown>): info is Record<string, unknown> & {
  qualifiedName: string;
  namespaceURI: string;
  localName: string;
} {
  return (
    typeof info?.qualifiedName === "string" &&
    typeof info.namespaceURI === "string" &&
    typeof info.localName === "string"
  );
}

function addParsedNamespaceEntry(
  nsMap: NonNullable<ReturnType<typeof attrNs.get>>,
  info: Record<string, unknown> & {
    qualifiedName: string;
    namespaceURI: string;
    localName: string;
  },
): void {
  const existing = nsMap.get(info.qualifiedName);
  if (existing && !existing.parsed) return;
  nsMap.set(info.qualifiedName, {
    ns: info.namespaceURI,
    prefix: typeof info.prefix === "string" ? info.prefix : null,
    localName: info.localName,
    qname: info.qualifiedName,
    parsed: true,
  });
}

function addParsedAttributeNamespaces(
  el: { _id: number },
  parsed: unknown[],
  nsMap: NonNullable<ReturnType<typeof attrNs.get>>,
) {
  for (const rawInfo of parsed) {
    if (!isAttributeNamespaceRecord(rawInfo)) continue;
    if (!isParsedNamespaceEntry(rawInfo)) continue;
    addParsedNamespaceEntry(nsMap, rawInfo);
  }
  fastpathMarkSpecial(el._id);
}

function updateParsedNamespaceMap(
  el: { _id: number; _info?: unknown },
  info: unknown,
  parsed: unknown,
  nsMap: ReturnType<typeof attrNs.get>,
  attrSeq: number,
): void {
  if (nsMap) nsMap = clearParsedAttributeNamespaces(el, nsMap);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    parsedAttributeNamespaceSync.set(el, { info, attrSeq });
    return;
  }
  if (!nsMap) {
    nsMap = new Map();
    attrNs.set(el._id, nsMap);
  }
  addParsedAttributeNamespaces(el, parsed, nsMap);
  parsedAttributeNamespaceSync.set(el, { info, attrSeq });
}

function hasNoParsedNamespaces(parsed: unknown): boolean {
  return !Array.isArray(parsed) || parsed.length === 0;
}

function alreadySyncedParsedNamespaces(
  previousSync: { info: unknown; attrSeq: number } | undefined,
  info: unknown,
  attrSeq: number,
): boolean {
  return (
    previousSync !== undefined && previousSync.info === info && previousSync.attrSeq === attrSeq
  );
}

function syncParsedAttributeNamespaces(el: { _id: number; _info?: unknown }): void {
  const info = el._info;
  const parsed = isAttributeNamespaceRecord(info) ? info.attributeNamespaces : undefined;
  const nsMap = attrNs.get(el._id);
  if (!nsMap && hasNoParsedNamespaces(parsed)) return;
  const attrSeq = ksState().attrSeq | 0;
  const previousSync = parsedAttributeNamespaceSync.get(el);
  if (alreadySyncedParsedNamespaces(previousSync, info, attrSeq)) return;

  updateParsedNamespaceMap(el, info, parsed, nsMap, attrSeq);
}

function sameSequenceAttrFlat(el: Element, seq: number): string[] | null {
  if (el._attrFlatCache !== null && el._attrFlatCacheSeq === seq) {
    syncParsedAttributeNamespaces(el);
    return el._attrFlatCache;
  }
  return null;
}

function invalidatedAttrFlat(el: Element, seq: number): string[] | null {
  if (el._attrFlatCache !== null && el._attrFlatCacheSeq !== seq) el._attrFlatCache = null;
  if (el._attrFlatCache !== null) {
    syncParsedAttributeNamespaces(el);
    return el._attrFlatCache;
  }
  return null;
}

function sameMutationAttrFlat(el: Element, mutationSeq: number, attrSeq: number): string[] | null {
  if (el._typeCheckSeq === mutationSeq && el._info && el._info.attributes) {
    const arr = el._info.attributes;
    el._attrFlatCache = arr;
    el._attrFlatCacheSeq = attrSeq;
    syncParsedAttributeNamespaces(el);
    return arr;
  }
  return null;
}

function freshAttrFlat(el: Element, attrSeq: number): string[] {
  try {
    const fresh = dom.nodeInfo(el._id);
    const arr = (fresh && fresh.attributes) || [];
    el._attrFlatCache = arr;
    el._attrFlatCacheSeq = attrSeq;
    if (fresh) el._info = fresh;
    syncParsedAttributeNamespaces(el);
    return arr;
  } catch {
    return [];
  }
}

function localPartOfName(qname: string): string {
  const colon = qname.indexOf(":");
  return colon >= 0 ? qname.slice(colon + 1) : qname;
}

function matchesElementNamespaceName(liveName: string, qname: string, local: string): boolean {
  return !liveName || liveName === qname || liveName === local;
}

function liveElementName(el: Element): string {
  return String(el._info?.nodeName || "").toLowerCase();
}

function nullableElementNamespace(
  el: Element,
  entry: ReturnType<typeof elemNs.get>,
): { found: true; ns: string | null } | { found: false } {
  if (entry !== undefined && entry.ns == null) {
    const liveName = liveElementName(el);
    const qname = entry.qname.toLowerCase();
    const local = localPartOfName(qname);
    if (matchesElementNamespaceName(liveName, qname, local)) return { found: true, ns: entry.ns };
  }
  return { found: false };
}

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

function syncCheckedInputs(
  inputs: Iterable<number>,
  checked: Set<number>,
  domHandle: typeof dom,
): void {
  if (typeof domHandle.setCheckboxChecked !== "function") return;
  for (const id of inputs) {
    try {
      domHandle.setCheckboxChecked(id, checked.has(id));
    } catch {}
  }
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
  const domHandle = dom;
  syncCheckedInputs(inputs, checked, domHandle);
}

function needsSvgTextOutlines(html: string, contextNs: string | null): boolean {
  return (
    html.length !== 0 &&
    /<text[\s/>]/i.test(html) &&
    (/<svg[\s/>]/i.test(html) || contextNs === SVG_NS)
  );
}

function demandSvgTextOutlines(html: string, contextNs: string | null) {
  if (needsSvgTextOutlines(html, contextNs)) {
    try {
      ksGlobal.__ksFontOutlineDemand?.();
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
  if (html.indexOf("id") !== -1) stampDetachedSubtreeNamedGlobals(fragment._id);
}

// Bind on first use. The `dom` binding is null until initState runs.
// Older wasm builds do not have these methods, so callers use recordOp instead.
let domSetAttr: ((nodeId: number, name: string, value: string) => boolean) | null = null;
let domRemoveAttr: ((nodeId: number, name: string) => boolean) | null = null;
let domAttrFnsBound = false;
function ensureDomAttrFns() {
  if (domAttrFnsBound) return;
  domAttrFnsBound = true;
  const d = dom;
  domSetAttr = typeof d.setAttribute === "function" ? d.setAttribute.bind(d) : null;
  domRemoveAttr = typeof d.removeAttribute === "function" ? d.removeAttribute.bind(d) : null;
}

function exposedAttributeName(nsMap: ReturnType<typeof attrNs.get>, wasmKey: string): string {
  if (nsMap) {
    const info = nsMap.get(wasmKey);
    if (info && info.qname) return info.qname;
  }
  return wasmKey;
}

function normalizedAttributeNamespace(namespace: string | null): string | null {
  return namespace ? String(namespace) : null;
}

function findAttributeKey(flat: string[], nsMap: ReturnType<typeof attrNs.get>, lookup: string) {
  for (let i = 0; i < flat.length; i += 2) {
    const k = flat[i];
    if (exposedAttributeName(nsMap, k) === lookup) return k;
  }
  return null;
}

function attributeValueByKey(flat: string[], wasmKey: string): string | null {
  for (let i = 0; i < flat.length; i += 2) {
    if (flat[i] === wasmKey) return flat[i + 1];
  }
  return null;
}

function unnamespacedAttributeValue(
  flat: string[],
  localName: string,
  nsMap: ReturnType<typeof attrNs.get>,
): string | null {
  for (let i = 0; i < flat.length; i += 2) {
    if (flat[i] === localName && (!nsMap || !nsMap.has(localName))) return flat[i + 1];
  }
  return null;
}

function customAttributeChangedHook(el: Element, name: string) {
  return ksGlobal.__ks_customElementObservesAttribute?.(el, name) &&
    typeof ksGlobal.__ks_notifyCustomElementAttributeChanged === "function"
    ? ksGlobal.__ks_notifyCustomElementAttributeChanged
    : null;
}

function notifyCustomAttributeChange(
  hook: ReturnType<typeof customAttributeChangedHook>,
  el: Element,
  name: string,
  oldValue: string | null,
  newValue: string | null,
  ns: string | null,
): void {
  if (hook) hook(el, name, oldValue, newValue, ns);
}

function notifyRemovedCustomAttributeChange(
  hook: ReturnType<typeof customAttributeChangedHook>,
  el: Element,
  removingNs: { localName: string } | undefined,
  lookup: string,
  oldValue: string | null,
  exposedNs: string | null,
): void {
  if (hook) hook(el, removingNs ? removingNs.localName : lookup, oldValue, null, exposedNs);
}

function removedAttributeOldValue(
  el: Element,
  wasmKey: string,
  hook: ReturnType<typeof customAttributeChangedHook>,
): string | null {
  return mutationObserverCount() === 0 && !hook
    ? null
    : attributeValueByKey(el._attrFlat(), wasmKey);
}

function observedAttributeOldValue(
  el: Element,
  name: string,
  hook: ReturnType<typeof customAttributeChangedHook>,
): string | null {
  return mutationObserverCount() === 0 && !hook ? null : el.getAttribute(name);
}

function finishAttributeRemoval(
  el: Element,
  lookup: string,
  removingNs: { qname: string; ns: string | null; localName: string } | undefined,
  oldValue: string | null,
  hook: ReturnType<typeof customAttributeChangedHook>,
  isHtmlElement: boolean,
  resanitize: { needed: boolean; oldInputType: string | null },
): void {
  const exposedName = removingNs ? removingNs.qname : lookup;
  const exposedNs = removingNs ? removingNs.ns : null;
  recordAttributeMutation(el._id, exposedName, exposedNs, oldValue);
  notifyRemovedCustomAttributeChange(hook, el, removingNs, lookup, oldValue, exposedNs);
  resyncInlineStyle(el, exposedName, null);
  afterIframeAttributeChange(el, isHtmlElement, lookup);
  if (isHtmlElement) el[attributeChangeSteps](lookup, null);
  scheduleAttributeSlotchange(el, lookup);
  if (resanitize.needed) resanitizeAttribute(el, resanitize.oldInputType);
}

function removedAttributeLookup(name: string, isHtmlElement: boolean): string {
  return isHtmlElement ? asciiLowercase(name) : name;
}

function removeAttrIsHtmlElement(id: number): boolean {
  const elNs = elemNs.get(id);
  return !elNs || elNs.ns === HTML_NS;
}

function toggleForcedAttribute(el: Element, name: string, has: boolean, force: boolean): boolean {
  if (force === true) {
    if (!has) el.setAttribute(name, "");
    return true;
  }
  if (has) el.removeAttribute(name);
  return false;
}

function validateAttributeNodeOwner(el: Element, attr: AttrImpl): void {
  if (invalidAttributeNode(attr)) {
    throw new (ksGlobal.DOMException || Error)(
      "setAttributeNode: argument must be an Attr",
      "TypeError",
    );
  }
  const owner = attr._ownerElement;
  if (owner && owner !== el) {
    throw new DOMException(
      "setAttributeNode: attribute is already in use by another element",
      "InUseAttributeError",
    );
  }
}

function invalidAttributeNode(attr: AttrImpl): boolean {
  return !attr || typeof attr !== "object";
}

function resyncInlineStyle(el: Element, name: string, value: string | null): void {
  if (name === "style") {
    const resync = inlineStyleResync.get(el);
    if (resync) resync(value);
  }
}

function attributeOldInputType(el: Element, name: string, needsResanitize: boolean) {
  return needsResanitize && name === "type" ? inputTypeOf(el) : null;
}

function maybeInstallAttributeHandler(el: Element, name: string, value: string): void {
  if (
    name.length > 2 &&
    name.charCodeAt(0) === 111 &&
    name.charCodeAt(1) === 110 &&
    idlEventHandlerNameSet.has(name)
  ) {
    installAttrEventHandler(el, name, value);
  }
}

function resanitizeAttribute(el: Element, oldInputType: string | null): void {
  if (oldInputType != null) ksHandleInputTypeChange(el, oldInputType);
  else ksResanitizeInputValue(el);
}

function scheduleAttributeSlotchange(el: Element, name: string): void {
  if (name === "slot") {
    try {
      maybeScheduleSlotchange(dom.parentId(el._id));
    } catch {}
  } else if (name === "name") {
    maybeScheduleSlotchange(el._id);
  }
}

function afterIframeAttributeChange(el: Element, isHtmlElement: boolean, name: string): void {
  if (isConnectedIframeSrcChange(el, isHtmlElement, name)) {
    const iframeSrcHook = getInternalState().afterIframeSrcChange;
    if (typeof iframeSrcHook === "function") {
      try {
        iframeSrcHook(el);
      } catch {}
    }
  }
}

function isConnectedIframeSrcChange(el: Element, isHtmlElement: boolean, name: string): boolean {
  return (
    isHtmlElement &&
    (name === "src" || name === "srcdoc") &&
    el.localName === "iframe" &&
    el.isConnected
  );
}

function setWasmAttribute(el: Element, finalName: string, strValue: string): void {
  ensureDomAttrFns();
  if (domSetAttr) {
    if (domSetAttr(el._id, finalName, strValue)) {
      bumpMutationSeq({ attribute: finalName, node: el._id });
      if (finalName === "id") stampNamedGlobal(el._id, strValue);
      if (ksGlobal.__ks_cdpDomActive) {
        cdpMutations.push({
          kind: "attributeModified",
          nodeId: el._id,
          name: finalName,
          value: strValue,
        });
      }
    }
  } else {
    recordOp({ kind: "setAttribute", node: el._id, name: finalName, value: strValue });
  }
}

function removeWasmAttribute(el: Element, wasmKey: string): void {
  ensureDomAttrFns();
  if (domRemoveAttr) {
    if (domRemoveAttr(el._id, wasmKey)) {
      bumpMutationSeq({ attribute: wasmKey, node: el._id });
      if (wasmKey === "id") stampNamedGlobal(el._id, "");
      if (ksGlobal.__ks_cdpDomActive) {
        cdpMutations.push({ kind: "attributeRemoved", nodeId: el._id, name: wasmKey });
      }
    }
  } else {
    recordOp({ kind: "removeAttribute", node: el._id, name: wasmKey });
  }
}

function detachCachedAttr(el: Element, wasmKey: string): void {
  const cache = attrInstances.get(el);
  const attr = cache?.get(wasmKey);
  if (attr) {
    attr._ownerElement = null;
    cache?.delete(wasmKey);
  }
}

function validateQualifiedAttrName(qn: string): void {
  validateAttrName(qn);
  const colonCount = (qn.match(/:/g) || []).length;
  if (colonCount > 0) {
    const ci = qn.indexOf(":");
    if (invalidQualifiedColon(colonCount, ci, qn.length)) {
      throw new DOMException(
        "'" + qn + "' is not a valid qualified attribute name",
        "InvalidCharacterError",
      );
    }
  }
}

function invalidQualifiedColon(count: number, index: number, length: number): boolean {
  return count > 1 || index === 0 || index === length - 1;
}

function validateAttributeNamespace(
  qualifiedName: string,
  prefix: string | null,
  ns: string | null,
): void {
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
  validateXmlnsAttributeNamespace(qualifiedName, prefix, ns);
}

function validateXmlnsAttributeNamespace(
  qualifiedName: string,
  prefix: string | null,
  ns: string | null,
): void {
  if ((qualifiedName === "xmlns" || prefix === "xmlns") && ns !== XMLNS_NS) {
    throw new DOMException(
      "setAttributeNS: 'xmlns' qualifies only the XMLNS namespace",
      "NamespaceError",
    );
  }
  validateXmlnsNamespaceRequiresName(qualifiedName, prefix, ns);
}

function validateXmlnsNamespaceRequiresName(
  qualifiedName: string,
  prefix: string | null,
  ns: string | null,
): void {
  if (ns === XMLNS_NS && qualifiedName !== "xmlns" && prefix !== "xmlns") {
    throw new DOMException(
      "setAttributeNS: XMLNS namespace requires the 'xmlns' qname or prefix",
      "NamespaceError",
    );
  }
}

function existingNsAttributeKey(
  nsMap: NonNullable<ReturnType<typeof attrNs.get>>,
  ns: string | null,
  localName: string,
): string | null {
  for (const [k, info] of nsMap) {
    if (info.ns === ns && info.localName === localName) return k;
  }
  return null;
}

function nsAttributeKey(
  nsMap: NonNullable<ReturnType<typeof attrNs.get>>,
  flat: string[],
  qualifiedName: string,
  ns: string | null,
  existingKey: string | null,
): string {
  if (existingKey) return existingKey;
  if (nsMap.has(qualifiedName)) return namespacedCollisionKey(ns, qualifiedName);
  for (let i = 0; i < flat.length; i += 2) {
    if (flat[i] === qualifiedName) return namespacedCollisionKey(ns, qualifiedName);
  }
  return qualifiedName;
}

function splitQualifiedAttrName(qualifiedName: string) {
  const colon = qualifiedName.indexOf(":");
  const prefix = colon >= 0 ? qualifiedName.slice(0, colon) : null;
  const localName = colon >= 0 ? qualifiedName.slice(colon + 1) : qualifiedName;
  return { prefix, localName };
}

function existingAttributeValue(flat: string[], existingKey: string | null): string | null {
  return existingKey ? attributeValueByKey(flat, existingKey) : null;
}

function namespacedAttributeValue(
  el: Element,
  nsMap: NonNullable<ReturnType<typeof attrNs.get>>,
  ns: string | null,
  localName: string,
): { found: boolean; value: string | null } {
  for (const [qname, info] of nsMap) {
    if (info.ns !== ns || info.localName !== localName) continue;
    return { found: true, value: attributeValueByKey(el._attrFlat(), qname) };
  }
  return { found: false, value: null };
}

function namespacedCollisionKey(ns: string | null, qualifiedName: string): string {
  return "\u0000" + (ns || "") + "\u0000" + qualifiedName;
}

function removeNamespacedAttribute(
  el: Element,
  nsMap: NonNullable<ReturnType<typeof attrNs.get>>,
  cache: ReturnType<typeof attrInstances.get>,
  wasmKey: string,
  localName: string,
  ns: string | null,
  customAttributeHook: ReturnType<typeof customAttributeChangedHook>,
): void {
  const attr = cache?.get(wasmKey);
  if (attr) {
    attr._ownerElement = null;
    cache?.delete(wasmKey);
  }
  const oldValue = attributeValueByKey(el._attrFlat(), wasmKey);
  el._attrFlatCache = null;
  recordOp({ kind: "removeAttribute", node: el._id, name: wasmKey });
  nsMap.delete(wasmKey);
  recordAttributeMutation(el._id, localName, ns, oldValue);
  if (customAttributeHook) customAttributeHook(el, localName, oldValue, null, ns);
}

function removeUnnamespacedAttribute(
  el: Element,
  cache: ReturnType<typeof attrInstances.get>,
  flat: string[],
  index: number,
  localName: string,
  customAttributeHook: ReturnType<typeof customAttributeChangedHook>,
): void {
  const attr = cache?.get(localName);
  if (attr) {
    attr._ownerElement = null;
    cache?.delete(localName);
  }
  const oldValue = flat[index + 1];
  el._attrFlatCache = null;
  recordOp({ kind: "removeAttribute", node: el._id, name: localName });
  recordAttributeMutation(el._id, localName, null, oldValue);
  if (customAttributeHook) customAttributeHook(el, localName, oldValue, null, null);
}

function removeMatchingNamespacedAttribute(
  el: Element,
  nsMap: NonNullable<ReturnType<typeof attrNs.get>>,
  cache: ReturnType<typeof attrInstances.get>,
  ns: string | null,
  localName: string,
  hook: ReturnType<typeof customAttributeChangedHook>,
): boolean {
  for (const [wasmKey, info] of nsMap) {
    if (info.ns !== ns || info.localName !== localName) continue;
    removeNamespacedAttribute(el, nsMap, cache, wasmKey, localName, ns, hook);
    return true;
  }
  return false;
}

function removeMatchingUnnamespacedAttribute(
  el: Element,
  nsMap: ReturnType<typeof attrNs.get>,
  cache: ReturnType<typeof attrInstances.get>,
  localName: string,
  hook: ReturnType<typeof customAttributeChangedHook>,
): void {
  const flat = el._attrFlat();
  for (let i = 0; i < flat.length; i += 2) {
    if (flat[i] !== localName || (nsMap && nsMap.has(localName))) continue;
    removeUnnamespacedAttribute(el, cache, flat, i, localName, hook);
    return;
  }
}

function removeNSAttributeWithMap(
  el: Element,
  nsMap: ReturnType<typeof attrNs.get>,
  cache: ReturnType<typeof attrInstances.get>,
  ns: string | null,
  localName: string,
  hook: ReturnType<typeof customAttributeChangedHook>,
): void {
  if (nsMap && removeMatchingNamespacedAttribute(el, nsMap, cache, ns, localName, hook)) return;
  if (ns === null) removeMatchingUnnamespacedAttribute(el, nsMap, cache, localName, hook);
}

function attrMetadataForKey(nsInfo: ReturnType<typeof attrInfoForKey>, wasmKey: string) {
  // setAttribute uses the whole name as the local name, even with a colon.
  // https://dom.spec.whatwg.org/#dom-element-setattribute
  const namespaceURI = nsInfo ? nsInfo.ns : null;
  const prefix = nsInfo ? nsInfo.prefix : null;
  const localName = nsInfo ? nsInfo.localName : wasmKey;
  const exposedName = nameForAttrInfo(nsInfo, wasmKey);
  return { namespaceURI, prefix, localName, exposedName };
}

function makeAttrForKey(el: Element, metadata: ReturnType<typeof attrMetadataForKey>): AttrImpl {
  const createdAttr: AttrImpl = Object.create(AttrCls.prototype);
  createdAttr._name = metadata.exposedName;
  createdAttr._namespaceURI = metadata.namespaceURI;
  createdAttr._prefix = metadata.prefix;
  createdAttr._localName = metadata.localName;
  createdAttr._ownerElement = el;
  return createdAttr;
}

function attrInfoForKey(nsMap: ReturnType<typeof attrNs.get>, wasmKey: string) {
  return nsMap && nsMap.get(wasmKey);
}

function nameForAttrInfo(nsInfo: ReturnType<typeof attrInfoForKey>, wasmKey: string): string {
  return nsInfo ? nsInfo.qname || wasmKey : wasmKey;
}

function pruneAttrCache(
  cache: NonNullable<ReturnType<typeof attrInstances.get>>,
  seenNames: Set<string>,
) {
  for (const cachedName of Array.from(cache.keys())) {
    if (!seenNames.has(cachedName)) {
      const stale = cache.get(cachedName);
      if (stale) stale._ownerElement = null;
      cache.delete(cachedName);
    }
  }
}

function clearAttrNames(byName: Record<string, AttrImpl>): void {
  for (const key in byName) delete byName[key];
}

function setAttributeFromNode(el: Element, attr: AttrImpl, ns: string | null): void {
  if (ns) el.setAttributeNS(ns, attr.name, attr.value || "");
  else el.setAttribute(attr.name, attr.value || "");
}

function registerInnerHtmlTransientObservers(
  oldChildIds: number[],
  observed: boolean,
  transientlyObserved: boolean,
): void {
  if (transientlyObserved) {
    for (const childId of oldChildIds) {
      if (observed || subtreeHasCachedWrapper(childId)) registerTransientObservers(childId);
    }
  }
}

function recordInnerHtmlChildChanges(target: Element, oldChildren: NodeBase[] | null): void {
  if (oldChildren) {
    const newChildren = Array.from<NodeBase>(target.childNodes);
    if (oldChildren.length > 0 || newChildren.length > 0) {
      recordChildListMutation(target, newChildren, oldChildren, null, null);
    }
  }
}

function replaceInnerHtmlChildren(target: Element, htmlText: string): void {
  const observed = hasChildListObserver(target._id);
  const transientlyObserved = hasSubtreeObserver(target._id);
  const oldChildIds = dom.childIds ? Array.from(dom.childIds(target._id)) : [];
  const oldChildren = observed ? Array.from<NodeBase>(target.childNodes) : null;
  registerInnerHtmlTransientObservers(oldChildIds, observed, transientlyObserved);
  recordOp({ kind: "setInnerHtml", node: target._id, html: htmlText });
  if (!observed) dropUnwrappedSubtrees(oldChildIds);
  recordInnerHtmlChildChanges(target, oldChildren);
  syncCheckedFromAttrs(target);
  if (htmlText.indexOf("id") !== -1) stampSubtreeNamedGlobals(target);
}

function insertOuterHtmlChildren(parent: NodeBase, moved: NodeBase[], refId: number): void {
  for (const k of moved) {
    if (typeof k._id !== "number" || k._id < 0) continue;
    try {
      dom.removeNode(k._id);
    } catch {}
    dom.insertBeforeNode(parent._id, k._id, refId);
  }
}

function recordOuterHtmlInsertions(
  parent: NodeBase,
  moved: NodeBase[],
  prevSibling: NodeBase | null,
) {
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
}

function outerHtmlSiblings(el: Element) {
  const prevSibling = el.previousSibling || null;
  const nextSibling = el.nextSibling || null;
  return { prevSibling, nextSibling };
}

function throwOuterHtmlWithoutParent(): never {
  throw new (ksGlobal.DOMException || Error)(
    "Cannot set outerHTML on an element with no parent",
    "NoModificationAllowedError",
  );
}

function throwOuterHtmlInvalidParent(): never {
  throw new (ksGlobal.DOMException || Error)(
    "Cannot set outerHTML when parent is not an Element or DocumentFragment",
    "NoModificationAllowedError",
  );
}

function renderedInnerText(el: Element): string | null {
  try {
    const s: unknown = dom.innerTextRendered?.(el._id);
    if (typeof s === "string") return s;
  } catch {}
  return null;
}

function replaceWithRenderedText(el: Element, text: string): void {
  const nodes = renderedTextFragmentNodes(text, el.ownerDocument || document);
  el.textContent = "";
  for (const n of nodes) el.appendChild(n);
}

function matchesQualifiedTagNamespace(el: Element, ns: string | null, ln: string): boolean {
  const elNs = elementNamespaceOrNull(el);
  if (ns !== "*" && elNs !== ns) return false;
  if (ln === "*") return true;
  return (el.localName || "") === ln;
}

function elementNamespaceOrNull(el: Element): string | null {
  return el.namespaceURI || null;
}

function legacyOffsetMetrics(
  read: (getMetrics: ((id: number) => unknown) | null) => OffsetMetrics | null,
) {
  try {
    // Older wasm bundles may not expose the optional legacy offsetMetrics method.
    const offsetMetrics: unknown = Reflect.get(dom, "offsetMetrics");
    if (typeof offsetMetrics === "function") {
      const metrics = read((id) => Reflect.apply(offsetMetrics, dom, [id]));
      if (metrics) return metrics;
    }
  } catch {}
  return null;
}

function scrollIntoViewModes(arg?: boolean | Idl.ScrollIntoViewOptions) {
  if (arg === false) return { block: "end", inline: "nearest" };
  if (arg === true || arg == null) return { block: "start", inline: "nearest" };
  if (typeof arg === "object") return scrollIntoViewObjectModes(arg);
  return { block: "start", inline: "nearest" };
}

function scrollIntoViewObjectModes(arg: Idl.ScrollIntoViewOptions) {
  return { block: String(arg.block ?? "start"), inline: String(arg.inline ?? "nearest") };
}

function nearestScrollAxis(elPos: number, elSize: number, viewSize: number, curScroll: number) {
  if (elPos >= curScroll && elPos + elSize <= curScroll + viewSize) return curScroll;
  if (elPos < curScroll) return elPos;
  return elPos + elSize - viewSize;
}

function computeScrollAxis(
  elPos: number,
  elSize: number,
  viewSize: number,
  curScroll: number,
  mode: string,
): number {
  switch (mode) {
    case "start":
      return elPos;
    case "end":
      return elPos + elSize - viewSize;
    case "center":
      return elPos + elSize / 2 - viewSize / 2;
    case "nearest":
      return nearestScrollAxis(elPos, elSize, viewSize, curScroll);
    default:
      return elPos;
  }
}

function unshiftStickyViewport(el: Element, x: number, y: number) {
  try {
    const sh = getStickyShiftByAuthId && getStickyShiftByAuthId(el._id);
    if (sh && sh.length >= 2) {
      x -= stickyOffsetValue(sh[0]);
      y -= stickyOffsetValue(sh[1]);
    }
  } catch {}
  return { x, y };
}

function stickyOffsetValue(value: unknown): number {
  return Number(value) || 0;
}

function scrollAncestorIntoView(
  cur: number,
  info: NonNullable<ReturnType<typeof nodeScrollInfoSafe>>,
  viewport: { x: number; y: number },
  targetSize: { w: number; h: number },
  block: string,
  inline: string,
): void {
  const containerVr = getRect(cur);
  const elInContentX = viewport.x - containerVr.x + info.scrollLeft;
  const elInContentY = viewport.y - containerVr.y + info.scrollTop;
  const targetScrollY = info.overflowsY
    ? Math.max(
        0,
        Math.min(
          computeScrollAxis(elInContentY, targetSize.h, info.clientHeight, info.scrollTop, block),
          info.scrollHeight,
        ),
      )
    : info.scrollTop;
  const targetScrollX = info.overflowsX
    ? Math.max(
        0,
        Math.min(
          computeScrollAxis(elInContentX, targetSize.w, info.clientWidth, info.scrollLeft, inline),
          info.scrollWidth,
        ),
      )
    : info.scrollLeft;
  if (needsAncestorScroll(info, targetScrollX, targetScrollY)) {
    if (setElementScrollOffset(cur, targetScrollX, targetScrollY)) {
      viewport.y += info.scrollTop - targetScrollY;
      viewport.x += info.scrollLeft - targetScrollX;
    }
  }
}

function needsAncestorScroll(
  info: NonNullable<ReturnType<typeof nodeScrollInfoSafe>>,
  targetScrollX: number,
  targetScrollY: number,
): boolean {
  return targetScrollY !== info.scrollTop || targetScrollX !== info.scrollLeft;
}

function scrollAncestorsIntoView(
  el: Element,
  htmlId: number,
  viewport: { x: number; y: number },
  targetSize: { w: number; h: number },
  block: string,
  inline: string,
): void {
  let cur = el._id;
  let safety = 0;
  try {
    cur = dom.parentId(cur);
  } catch {
    cur = -1;
  }
  while (hasScrollAncestor(cur, htmlId, safety)) {
    safety++;
    const info = nodeScrollInfoSafe(cur);
    if (scrollsInEitherAxis(info)) {
      scrollAncestorIntoView(cur, info, viewport, targetSize, block, inline);
    }
    try {
      cur = dom.parentId(cur);
    } catch {
      break;
    }
  }
}

function scrollsInEitherAxis(
  info: ReturnType<typeof nodeScrollInfoSafe>,
): info is NonNullable<ReturnType<typeof nodeScrollInfoSafe>> {
  return !!info && (info.overflowsX || info.overflowsY);
}

function hasScrollAncestor(cur: number, htmlId: number, safety: number): boolean {
  return cur != null && cur >= 0 && cur !== htmlId && safety < MAX_SCROLL_CHAIN_HOPS;
}

function commitElementScroll(el: Element, left: number, top: number): void {
  let offset: unknown = null;
  try {
    offset = dom.setNodeScrollOffset(el._id, left, top);
  } catch {
    return;
  }
  if (!offset) return;
  markDamageNode(el._id);
  bumpMutationSeq();
  fireElementScroll(el);
}

function scrollCoordinate(value: number | null, fallback: number): number {
  return value == null ? fallback : value;
}

function isRootScrollNode(el: Element, htmlId: number, bodyId: number): boolean {
  return el._id === htmlId || el._id === bodyId;
}

function currentScrollInfoPosition(info: ReturnType<typeof nodeScrollInfoSafe>) {
  const curX = info ? info.scrollLeft : 0;
  const curY = info ? info.scrollTop : 0;
  return { curX, curY };
}

function scrollToNormalized(el: Element, norm: NormalizedScrollArgs): void {
  const info = nodeScrollInfoSafe(el._id);
  const { curX, curY } = currentScrollInfoPosition(info);
  const left = scrollCoordinate(norm.left, curX);
  const top = scrollCoordinate(norm.top, curY);
  const htmlId = dom.querySelector("html");
  const bodyId = dom.querySelector("body");
  if (isRootScrollNode(el, htmlId, bodyId)) {
    setScrollOffset(Math.max(0, left), Math.max(0, top));
    return;
  }
  if (!info) return;
  const nx = Math.max(0, Math.min(left, info.scrollWidth));
  const ny = Math.max(0, Math.min(top, info.scrollHeight));
  if (scrollPositionUnchanged(nx, ny, info)) return;
  commitElementScroll(el, nx, ny);
}

function scrollPositionUnchanged(
  nx: number,
  ny: number,
  info: NonNullable<ReturnType<typeof nodeScrollInfoSafe>>,
): boolean {
  return nx === info.scrollLeft && ny === info.scrollTop;
}

function scrollByNormalized(el: Element, norm: NormalizedScrollArgs) {
  const dx = norm.left == null ? 0 : norm.left;
  const dy = norm.top == null ? 0 : norm.top;
  const htmlId = dom.querySelector("html");
  const bodyId = dom.querySelector("body");
  if (isRootScrollNode(el, htmlId, bodyId)) {
    const off = scrollOffset();
    setScrollOffset(Math.max(0, off.x + dx), Math.max(0, off.y + dy));
    return null;
  }
  const info = nodeScrollInfoSafe(el._id);
  if (!info) return null;
  return { left: info.scrollLeft + dx, top: info.scrollTop + dy };
}

function inlineStyleCanon() {
  return opts && typeof opts.canonicalizeInlineStyle === "function"
    ? opts.canonicalizeInlineStyle
    : null;
}

function inlineStyleSerializer() {
  return opts && typeof opts.serializeInlineStyle === "function" ? opts.serializeInlineStyle : null;
}

function inlineStylePropertyReader() {
  return opts && typeof opts.getInlinePropertyValue === "function"
    ? opts.getInlinePropertyValue
    : null;
}

function canSetDomFocus(el: Element): boolean {
  return typeof el._id === "number" && el._id >= 0 && typeof dom.setFocus === "function";
}

function syncElementFocus(el: Element, old: Element | null): void {
  try {
    if (canSetDomFocus(el)) {
      dom.setFocus(el._id);
      if (old) markDamageNode(old._id);
      markDamageNode(el._id);
      bumpMutationSeq();
    }
  } catch {}
}

function syncCheckedInput(el: Element, next: boolean, tag: string): void {
  if (tag === "INPUT") {
    try {
      const domHandle = dom;
      if (typeof domHandle.setCheckboxChecked === "function") {
        domHandle.setCheckboxChecked(el._id, next);
      }
    } catch {}
  }
}

function datasetBacking(): object {
  const DSM = ksGlobal.DOMStringMap;
  return Object.create(DSM && DSM.prototype ? DSM.prototype : Object.prototype);
}

function dispatchFocusLoss(el: Element, relatedTarget: Element | null): void {
  try {
    el.dispatchEvent(
      new KsFocusEvent("blur", {
        bubbles: false,
        cancelable: false,
        composed: true,
        relatedTarget,
      }),
    );
  } catch {}
  try {
    el.dispatchEvent(
      new KsFocusEvent("focusout", {
        bubbles: true,
        cancelable: false,
        composed: true,
        relatedTarget,
      }),
    );
  } catch {}
}

function dispatchFocusGain(el: Element, old: Element | null): void {
  try {
    el.dispatchEvent(
      new KsFocusEvent("focus", {
        bubbles: false,
        cancelable: false,
        composed: true,
        relatedTarget: old || null,
      }),
    );
  } catch {}
  try {
    el.dispatchEvent(
      new KsFocusEvent("focusin", {
        bubbles: true,
        cancelable: false,
        composed: true,
        relatedTarget: old || null,
      }),
    );
  } catch {}
}

function clearDomFocus(el: Element): void {
  try {
    if (typeof dom.clearFocus === "function") {
      dom.clearFocus();
      markDamageNode(el._id);
      bumpMutationSeq();
    }
  } catch {}
}

type CheckVisibilityOptions = {
  checkOpacity?: boolean;
  opacityProperty?: boolean;
  checkVisibilityCSS?: boolean;
  visibilityProperty?: boolean;
};
function hasVisibleLayoutBox(el: Element): boolean {
  return el.isConnected && hasLayoutBox(el._id);
}

function checkAncestorOpacity(el: Element): boolean {
  for (let cur: Element | null = el; cur; cur = flatTreeParentElement(cur)) {
    if (ksGlobal.getComputedStyle(cur).opacity === "0") return false;
  }
  return true;
}

function requestsOpacityCheck(options: CheckVisibilityOptions | undefined): boolean | undefined {
  return options?.checkOpacity || options?.opacityProperty;
}

function requestsVisibilityCheck(options: CheckVisibilityOptions | undefined): boolean | undefined {
  return options?.checkVisibilityCSS || options?.visibilityProperty;
}

function checkVisibilityStyles(el: Element, options: CheckVisibilityOptions | undefined): boolean {
  if (requestsOpacityCheck(options) && !checkAncestorOpacity(el)) return false;
  if (requestsVisibilityCheck(options) && ksGlobal.getComputedStyle(el).visibility !== "visible")
    return false;
  return true;
}

function selectorFailureReason(err: unknown): unknown {
  // Selector failures may be Error objects or plain objects with a message.
  const e = err as { message?: unknown } | null | undefined;
  return e && e.message ? e.message : String(e);
}

function flatTreeParentElement(el: Element): Element | null {
  const slot: unknown = Reflect.get(el, "assignedSlot");
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

function normalizedPseudoType(type: string): string {
  let t = String(type);
  if (t.startsWith("::")) t = t.slice(2);
  else if (t.startsWith(":")) t = t.slice(1);
  return t.toLowerCase();
}

function setElementScrollOffset(nodeId: number, left: number, top: number) {
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
    const el: Element | null = nodeFor(nodeId);
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

function setCheckedRaw(el: Element, val: boolean | undefined): void {
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
}

function finishCheckableClick(
  el: Element,
  ev: KsPointerEvent,
  preChecked: boolean | undefined,
  preIndeterminate: boolean | undefined,
): boolean {
  if (ev.defaultPrevented) {
    setCheckedRaw(el, preChecked);
    Reflect.set(el, "indeterminate", preIndeterminate);
    return true;
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
  return false;
}

function clickHref(el: Element) {
  return el.getAttribute && el.getAttribute("href");
}

function navigateToClickHref(rawHref: string): void {
  try {
    if (windowObj && windowObj.location) {
      windowObj.location.href = rawHref;
    }
  } catch {}
}

function followClickHref(el: Element): void {
  const rawHref = clickHref(el);
  if (typeof rawHref === "string" && rawHref.length > 0) {
    navigateToClickHref(rawHref);
  }
}

function isFirstSummaryCandidate(c: NodeBase | undefined): c is NodeBase {
  return !!c && (c.nodeName || "").toUpperCase() === "SUMMARY";
}

function firstSummaryOf(detailsElement: Element): NodeBase | null {
  const kids: ArrayLike<NodeBase> = detailsElement.childNodes || [];
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (isFirstSummaryCandidate(c)) return c;
  }
  return null;
}

function summaryAncestor(el: Element): NodeBase | null {
  let summaryEl: NodeBase | null = el;
  while (
    summaryEl &&
    summaryEl.nodeType === ELEMENT_NODE &&
    (summaryEl.nodeName || "").toUpperCase() !== "SUMMARY"
  )
    summaryEl = summaryEl.parentNode;
  return summaryEl;
}

function toggleFirstSummary(detailsElement: Element, summaryEl: NodeBase | null): void {
  if (firstSummaryOf(detailsElement) !== summaryEl) return;
  if (detailsElement.hasAttribute("open")) detailsElement.removeAttribute("open");
  else detailsElement.setAttribute("open", "");
  try {
    dispatchTrustedEvent(
      detailsElement,
      new KsEvent("toggle", { bubbles: false, cancelable: false }),
    );
  } catch {}
}

function parentDetailsOfSummary(summaryEl: NodeBase | null): NodeBase | null {
  return summaryEl && (summaryEl.nodeName || "").toUpperCase() === "SUMMARY"
    ? summaryEl.parentNode
    : null;
}

function activateSummary(el: Element): void {
  const summaryEl = summaryAncestor(el);
  const details = parentDetailsOfSummary(summaryEl);
  if (details && (details.nodeName || "").toUpperCase() === "DETAILS") {
    // A DETAILS nodeName identifies an element wrapper; NodeBase types parentNode broadly.
    const detailsElement = details as Element;
    toggleFirstSummary(detailsElement, summaryEl);
  }
}

function maybeFollowClickHref(el: Element, ev: KsPointerEvent, tag: string): void {
  if (!ev.defaultPrevented && tag === "A") followClickHref(el);
}

function afterClickDispatch(el: Element, ev: KsPointerEvent, tag: string): void {
  maybeFollowClickHref(el, ev, tag);
  if (!ev.defaultPrevented) el[activationBehavior]();
  // Only the first summary child toggles its details. Limitation: HTML queues a
  // ToggleEvent after the open attribute changes; this fires a plain event at once.
  // https://html.spec.whatwg.org/#the-summary-element
  if (!ev.defaultPrevented) activateSummary(el);
  if (!ev.defaultPrevented) activateLabel(el);
}

function clickInputType(el: Element, tag: string): string {
  return tag === "INPUT" ? String(el.type || "").toLowerCase() : "";
}

function clickTag(el: Element): string {
  return (el.nodeName || "").toUpperCase();
}

function isCheckableInput(tag: string, type: string): boolean {
  return tag === "INPUT" && (type === "checkbox" || type === "radio");
}

function beginCheckableClick(el: Element, type: string) {
  const preChecked = !!el.checked;
  const preIndeterminate = !!Reflect.get(el, "indeterminate");
  setCheckedRaw(el, type === "checkbox" ? !preChecked : true);
  Reflect.set(el, "indeterminate", false);
  return { preChecked, preIndeterminate };
}

function dispatchClick(el: Element, forwarded: ForwardedClick | null): KsPointerEvent {
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
  return ev;
}

// The forwarded click runs this same algorithm directly, not a page-replaceable control.click().
// Forwarding data stays on the call stack so reentrant or later scripted clicks cannot inherit it.
function runClickSteps(el: Element, forwarded: ForwardedClick | null): void {
  const tag = clickTag(el);
  const type = clickInputType(el, tag);
  const isCheckable = isCheckableInput(tag, type);

  // Disabled controls skip click. Limitation: a disabled fieldset ancestor does not.
  if (el.disabled === true) {
    return;
  }

  let preChecked: boolean | undefined;
  let preIndeterminate: boolean | undefined;
  // Legacy pre-activation sets the checked state before dispatch; cancel restores it.
  // Limitation: radios also clear indeterminate, and cancel does not restore
  // the radio that was checked before the click.
  // https://html.spec.whatwg.org/#the-input-element
  if (isCheckable) {
    ({ preChecked, preIndeterminate } = beginCheckableClick(el, type));
  }

  const ev = dispatchClick(el, forwarded);

  if (isCheckable && finishCheckableClick(el, ev, preChecked, preIndeterminate)) return;

  afterClickDispatch(el, ev, tag);
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
  get form(): Idl.HTMLFormElement | null {
    return null;
  }
  set form(_v: Idl.HTMLFormElement | null) {}
  // Runs after setAttribute or removeAttribute changes an attribute of an HTML element; value is
  // null for a removal. Limitation: the other attribute mutation paths do not run it.
  // https://dom.spec.whatwg.org/#concept-element-attributes-change-ext
  [attributeChangeSteps](_localName: string, _value: string | null): void {}
  // Runs after a click() dispatch nobody canceled. Limitation: click() itself still runs the
  // checkbox, anchor, summary and label steps.
  // https://dom.spec.whatwg.org/#eventtarget-activation-behavior
  [activationBehavior](): void {}
  constructor(nodeId: number, info: unknown) {
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
    const nullableNs = nullableElementNamespace(this, entry);
    if (nullableNs.found) return nullableNs.ns;
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
    const cached = sameSequenceAttrFlat(this, curSeqEarly);
    if (cached !== null) return cached;
    const invalidated = invalidatedAttrFlat(this, curSeqEarly);
    if (invalidated !== null) return invalidated;
    const curSeq = ksState().mutationSeq | 0;
    const sameMutation = sameMutationAttrFlat(this, curSeq, curSeqEarly);
    if (sameMutation !== null) return sameMutation;
    return freshAttrFlat(this, curSeqEarly);
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
    return this.getAttribute(name) !== null;
  }
  hasAttributes() {
    return this._attrFlat().length > 0;
  }
  setAttribute(name: string, value: string) {
    const nm = String(name ?? "");
    validateAttrName(nm);
    const isHtmlElement = this.namespaceURI === HTML_NS;
    const finalName = isHtmlElement ? asciiLowercase(nm) : nm;
    const customAttributeHook = customAttributeChangedHook(this, finalName);
    const oldValue = observedAttributeOldValue(this, finalName, customAttributeHook);
    const needsResanitize = ksAttrNeedsResanitize(this, finalName);
    const oldInputType = attributeOldInputType(this, finalName, needsResanitize);
    this._attrFlatCache = null;
    const strValue = String(value);
    setWasmAttribute(this, finalName, strValue);
    recordAttributeMutation(this._id, finalName, null, oldValue);
    notifyCustomAttributeChange(customAttributeHook, this, finalName, oldValue, strValue, null);
    resyncInlineStyle(this, finalName, strValue);
    scheduleAttributeSlotchange(this, finalName);
    afterIframeAttributeChange(this, isHtmlElement, finalName);
    if (isHtmlElement) this[attributeChangeSteps](finalName, strValue);
    maybeInstallAttributeHandler(this, finalName, strValue);
    if (needsResanitize) resanitizeAttribute(this, oldInputType);
  }
  removeAttribute(name: string) {
    if (typeof name !== "string" || name.length === 0) return;
    const isHtmlElement = removeAttrIsHtmlElement(this._id);
    const lookup = removedAttributeLookup(name, isHtmlElement);
    const customAttributeHook = customAttributeChangedHook(this, lookup);
    const flat = this._attrFlat();
    const nsMap = attrNs.get(this._id);
    const wasmKey = findAttributeKey(flat, nsMap, lookup);
    if (wasmKey === null) return;
    const needsResanitize = ksAttrNeedsResanitize(this, lookup);
    const oldInputType = attributeOldInputType(this, lookup, needsResanitize);
    detachCachedAttr(this, wasmKey);
    const removingNs = attrInfoForKey(nsMap, wasmKey);
    const oldValue = removedAttributeOldValue(this, wasmKey, customAttributeHook);
    if (nsMap) nsMap.delete(wasmKey);
    this._attrFlatCache = null;
    removeWasmAttribute(this, wasmKey);
    finishAttributeRemoval(this, lookup, removingNs, oldValue, customAttributeHook, isHtmlElement, {
      needed: needsResanitize,
      oldInputType,
    });
  }
  toggleAttribute(name: string, force?: boolean) {
    validateAttrName(String(name ?? ""));
    const lower = asciiLowercase(String(name));
    const has = this.getAttribute(lower) !== null;
    if (force === true || force === false) return toggleForcedAttribute(this, lower, has, force);
    if (has) {
      this.removeAttribute(lower);
      return false;
    }
    this.setAttribute(lower, "");
    return true;
  }
  setAttributeNS(namespace: string | null, qualifiedName: string, value: string) {
    // Limitation: DOM splits at the first colon, so "a:b:c" is valid there.
    // This rejects it.
    // https://dom.spec.whatwg.org/#validate-and-extract
    const qn = String(qualifiedName ?? "");
    validateQualifiedAttrName(qn);
    qualifiedName = qn;
    const ns = normalizedAttributeNamespace(namespace);
    const { prefix, localName } = splitQualifiedAttrName(qualifiedName);
    const customAttributeHook = customAttributeChangedHook(this, localName);
    validateAttributeNamespace(qualifiedName, prefix, ns);
    const flat = this._attrFlat();
    // Wasm keeps only qualified names, so namespace identity lives in this side table.
    // Nodes using it stay off the Rust fast path, which sees only the flattened key.
    let nsMap = attrNs.get(this._id);
    if (!nsMap) {
      nsMap = new Map();
      attrNs.set(this._id, nsMap);
      fastpathMarkSpecial(this._id);
    }
    const existingKey = existingNsAttributeKey(nsMap, ns, localName);
    const finalKey = nsAttributeKey(nsMap, flat, qualifiedName, ns, existingKey);
    const oldValue = existingAttributeValue(flat, existingKey);
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
    notifyCustomAttributeChange(customAttributeHook, this, localName, oldValue, strValue, ns);
  }
  getAttributeNS(namespace: string | null, localName: string) {
    if (typeof localName !== "string") return null;
    const ns = normalizedAttributeNamespace(namespace);
    const nsMap = attrNs.get(this._id);
    if (nsMap) {
      const matched = namespacedAttributeValue(this, nsMap, ns, localName);
      if (matched.found) return matched.value;
    }
    if (ns === null) {
      return unnamespacedAttributeValue(this._attrFlat(), localName, nsMap);
    }
    return null;
  }
  hasAttributeNS(namespace: string | null, localName: string) {
    return this.getAttributeNS(namespace, localName) !== null;
  }
  removeAttributeNS(namespace: string | null, localName: string) {
    if (typeof localName !== "string" || localName.length === 0) return;
    const ns = normalizedAttributeNamespace(namespace);
    const customAttributeHook = customAttributeChangedHook(this, localName);
    const nsMap = attrNs.get(this._id);
    const cache = attrInstances.get(this);
    removeNSAttributeWithMap(this, nsMap, cache, ns, localName, customAttributeHook);
  }

  _syncAttrEntries(list: AttrImpl[], byName: Record<string, AttrImpl>): void {
    const flat = this._attrFlat();
    list.length = 0;
    clearAttrNames(byName);
    const nsMap = attrNs.get(this._id);
    let cache = attrInstances.get(this);
    if (!cache) {
      cache = new Map();
      attrInstances.set(this, cache);
    }
    const seenNames = new Set<string>();
    for (let i = 0; i < flat.length; i += 2) {
      const wasmKey = flat[i];
      const value = flat[i + 1];
      seenNames.add(wasmKey);
      const nsInfo = attrInfoForKey(nsMap, wasmKey);
      const metadata = attrMetadataForKey(nsInfo, wasmKey);
      let attr = cache.get(wasmKey);
      if (!attr) {
        const createdAttr = makeAttrForKey(this, metadata);
        cache.set(wasmKey, createdAttr);
        attr = createdAttr;
      }
      attr._value = value;
      attr._nodeValue = value;
      attr._textContent = value;
      list.push(attr);
      if (!(metadata.exposedName in byName)) byName[metadata.exposedName] = attr;
    }
    pruneAttrCache(cache, seenNames);
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
    validateAttributeNodeOwner(this, attr);
    const previous = this.getAttributeNode(attr.name);
    if (previous && previous !== attr) {
      previous._ownerElement = null;
    }
    const ns = attr.namespaceURI;
    setAttributeFromNode(this, attr, ns);
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
      replaceInnerHtmlChildren(frag, htmlText);
      return;
    }
    replaceInnerHtmlChildren(this, htmlText);
  }
  get content(): ReturnType<typeof ensureTemplateContent> | undefined {
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
    if (!parent) throwOuterHtmlWithoutParent();
    if (parent.nodeType !== ELEMENT_NODE && parent.nodeType !== DOCUMENT_FRAGMENT_NODE) {
      throwOuterHtmlInvalidParent();
    }
    const tmp: Element = createElementInternal("div");
    tmp.innerHTML = htmlText;
    const moved: NodeBase[] = Array.from<NodeBase>(tmp.childNodes);
    const { prevSibling, nextSibling } = outerHtmlSiblings(this);
    const refId = this._id;
    insertOuterHtmlChildren(parent, moved, refId);
    const removedSelfId = this._id;
    runIteratorPreRemove(this);
    try {
      dom.removeNode(this._id);
    } catch {}
    bumpMutationSeq();
    recordOuterHtmlInsertions(parent, moved, prevSibling);
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
    const rendered = renderedInnerText(this);
    if (rendered !== null) return rendered;
    return this.textContent;
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
    replaceWithRenderedText(this, v);
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
        if (n && n.nodeType === ELEMENT_NODE) out.push(n);
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
        return cand.filter((el) => matchesQualifiedTagNamespace(el, ns, ln));
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
      throw new DOMException(
        "Failed to execute 'matches' on 'Element': '" +
          sel +
          "' is not a valid selector. " +
          selectorFailureReason(err),
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
      return matchedId >= 0 ? nodeFor(matchedId) : null;
    } catch (err) {
      throw new DOMException(
        "Failed to execute 'closest' on 'Element': '" +
          sel +
          "' is not a valid selector. " +
          selectorFailureReason(err),
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
    if (!hasVisibleLayoutBox(this)) return false;
    return checkVisibilityStyles(this, options);
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
    const t = normalizedPseudoType(type);
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
    const { block, inline } = scrollIntoViewModes(arg);

    const htmlId = dom.querySelector("html");
    const targetVr = getRect(this._id);
    const targetSize = { w: targetVr.width, h: targetVr.height };

    // Limitation: css-position-3 targets a sticky box at its offset position.
    // This subtracts the shift and targets the unshifted position.
    // https://drafts.csswg.org/css-position-3/#stickypos-scroll
    const viewport = unshiftStickyViewport(this, targetVr.x, targetVr.y);
    scrollAncestorsIntoView(this, htmlId, viewport, targetSize, block, inline);

    const cur2 = scrollOffset();
    const viewportH = Number(ksGlobal.innerHeight) || DEFAULT_VIEWPORT_HEIGHT_CSS_PX;
    const viewportW = Number(ksGlobal.innerWidth) || DEFAULT_VIEWPORT_WIDTH_CSS_PX;
    const docTop = viewport.y + cur2.y;
    const docLeft = viewport.x + cur2.x;
    const targetY = computeScrollAxis(docTop, targetSize.h, viewportH, cur2.y, block);
    const targetX = computeScrollAxis(docLeft, targetSize.w, viewportW, cur2.x, inline);
    setScrollOffset(Math.max(0, targetX), Math.max(0, targetY));
  }
  scrollTo(_xOrOptions?: unknown, _y?: unknown): Promise<void> {
    const self = this;
    const args = arguments;
    return (async () => {
      const norm = normalizeScrollArgs(args, "scrollTo");
      if (norm === null) return;
      scrollToNormalized(self, norm);
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
      const target = scrollByNormalized(self, norm);
      if (target) await self.scrollTo(target.left, target.top);
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
    const legacyMetrics = legacyOffsetMetrics(read);
    if (legacyMetrics) return legacyMetrics;
    const rect = getRect(this._id);
    const scroll = scrollOffset();
    return { parent: -1, top: rect.y + scroll.y, left: rect.x + scroll.x };
  }
  get offsetParent(): Idl.Element | null {
    const metrics = this._offsetMetrics();
    const parentId = Number(metrics.parent);
    return parentId >= 0 ? nodeFor(parentId) : null;
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

      const canon = inlineStyleCanon();
      const serializeCanon = inlineStyleSerializer();
      const getCanonValue = inlineStylePropertyReader();

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
      const parseInlineCanon = (dashName: string, rawVal: string) => {
        if (!canon) return [];
        try {
          return canon(`${dashName}: ${rawVal}`);
        } catch {
          return [];
        }
      };
      const parseInlineDeclaration = (k: string, rawVal: string, dashName: string) => {
        const cached = parsedValues.get(k);
        if (cached?.value === rawVal) return cached.declarations;
        const parsed = parseInlineCanon(dashName, rawVal);
        if (!Array.isArray(parsed) || parsed.length === 0) {
          delete shorthandValues[k];
          delete rawValues[k];
          parsedValues.delete(k);
          return null;
        }
        parsedValues.set(k, { value: rawVal, declarations: parsed });
        return parsed;
      };
      const isSvgGeometryStyle = (k: string) =>
        SVG_GEOMETRY_STYLE_PROPS.has(k) && String(target.namespaceURI || "") === SVG_NS;
      const applyInlineDeclaration = (decl: {
        name: string;
        value: string;
        important?: boolean;
      }) => {
        if (!decl || typeof decl.name !== "string") return;
        const longKey = cssPropToCamel(decl.name);
        data[longKey] = decl.important ? `${decl.value} !important` : decl.value;
      };
      const applyInlineDeclarations = (
        k: string,
        rawVal: string,
        parsed: Array<{ name: string; value: string; important?: boolean }>,
      ) => {
        for (const decl of parsed) applyInlineDeclaration(decl);
        const isLonghandWrite = parsed.length === 1 && cssPropToCamel(parsed[0].name) === k;
        if (isLonghandWrite) delete shorthandValues[k];
        else shorthandValues[k] = rawVal;
      };
      const recanonicalizeKey = (k: string, rawVal: string) => {
        if (rawVal == null || rawVal === "") return;
        if (isSvgGeometryStyle(k)) {
          data[k] = rawVal;
          return;
        }
        const dashName = cssPropCamelToKebab(k);
        const parsed = parseInlineDeclaration(k, rawVal, dashName);
        if (!parsed) return;
        applyInlineDeclarations(k, rawVal, parsed);
      };
      const pruneParsedValues = () => {
        for (const k of parsedValues.keys()) {
          if (data[k] === undefined) parsedValues.delete(k);
        }
      };
      const takeInlineData = () => {
        const preKeys = Object.keys(data);
        const preValues: Record<string, string> = {};
        for (const k of preKeys) preValues[k] = String(data[k]);
        for (const k of preKeys) delete data[k];
        return { preKeys, preValues };
      };
      const recanonicalize = () => {
        if (!canon) return;
        pruneParsedValues();
        const { preKeys, preValues } = takeInlineData();
        for (const k of preKeys) {
          recanonicalizeKey(k, preValues[k]);
        }
      };
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
      const scanRawComment = (v: string, i: number, state: { comment: boolean }) => {
        if (v[i] === "*" && v[i + 1] === "/") {
          state.comment = false;
          return i + 1;
        }
        return i;
      };
      const scanRawQuote = (c: string, i: number, state: { quote: string | null }) => {
        if (c === "\\") return i + 1;
        if (c === state.quote) state.quote = null;
        return i;
      };
      const scanRawDelimiter = (c: string, stack: string[], closers: Record<string, string>) => {
        if (closers[c]) stack.push(closers[c]);
        else if (c === stack[stack.length - 1]) stack.pop();
      };
      const isRawCommentStart = (v: string, i: number) => v[i] === "/" && v[i + 1] === "*";
      const scanRawUnquoted = (
        v: string,
        i: number,
        state: { comment: boolean; quote: string | null; stack: string[] },
        closers: Record<string, string>,
      ) => {
        const c = v[i];
        if (c === "\\") return i + 1;
        if (c === '"' || c === "'") state.quote = c;
        else if (isRawCommentStart(v, i)) {
          state.comment = true;
          return i + 1;
        } else scanRawDelimiter(c, state.stack, closers);
        return i;
      };
      const finishClosedRawValue = (
        v: string,
        state: { comment: boolean; quote: string | null; stack: string[] },
      ) => {
        let out = v;
        if (state.comment) out += "*/";
        if (state.quote) out += state.quote;
        while (state.stack.length) out += state.stack.pop();
        return out;
      };
      const closeRawValue = (v: string): string => {
        const closers: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
        const state: { stack: string[]; quote: string | null; comment: boolean } = {
          stack: [],
          quote: null,
          comment: false,
        };
        for (let i = 0; i < v.length; i++) {
          if (state.comment) i = scanRawComment(v, i, state);
          else if (state.quote) i = scanRawQuote(v[i], i, state);
          else i = scanRawUnquoted(v, i, state, closers);
        }
        return finishClosedRawValue(v, state);
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
      const clearInlineStyleMaps = () => {
        for (const k of Object.keys(data)) delete data[k];
        for (const k of Object.keys(rawValues)) delete rawValues[k];
        for (const k of Object.keys(shorthandValues)) delete shorthandValues[k];
      };
      inlineStyleResync.set(target, (text: string | null) => {
        if (flushing) return;
        clearInlineStyleMaps();
        if (text) {
          parseCssTextInto(text, data);
          parseCssTextInto(text, rawValues);
        }
      });
      const expandedRawValue = (
        dv: string | undefined,
        d: { value: string; important?: boolean },
      ) => (dv !== undefined ? String(dv) : d.important ? `${d.value} !important` : d.value);
      const appendExpandedRawDeclaration = (
        d: { name: string; value: string; important?: boolean },
        removedDash: string,
      ) => {
        if (!d || typeof d.name !== "string" || d.name === removedDash) return;
        const camel = cssPropToCamel(d.name);
        const dv = data[camel];
        rawValues[camel] = expandedRawValue(dv, d);
      };
      const expandRawDeclaration = (
        k: string,
        removedDash: string,
        parsed: Array<{ name: string; value: string; important?: boolean }>,
      ) => {
        const entries = Object.entries(rawValues);
        for (const kk of Object.keys(rawValues)) delete rawValues[kk];
        for (const [kk, vv] of entries) {
          if (kk !== k) {
            rawValues[kk] = vv;
            continue;
          }
          for (const d of parsed) {
            appendExpandedRawDeclaration(d, removedDash);
          }
        }
      };
      const rawDeclarationFor = (k: string) => {
        let parsed: Array<{ name: string; value: string; important?: boolean }>;
        try {
          parsed = canon?.(`${cssPropCamelToKebab(k)}: ${rawValues[k]}`) || [];
        } catch {
          parsed = [];
        }
        return parsed;
      };
      const coveringRawDeclaration = (k: string, removedDash: string) => {
        const parsed = rawDeclarationFor(k);
        if (parsed.length <= 1) return null;
        if (!parsed.some((d) => d && d.name === removedDash)) return null;
        return parsed;
      };
      const resetRawValuesWithoutCanon = () => {
        for (const k of Object.keys(rawValues)) delete rawValues[k];
        for (const k of Object.keys(data)) rawValues[k] = String(data[k]);
      };
      const expandCoveringRawKeys = (removedKey: string) => {
        if (!canon) {
          resetRawValuesWithoutCanon();
          return;
        }
        const removedDash = cssPropCamelToKebab(removedKey);
        for (const k of Object.keys(rawValues)) {
          if (k === removedKey) continue;
          const parsed = coveringRawDeclaration(k, removedDash);
          if (parsed) expandRawDeclaration(k, removedDash, parsed);
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
      const removeLonghands = (key: string, had: boolean) => {
        let touched = had;
        for (const lh of longhandKeysOf(key)) {
          if (lh === key || data[lh] === undefined) continue;
          delete data[lh];
          dropRawKey(lh, true);
          touched = true;
        }
        return touched;
      };
      const pruneShorthandValues = () => {
        for (const s of Object.keys(shorthandValues)) {
          if (longhandKeysOf(s).some((lh) => data[lh] === undefined)) delete shorthandValues[s];
        }
      };
      const removeKey = (key: string) => {
        const had = data[key] !== undefined;
        delete data[key];
        delete shorthandValues[key];
        dropRawKey(key, had);
        const touched = removeLonghands(key, had);
        if (!touched) return;
        pruneShorthandValues();
      };
      const setRawKey = (key: string, v: string) => {
        delete rawValues[key];
        rawValues[key] = v;
      };
      const inlineWriteDropped = (key: string) =>
        data[key] === undefined &&
        rawValues[key] === undefined &&
        shorthandValues[key] === undefined;
      const writeWithRestore = (key: string, v: string) => {
        const prevData = data[key];
        const prevRaw = rawValues[key];
        data[key] = v;
        setRawKey(key, v);
        flush();
        if (prevData === undefined) return;
        const dropped = inlineWriteDropped(key);
        if (!dropped) return;
        data[key] = prevData;
        if (prevRaw !== undefined) setRawKey(key, prevRaw);
        flush();
      };

      // getPropertyValue and the property reads share this: the declared
      // value without !important, else Stylo's shorthand assembly, else the
      // authored shorthand text.
      const readCanonProperty = (dashName: string) => {
        if (!getCanonValue) return null;
        const raw = serializeStyleData(data);
        if (raw) {
          try {
            const v = getCanonValue(raw, dashName);
            if (v) return v;
          } catch {
            /* fall through */
          }
        }
        return null;
      };
      const readProperty = (key: string, dashName: string): string => {
        if (data[key] != null) return String(data[key]).replace(/\s*!important\s*$/i, "");
        const canonValue = readCanonProperty(dashName);
        if (canonValue) return canonValue;
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
        (element) => windowObj[GET_COMPUTED_STYLE_INTERNAL](element, undefined, true),
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
    syncCheckedInput(this, next, tag);
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
    return this.getAttribute("type") ?? "";
  }
  set type(v) {
    this.setAttribute("type", String(v));
  }
  // URL reflection: a missing value gives "" and an invalid value stays raw.
  // Parsing uses the node document's encoding for non-ASCII queries.
  // https://html.spec.whatwg.org/#reflecting-content-attributes-in-idl-attributes
  get href(): string {
    const raw = this.getAttribute("href");
    if (raw == null) return "";
    try {
      return parseUrlForNode(this, raw, this.baseURI || pageUrl || undefined).toString();
    } catch {
      return raw;
    }
  }
  set href(v) {
    this.setAttribute("href", String(v));
  }
  get src(): string {
    const raw = this.getAttribute("src");
    if (raw == null) return "";
    try {
      return parseUrlForNode(this, raw, this.baseURI || pageUrl || undefined).toString();
    } catch {
      return raw;
    }
  }
  set src(v) {
    this.setAttribute("src", String(v));
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
    const backing = datasetBacking();
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
    syncElementFocus(this, old);
    if (old) dispatchFocusLoss(old, this);
    dispatchFocusGain(this, old);
  }
  blur(): void {
    if (activeElement !== this) return;
    setActiveElement(null);
    clearDomFocus(this);
    dispatchFocusLoss(this, null);
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
  createElement(localName: string): Element;
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

export { Element, renderedTextFragmentNodes };
