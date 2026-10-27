// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Records observed DOM mutations, validates observer options, and batches callback delivery.

import type * as Idl from "../idl/types.generated.js";
import { ksGlobal, dom, nodeFor } from "../state.js";
import { moPendingObservers, linkLoadFired } from "../registries.js";
import { getInternalState } from "../internal-state.js";
import { KsEvent } from "../events/event.js";
import { DOCUMENT_FRAGMENT_NODE } from "../constants.js";
import type { NodeBase } from "../node-base.js";

const REL_LOADABLE = /(?:^|\s)(?:stylesheet|preload|modulepreload)(?:\s|$)/i;
const OBSERVER_ANCESTOR_HOP_LIMIT = 4096;

type MutationKind = "attributes" | "characterData" | "childList";

interface MutationRecordExtras {
  addedNodes?: NodeBase[];
  removedNodes?: NodeBase[];
  previousSibling?: NodeBase | null;
  nextSibling?: NodeBase | null;
  attributeName?: string | null;
  attributeNamespace?: string | null;
  oldValue?: string | null;
}

interface NormalizedObserverOptions {
  attributes: boolean;
  childList: boolean;
  characterData: boolean;
  subtree: boolean;
  attributeOldValue: boolean;
  characterDataOldValue: boolean;
  attributeFilter?: unknown[];
}

interface ObserverRegistration {
  observer: MutationObserverImpl;
  targetId: number;
  options: NormalizedObserverOptions;
}

type LinkishNode = {
  _id?: unknown;
  tagName?: unknown;
  localName?: unknown;
  href?: unknown;
  nonce?: unknown;
  isConnected?: unknown;
  textContent?: unknown;
  getAttribute?: (name: string) => unknown;
  hasAttribute?: (name: string) => boolean;
  getRootNode?: (options?: { composed?: boolean }) => unknown;
  dispatchEvent?: Idl.EventTarget["dispatchEvent"];
  querySelectorAll?: (sel: string) => ArrayLike<LinkishNode>;
};

function linkIdentity(el: LinkishNode): { id: number; href: string } {
  let id = NaN;
  let href = "";
  try {
    id = Number(el._id);
    href = String(el.href ?? "");
  } catch {}
  return { id, href };
}

function loadableLinkRelation(el: LinkishNode): unknown | null {
  const rel = (typeof el.getAttribute === "function" && el.getAttribute("rel")) || "";
  return REL_LOADABLE.test(String(rel)) ? rel : null;
}

function isSkippedExternalStylesheet(el: LinkishNode, rel: unknown, href: string): boolean {
  return (
    String(rel).toLowerCase().split(/\s+/).includes("stylesheet") &&
    !(typeof el.getAttribute === "function" && el.getAttribute("media")) &&
    /^https?:/i.test(href)
  );
}

function clearStaleLinkLoad(id: number, href: string): void {
  if (Number.isFinite(id) && linkLoadFired.get(id) === href) linkLoadFired.delete(id);
}

function dispatchLinkLoad(el: LinkishNode): void {
  try {
    if (typeof el.dispatchEvent === "function") el.dispatchEvent(new KsEvent("load"));
  } catch {}
}

function deliverLinkLoad(el: LinkishNode, id: number, href: string): void {
  let live = false;
  let nowHref = "";
  try {
    live = el.isConnected === true;
    nowHref = String(el.href ?? "");
  } catch {}
  if (!live || nowHref !== href) {
    clearStaleLinkLoad(id, href);
    return;
  }
  dispatchLinkLoad(el);
}

function notifyLoadableLink(el: LinkishNode): void {
  try {
    const rel = loadableLinkRelation(el);
    if (rel === null) return;
    const { id, href } = linkIdentity(el);
    if (isSkippedExternalStylesheet(el, rel, href)) return;
    if (Number.isFinite(id)) linkLoadFired.set(id, href);
    queueMicrotask(() => deliverLinkLoad(el, id, href));
  } catch {}
}

function notifyLinkInserts(insertedNode: LinkishNode, nested: LinkishNode[]): void {
  try {
    if (String(insertedNode.tagName ?? "").toUpperCase() === "LINK") {
      notifyLoadableLink(insertedNode);
    }
    for (const el of nested) notifyLoadableLink(el);
  } catch {}
}

// Lets makeRecord construct records; pages can't.
const RECORD_TOKEN = Symbol("kitesurfMutationRecord");

// addedNodes and removedNodes are arrays (idl/type-gaps.json).
export class MutationRecord implements Idl.MutationRecord {
  readonly #type: MutationKind;
  readonly #target: NodeBase;
  readonly #addedNodes: NodeBase[];
  readonly #removedNodes: NodeBase[];
  readonly #previousSibling: NodeBase | null;
  readonly #nextSibling: NodeBase | null;
  readonly #attributeName: string | null;
  readonly #attributeNamespace: string | null;
  readonly #oldValue: string | null;
  constructor(token: symbol, type: MutationKind, target: NodeBase, extras: MutationRecordExtras) {
    if (token !== RECORD_TOKEN) throw new TypeError("Illegal constructor");
    this.#type = type;
    this.#target = target;
    this.#addedNodes = extras.addedNodes || [];
    this.#removedNodes = extras.removedNodes || [];
    this.#previousSibling = extras.previousSibling || null;
    this.#nextSibling = extras.nextSibling || null;
    this.#attributeName = extras.attributeName ?? null;
    this.#attributeNamespace = extras.attributeNamespace ?? null;
    this.#oldValue = extras.oldValue ?? null;
  }
  get type() {
    return this.#type;
  }
  get target() {
    return this.#target;
  }
  get addedNodes(): NodeBase[] {
    return this.#addedNodes;
  }
  get removedNodes(): NodeBase[] {
    return this.#removedNodes;
  }
  get previousSibling() {
    return this.#previousSibling;
  }
  get nextSibling() {
    return this.#nextSibling;
  }
  get attributeName() {
    return this.#attributeName;
  }
  get attributeNamespace() {
    return this.#attributeNamespace;
  }
  get oldValue() {
    return this.#oldValue;
  }
}

function makeRecord(
  type: MutationKind,
  target: NodeBase,
  extras: MutationRecordExtras,
): MutationRecord {
  return new MutationRecord(RECORD_TOKEN, type, target, extras);
}

let moDeliveryScheduled = false;

function reportObserverCallbackError(error: unknown): void {
  try {
    (ksGlobal.console || console).error("MO callback threw:", error);
  } catch {}
}

function deliverObserverBatch(): void {
  moDeliveryScheduled = false;
  // Clear before callbacks so callback mutations schedule a later delivery.
  const observers = Array.from(moPendingObservers);
  moPendingObservers.clear();
  for (const obs of observers) {
    // Transient registrations survive until this batch's removal records are collected.
    const records = takeQueuedRecords(obs);
    clearTransientObservers(obs);
    if (records.length === 0) continue;
    try {
      invokeObserverCallback(obs, records);
    } catch (error) {
      reportObserverCallbackError(error);
    }
  }
}

function enqueueObserverBatch(fire: () => void): void {
  if (typeof queueMicrotask === "function") {
    queueMicrotask(fire);
  } else {
    setTimeout(fire, 0);
  }
}

function scheduleMoDelivery(): void {
  if (moDeliveryScheduled) return;
  moDeliveryScheduled = true;
  enqueueObserverBatch(deliverObserverBatch);
}

const mutationObservers: ObserverRegistration[] = [];
const transientSourcesByTarget = new Map<number, Set<ObserverRegistration>>();
const transientTargetsBySource = new Map<ObserverRegistration, Set<number>>();

function observerParentId(targetId: number): number {
  try {
    return (dom as any).parentId(targetId);
  } catch {
    return -1;
  }
}

function visitTransientSourcesAt(
  targetId: number,
  visit: (source: ObserverRegistration) => void,
): void {
  const sources = transientSourcesByTarget.get(targetId);
  if (!sources) return;
  for (const source of sources) visit(source);
}

function invalidObserverParent(parentId: number, targetId: number): boolean {
  return parentId < 0 || parentId === targetId;
}

function forEachMatchingTransientSource(
  targetId: number,
  visit: (source: ObserverRegistration) => void,
): void {
  let cur = targetId;
  let safety = 0;
  while (safety <= OBSERVER_ANCESTOR_HOP_LIMIT) {
    visitTransientSourcesAt(cur, visit);
    const parent = observerParentId(cur);
    if (invalidObserverParent(parent, cur)) return;
    cur = parent;
    safety++;
  }
}

function removeTransientTarget(source: ObserverRegistration, targetId: number): void {
  const sources = transientSourcesByTarget.get(targetId);
  if (!sources) return;
  sources.delete(source);
  if (sources.size === 0) transientSourcesByTarget.delete(targetId);
}

function clearTransientSource(source: ObserverRegistration): void {
  const targetIds = transientTargetsBySource.get(source);
  if (!targetIds) return;
  for (const targetId of targetIds) removeTransientTarget(source, targetId);
  transientTargetsBySource.delete(source);
}

function clearTransientObservers(observer: MutationObserverImpl): void {
  for (const entry of mutationObservers) {
    if (entry.observer === observer) clearTransientSource(entry);
  }
}

export function mutationObserverCount(): number {
  return mutationObservers.length;
}

function observerMatchesTarget(entry: ObserverRegistration, targetId: number): boolean {
  return targetMatchesRegistration(targetId, entry.targetId, entry.options.subtree);
}

function targetMatchesRegistration(
  targetId: number,
  registeredTargetId: number,
  subtree: boolean,
): boolean {
  if (registeredTargetId === targetId) return true;
  if (!subtree) return false;
  let cur = targetId;
  let safety = 0;
  while (safety < OBSERVER_ANCESTOR_HOP_LIMIT) {
    let parent;
    try {
      parent = (dom as any).parentId(cur);
    } catch {
      return false;
    }
    if (parent < 0 || parent === cur) return false;
    if (parent === registeredTargetId) return true;
    cur = parent;
    safety++;
  }
  return false;
}

export function hasChildListObserver(targetId: number): boolean {
  if (
    mutationObservers.some(
      (entry) => entry.options.childList && observerMatchesTarget(entry, targetId),
    )
  )
    return true;
  let matched = false;
  forEachMatchingTransientSource(targetId, (source) => {
    if (source.options.childList) matched = true;
  });
  return matched;
}

export function hasSubtreeObserver(targetId: number): boolean {
  if (
    mutationObservers.some(
      (entry) => entry.options.subtree && observerMatchesTarget(entry, targetId),
    )
  )
    return true;
  let matched = false;
  forEachMatchingTransientSource(targetId, () => {
    matched = true;
  });
  return matched;
}

export function registerTransientObservers(rootId: number): void {
  const sources = new Set<ObserverRegistration>();
  for (const entry of mutationObservers) {
    if (
      entry.options.subtree &&
      entry.targetId !== rootId &&
      observerMatchesTarget(entry, rootId)
    ) {
      sources.add(entry);
    }
  }
  forEachMatchingTransientSource(rootId, (source) => sources.add(source));
  for (const source of sources) {
    let targetSources = transientSourcesByTarget.get(rootId);
    if (!targetSources) {
      targetSources = new Set();
      transientSourcesByTarget.set(rootId, targetSources);
    }
    if (targetSources.has(source)) continue;
    targetSources.add(source);
    moPendingObservers.add(source.observer);
    let sourceTargets = transientTargetsBySource.get(source);
    if (!sourceTargets) {
      sourceTargets = new Set();
      transientTargetsBySource.set(source, sourceTargets);
    }
    sourceTargets.add(rootId);
  }
  if (moPendingObservers.size > 0) scheduleMoDelivery();
}

// An observer can match several ancestor registrations; queue one record, keeping the old
// value if any matching registration requests it, including a removed subtree's transient ones.
// https://dom.spec.whatwg.org/#queue-a-mutation-record
function observesMutation(
  options: NormalizedObserverOptions,
  kind: MutationKind,
  extras: MutationRecordExtras,
): boolean {
  switch (kind) {
    case "attributes":
      return (
        options.attributes &&
        (!Array.isArray(options.attributeFilter) ||
          options.attributeFilter.includes(extras.attributeName))
      );
    case "characterData":
      return options.characterData;
    case "childList":
      return options.childList;
  }
}

function requestsOldValue(options: NormalizedObserverOptions, kind: MutationKind): boolean {
  return (
    (kind === "attributes" && options.attributeOldValue) ||
    (kind === "characterData" && options.characterDataOldValue)
  );
}

function considerObserverMutation(
  interested: Map<MutationObserverImpl, boolean>,
  entry: ObserverRegistration,
  kind: MutationKind,
  extras: MutationRecordExtras,
  matches: boolean,
): void {
  if (!matches || !observesMutation(entry.options, kind, extras)) return;
  const wantsOldValue = requestsOldValue(entry.options, kind);
  interested.set(entry.observer, interested.get(entry.observer) === true || wantsOldValue);
}

function observerMutationInterests(
  targetId: number,
  kind: MutationKind,
  extras: MutationRecordExtras,
): Map<MutationObserverImpl, boolean> {
  const interested = new Map<MutationObserverImpl, boolean>();
  for (const entry of mutationObservers) {
    considerObserverMutation(
      interested,
      entry,
      kind,
      extras,
      observerMatchesTarget(entry, targetId),
    );
  }
  forEachMatchingTransientSource(targetId, (source) => {
    considerObserverMutation(interested, source, kind, extras, true);
  });
  return interested;
}

function queueObserverMutationRecord(
  observer: MutationObserverImpl,
  wantsOldValue: boolean,
  kind: MutationKind,
  target: NodeBase,
  extras: MutationRecordExtras,
): void {
  const recordExtras = { ...extras };
  if ((kind === "attributes" || kind === "characterData") && !wantsOldValue) {
    recordExtras.oldValue = null;
  }
  queueObserverRecord(observer, makeRecord(kind, target, recordExtras));
  moPendingObservers.add(observer);
}

function queueMutationRecord(
  kind: MutationKind,
  target: NodeBase,
  extras: MutationRecordExtras,
): void {
  if (!canQueueMutationRecord(target)) return;
  const targetId = target._id;
  const interested = observerMutationInterests(targetId, kind, extras);
  for (const [observer, wantsOldValue] of interested) {
    queueObserverMutationRecord(observer, wantsOldValue, kind, target, extras);
  }
  scheduleMoDeliveryIfNeeded();
}

function canQueueMutationRecord(target: NodeBase): boolean {
  return mutationObservers.length > 0 && Boolean(target) && typeof target._id === "number";
}

function scheduleMoDeliveryIfNeeded(): void {
  if (moPendingObservers.size > 0) scheduleMoDelivery();
}

export function recordAttributeMutation(
  elementId: number,
  attributeName: string,
  attributeNamespace: string | null,
  oldValue: string | null,
): void {
  if (mutationObservers.length === 0) return;
  const target = nodeFor ? nodeFor(elementId) : null;
  if (!target) return;
  queueMutationRecord("attributes", target, {
    attributeName,
    attributeNamespace,
    oldValue,
  });
}

const suppressedChildListTargets = new WeakMap<object, number>();

export function suppressChildListMutations<T>(parent: object, fn: () => T): T {
  suppressedChildListTargets.set(parent, (suppressedChildListTargets.get(parent) ?? 0) + 1);
  try {
    return fn();
  } finally {
    const remaining = (suppressedChildListTargets.get(parent) ?? 1) - 1;
    if (remaining === 0) suppressedChildListTargets.delete(parent);
    else suppressedChildListTargets.set(parent, remaining);
  }
}

export function recordChildListMutation(
  parent: NodeBase,
  addedNodes: NodeBase[],
  removedNodes: NodeBase[],
  previousSibling: NodeBase | null,
  nextSibling: NodeBase | null,
): void {
  if (!shouldRecordChildListMutation(parent)) return;
  queueMutationRecord("childList", parent, {
    addedNodes,
    removedNodes,
    previousSibling: previousSibling || null,
    nextSibling: nextSibling || null,
  });
}

function shouldRecordChildListMutation(parent: NodeBase): boolean {
  return mutationObservers.length > 0 && Boolean(parent) && !suppressedChildListTargets.has(parent);
}

function invokeIframeHook(hook: (element: unknown) => void, element: unknown): void {
  try {
    hook(element);
  } catch {}
}

function notifyIframeInserts(insertedNode: LinkishNode, nested: LinkishNode[]): void {
  const hook = getInternalState().afterIframeInsert;
  if (typeof hook !== "function") return;
  try {
    const tag = String(insertedNode.tagName ?? "").toUpperCase();
    if (tag === "IFRAME") {
      try {
        hook(insertedNode);
      } catch {}
    }
    for (const el of nested) {
      try {
        hook(el);
      } catch {}
    }
  } catch {}
}

interface RemovedNode {
  readonly nodeName?: string;
  readonly tagName?: string;
  readonly querySelectorAll?: (
    selectors: string,
  ) => Iterable<unknown> & { readonly length: number };
}

function queryRemovedIframes(
  removedNode: RemovedNode,
): (Iterable<unknown> & { readonly length: number }) | null {
  if (typeof removedNode.querySelectorAll !== "function") return null;
  try {
    return removedNode.querySelectorAll("iframe");
  } catch {
    return null;
  }
}

function notifyNestedIframeRemoves(
  hook: (element: unknown) => void,
  removedNode: RemovedNode,
): void {
  const nested = queryRemovedIframes(removedNode);
  if (!nested || !nested.length) return;
  for (const element of nested) invokeIframeHook(hook, element);
}

function isIframeTag(tagName: string | undefined): boolean {
  return (tagName || "").toUpperCase() === "IFRAME";
}

export function notifyIframeRemoves(removedNode: RemovedNode | null | undefined): void {
  if (!removedNode) return;
  const hook = getInternalState().afterIframeRemove;
  if (typeof hook !== "function") return;
  try {
    if (isIframeTag(removedNode.tagName)) invokeIframeHook(hook, removedNode);
    notifyNestedIframeRemoves(hook, removedNode);
  } catch {}
}

const runtimeCreatedScriptIds = new Set<number>();
const executedScriptIds = new Set<number>();

interface ScriptIds {
  readonly source: number;
  readonly clone: number;
}

interface ScriptInsertDetails {
  readonly id: number;
  readonly src: string;
  readonly type: string;
  readonly source: string;
  readonly integrity: string;
  readonly nonce: string;
  readonly crossOrigin: string | null;
}

export function markRuntimeCreatedScript(id: number): void {
  if (typeof id === "number" && id >= 0) runtimeCreatedScriptIds.add(id);
}

function readScriptIds(src: LinkishNode, clone: LinkishNode): ScriptIds | null {
  let srcId: unknown, cloneId: unknown;
  try {
    srcId = src._id;
    cloneId = clone._id;
  } catch {
    return null;
  }
  if (!isNumber(srcId) || !isNonNegativeNumber(cloneId)) return null;
  return { source: srcId, clone: cloneId };
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && value >= 0;
}

function scriptIsInFragment(script: LinkishNode): boolean {
  try {
    const root = script.getRootNode?.() as { nodeType?: unknown } | null | undefined;
    return root?.nodeType === DOCUMENT_FRAGMENT_NODE;
  } catch {
    return false;
  }
}

function scriptType(script: LinkishNode): string {
  try {
    return String(script.getAttribute?.("type") || "")
      .trim()
      .toLowerCase();
  } catch {
    return "";
  }
}

function isExecutableScriptType(type: string): boolean {
  return (
    type === "" ||
    type === "text/javascript" ||
    type === "application/javascript" ||
    type === "module"
  );
}

function isCopyableScriptType(type: string): boolean {
  return isExecutableScriptType(type) || type === "importmap";
}

function scriptWasStarted(sourceId: number, script: LinkishNode): boolean {
  if (executedScriptIds.has(sourceId)) return true;
  if (runtimeCreatedScriptIds.has(sourceId)) return false;
  return !scriptIsInFragment(script) && isCopyableScriptType(scriptType(script));
}

export function copyScriptStartedFlag(src: LinkishNode, clone: LinkishNode): void {
  const ids = readScriptIds(src, clone);
  if (!ids) return;
  if (scriptWasStarted(ids.source, src)) executedScriptIds.add(ids.clone);
}

function scriptId(script: LinkishNode): number | null {
  try {
    const id = script._id;
    return isNonNegativeNumber(id) ? id : null;
  } catch {
    return null;
  }
}

function isRuntimeScriptPending(id: number): boolean {
  return runtimeCreatedScriptIds.has(id) && !executedScriptIds.has(id);
}

function isScriptRootedInDocument(script: LinkishNode): boolean {
  try {
    return (
      typeof script.getRootNode === "function" &&
      script.getRootNode({ composed: true }) === ksGlobal.document
    );
  } catch {
    return false;
  }
}

function isConnectedScript(script: LinkishNode): boolean {
  try {
    return script.isConnected === true;
  } catch {
    return false;
  }
}

function isLiveScript(script: LinkishNode): boolean {
  return isScriptRootedInDocument(script) && isConnectedScript(script);
}

function readScriptSource(script: LinkishNode): string {
  try {
    return String(script.getAttribute?.("src") || "");
  } catch {
    return "";
  }
}

function readScriptText(script: LinkishNode): string {
  try {
    return String(script.textContent || "");
  } catch {
    return "";
  }
}

function readScriptIntegrity(script: LinkishNode): string {
  try {
    return String(script.getAttribute?.("integrity") || "").trim();
  } catch {
    return "";
  }
}

function readScriptNonce(script: LinkishNode): string {
  try {
    const idl = script.nonce;
    return String(typeof idl === "string" ? idl : script.getAttribute?.("nonce") || "");
  } catch {
    return "";
  }
}

function scriptCrossOriginValue(script: LinkishNode): string {
  return String(script.getAttribute?.("crossorigin") || "");
}

function readScriptCrossOrigin(script: LinkishNode): string | null {
  try {
    if (!script.hasAttribute?.("crossorigin")) return null;
    return scriptCrossOriginValue(script);
  } catch {
    return null;
  }
}

function scriptInsertDetails(script: LinkishNode, id: number): ScriptInsertDetails | null {
  const type = scriptType(script);
  if (!isExecutableScriptType(type)) return null;
  const src = readScriptSource(script);
  const source = readScriptText(script);
  if (!src && source === "") return null;
  return {
    id,
    src,
    type,
    source,
    integrity: readScriptIntegrity(script),
    nonce: readScriptNonce(script),
    crossOrigin: readScriptCrossOrigin(script),
  };
}

function scriptInsertCandidate(script: LinkishNode): number | null {
  const id = scriptId(script);
  if (id === null || !isRuntimeScriptPending(id) || !isLiveScript(script)) return null;
  return id;
}

function considerScriptInsert(
  script: LinkishNode,
  hook: (details: ScriptInsertDetails) => void,
): void {
  const id = scriptInsertCandidate(script);
  if (id === null) return;
  const details = scriptInsertDetails(script, id);
  if (!details) return;
  executedScriptIds.add(id);
  try {
    hook(details);
  } catch {}
}

function notifyDirectScriptInsert(
  insertedNode: LinkishNode,
  hook: (details: ScriptInsertDetails) => void,
): void {
  if (String(insertedNode.tagName ?? "").toUpperCase() === "SCRIPT") {
    considerScriptInsert(insertedNode, hook);
  }
}

function notifyNestedScriptInserts(
  nested: LinkishNode[],
  hook: (details: ScriptInsertDetails) => void,
): void {
  for (const script of nested) considerScriptInsert(script, hook);
}

function notifyScriptInserts(insertedNode: LinkishNode, nested: LinkishNode[]): void {
  const hook = getInternalState().afterScriptInsert;
  if (typeof hook !== "function") return;
  try {
    notifyDirectScriptInsert(insertedNode, hook);
    notifyNestedScriptInserts(nested, hook);
  } catch {}
}

export function notifySubtreeInserts(insertedNode: LinkishNode): void {
  // Snapshot resource descendants before insertion hooks can mutate the subtree.
  const iframes: LinkishNode[] = [];
  const scripts: LinkishNode[] = [];
  const links: LinkishNode[] = [];
  try {
    if (typeof insertedNode.querySelectorAll === "function") {
      for (const el of Array.from(insertedNode.querySelectorAll("iframe,script,link"))) {
        const tag = String(el.localName ?? "").toLowerCase();
        if (tag === "iframe") iframes.push(el);
        else if (tag === "script") scripts.push(el);
        else if (tag === "link") links.push(el);
      }
    }
  } catch {}
  notifyIframeInserts(insertedNode, iframes);
  notifyScriptInserts(insertedNode, scripts);
  notifyLinkInserts(insertedNode, links);
}

export function recordCharacterDataMutation(node: NodeBase, oldValue: string): void {
  if (mutationObservers.length === 0) return;
  if (!node) return;
  queueMutationRecord("characterData", node, { oldValue });
}

function isObservable(value: unknown): value is { readonly _id: number } {
  return (
    typeof value === "object" && value !== null && "_id" in value && typeof value._id === "number"
  );
}

function inferredAttributeOption(
  value: boolean,
  explicit: boolean,
  hasOldValue: boolean,
  hasFilter: boolean,
): boolean {
  return value || (!explicit && (hasOldValue || hasFilter));
}

function inferredCharacterDataOption(
  value: boolean,
  explicit: boolean,
  hasOldValue: boolean,
): boolean {
  return value || (!explicit && hasOldValue);
}

function validateAttributeOldValue(options: Idl.MutationObserverInit, present: boolean): void {
  if (present && options.attributeOldValue === true) {
    throw new TypeError("MutationObserver.observe: attributeOldValue requires attributes:true");
  }
}

function validateAttributeFilter(present: boolean): void {
  if (present)
    throw new TypeError("MutationObserver.observe: attributeFilter requires attributes:true");
}

function validateAttributeOptions(
  options: Idl.MutationObserverInit,
  explicit: boolean,
  hasOldValue: boolean,
  hasFilter: boolean,
): void {
  if (!explicit || options.attributes !== false) return;
  validateAttributeOldValue(options, hasOldValue);
  validateAttributeFilter(hasFilter);
}

function characterDataNeedsOldValue(
  options: Idl.MutationObserverInit,
  explicit: boolean,
  hasOldValue: boolean,
): boolean {
  return (
    explicit &&
    options.characterData === false &&
    hasOldValue &&
    options.characterDataOldValue === true
  );
}

function validateCharacterDataOptions(
  options: Idl.MutationObserverInit,
  explicit: boolean,
  hasOldValue: boolean,
): void {
  if (characterDataNeedsOldValue(options, explicit, hasOldValue)) {
    throw new TypeError(
      "MutationObserver.observe: characterDataOldValue requires characterData:true",
    );
  }
}

function validateObservedKinds(
  attributes: boolean,
  childList: boolean,
  characterData: boolean,
): void {
  if (!attributes && !childList && !characterData) {
    throw new TypeError(
      "MutationObserver.observe: at least one of attributes/childList/characterData must be true",
    );
  }
}

function normalizedObserverOptions(options: Idl.MutationObserverInit): NormalizedObserverOptions {
  // Keep dictionary property reads in the WebIDL conversion order.
  const attributesExplicit = "attributes" in options;
  const characterDataExplicit = "characterData" in options;
  const hasAttrOldValue = "attributeOldValue" in options;
  const hasAttrFilter = "attributeFilter" in options;
  const hasCharOldValue = "characterDataOldValue" in options;
  const attributes = inferredAttributeOption(
    !!options.attributes,
    attributesExplicit,
    hasAttrOldValue,
    hasAttrFilter,
  );
  const characterData = inferredCharacterDataOption(
    !!options.characterData,
    characterDataExplicit,
    hasCharOldValue,
  );
  const childList = !!options.childList;
  const subtree = !!options.subtree;

  validateAttributeOptions(options, attributesExplicit, hasAttrOldValue, hasAttrFilter);
  validateCharacterDataOptions(options, characterDataExplicit, hasCharOldValue);
  validateObservedKinds(attributes, childList, characterData);

  return {
    attributes,
    childList,
    characterData,
    subtree,
    attributeOldValue: !!options.attributeOldValue,
    characterDataOldValue: !!options.characterDataOldValue,
    attributeFilter: Array.isArray(options.attributeFilter)
      ? options.attributeFilter.slice()
      : undefined,
  };
}

function updateObserverRegistration(
  observer: MutationObserverImpl,
  targetId: number,
  options: NormalizedObserverOptions,
): boolean {
  for (const entry of mutationObservers) {
    if (entry.observer !== observer || entry.targetId !== targetId) continue;
    clearTransientSource(entry);
    entry.options = options;
    return true;
  }
  return false;
}

type MutationCallback = (records: MutationRecord[], observer: MutationObserverImpl) => void;

let queueObserverRecord!: (observer: MutationObserverImpl, record: MutationRecord) => void;
let takeQueuedRecords!: (observer: MutationObserverImpl) => MutationRecord[];
let invokeObserverCallback!: (observer: MutationObserverImpl, records: MutationRecord[]) => void;

export class MutationObserverImpl implements Idl.MutationObserver {
  readonly #callback: MutationCallback;
  #records: MutationRecord[] = [];
  static {
    queueObserverRecord = (observer, record) => {
      observer.#records.push(record);
    };
    takeQueuedRecords = (observer) => {
      const records = observer.#records;
      observer.#records = [];
      return records;
    };
    invokeObserverCallback = (observer, records) => {
      observer.#callback.call(observer, records, observer);
    };
  }
  constructor(callback: MutationCallback) {
    if (typeof callback !== "function") {
      throw new TypeError("MutationObserver: callback is not a function");
    }
    this.#callback = callback;
  }
  /**
   * Empty or contradictory options throw `TypeError`.
   * Old-value and filter options infer the matching observation flag.
   */
  observe(target: unknown, options?: Idl.MutationObserverInit) {
    if (!isObservable(target)) {
      throw new TypeError("MutationObserver.observe: invalid target");
    }
    const opts = options || {};
    // Option defaults and checks: https://dom.spec.whatwg.org/#dom-mutationobserver-observe
    const normalized = normalizedObserverOptions(opts);
    if (updateObserverRegistration(this, target._id, normalized)) return;
    mutationObservers.push({
      observer: this,
      targetId: target._id,
      options: normalized,
    });
  }
  disconnect() {
    clearTransientObservers(this);
    for (let i = mutationObservers.length - 1; i >= 0; i--) {
      if (mutationObservers[i].observer === this) {
        mutationObservers.splice(i, 1);
      }
    }
    this.#records = [];
    moPendingObservers.delete(this);
  }
  takeRecords() {
    return takeQueuedRecords(this);
  }
}
