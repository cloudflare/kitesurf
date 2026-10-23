// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// PageScript loaded-worker entrypoint for navigation, evaluation, and CDP session methods.
// Each generation runs in one pinned JSRPC session; returns must be plain data or bytes, because a
// returned function becomes a live capability that extends the session.

import { WorkerEntrypoint, RpcTarget, abortIsolate } from "cloudflare:workers";
import type {
  ArgSpec,
  CallFunctionOnOptions,
  CompileScriptReply,
  DeliverMessageParams,
  DrainConsoleReply,
  EvalOptions,
  EvalResult,
  FrameBitmapParams,
  FrameBitmapReply,
  IframeContentParams,
  KeyDispatchReply,
  KeyEventInit,
  LoadCompletion,
  MouseDispatchReply,
  MouseEventInit,
  NavigateOptions,
  NavigateSummary,
  OkReply,
  PageScriptMethod,
  PageScriptReply,
  PageScriptSession,
  PageScriptWireParams,
  PropertyDescriptor,
  ReceivedSessionInit,
  RetainedPageScriptSessionTarget,
  RunScriptReply,
  WireMeta,
  UnloadReply,
} from "@kitesurf/jsrpc-types/page-script";
import type { RenderPort as RenderPortContract } from "@kitesurf/jsrpc-types/page-renderer";
import type { WorkerEventParams } from "@kitesurf/jsrpc-types/dedicated-worker";
import { deliverWorkerEvent } from "./dedicated-worker.ts";
import type {
  PendingImageDrain,
  QueryDomArgs,
  QueryDomMethod,
  QueryDomResult,
} from "@kitesurf/jsrpc-types/query-dom";

import {
  importModule,
  startupCdpDebug,
  startupLagWatchdog,
  startupHasClassicAsync,
  startupHasClassicRegular,
  startupInputSnapshot,
  startupResourceDrainQuietTurns,
  startupModuleScriptCount,
  startupModuleScriptUrls,
  startupPixelFree,
  startupScriptDescriptors,
  startupUserAgent,
  startupReferrer,
  startupReferrerPolicy,
  coreWasmMemory,
  getCoreWasmMemoryBytes,
  getCoreWasmMemoryInitialBytes,
} from "./startup-probe.ts";
import {
  armPaintWake,
  getInternalState,
  type BundleDiag,
  type IframePost,
  sendUpstreamEvent,
  takeDocumentReopened,
  registerUpstreamSender,
  clearUpstreamSender,
} from "./internal-state.js";
import { determineReferrer, parseReferrerPolicy } from "@kitesurf/script-gate/referrer-policy";
import { invokeSessionMethod } from "./session-methods.ts";
import { clearSessionOutbound, setSessionOutbound } from "./session-outbound.ts";
import {
  installResourceFetchBridge,
  fontsIdle,
  fontsInflightCount,
  resolveFontUrlData,
  fontUrlForKey,
  getStylesheetDeliverySeq,
  inflightStartedAt,
  externalSheetRulesForNode,
  resourceCacheStyles,
  blockingInflightCount,
  imageInflightUrls,
  reevaluateDeferredUrls,
  isImageInflight,
  resourceInflight,
  waitForInflightZero,
  nextResourceSettle,
  snapshotFetchStats,
  stylesheetCors,
} from "./resource-fetch.ts";
import { resolveExternalSvgSprites, startLateSpriteSweep } from "./svg-sprites.ts";
import { evalInsertedOnBoa, runInsertedExternalScript } from "./inserted-scripts.ts";
import { editContentEditable, editingHostOf } from "./contenteditable-input.ts";
import {
  inlineInsertDecisionSync,
  insertedScriptAllowed,
  reportBlocked,
  reportOnly,
} from "./script-policy.ts";

import {
  SyncFunction,
  anchorHrefAttribute,
  findAnchorAncestor,
  findAnchorViaSingleChild,
  findFocusableAncestor,
  packBoaResult,
  runExpression,
} from "./eval-helpers.ts";
import { installFetchShim } from "./fetch-shim.ts";
import { drainEvalResult, type EvalResultBody } from "./eval-results.ts";
import {
  drainCdpMutations,
  drainConsole,
  installConsoleWrapper,
  resetConsoleBuffer,
} from "./console-buffer.ts";
import { drainExceptions, pushException, resetExceptionBuffer } from "./exception-buffer.ts";
import {
  computedStyleForAuthId,
  computedStyleValueForAuthId,
  cascadeSeq,
  documentScrollSize,
  ensurePaintDom,
  invalidatePaintDom,
  kickLayoutForFontFaceDiscovery,
  takePaintPrep,
  paintPrepStats,
  rectWithScrollOffset,
  renderSceneRawPooled,
  scrollBy,
  setScrollOffset,
} from "./paint.ts";
import { installLagWatchdog } from "./lag-monitor.ts";
import {
  drainSettleMicrotasks,
  NativePromise,
  nativeSetTimeout,
  nativeSleep,
  yieldToPageTasks,
} from "./native-scheduling.ts";
import { splitSelectorList } from "./selectors.ts";
import {
  compileScriptEntry,
  getCompiledScript,
  lookupHandle,
  mintHandle,
  releaseHandle,
} from "./handles.ts";
import { drainInitShims, installInitShims } from "./init-shims.ts";
import { deferShimStats, drainDeferParked, installDeferShim } from "./defer-shim.ts";
import { responseHeaderGet } from "./native-http.ts";
import { captureTrustedFetch, trustedFetch } from "./trusted-fetch.ts";
import {
  awaitDeferredFontBytes,
  awaitDeferredFonts,
  deferredDegradedReads,
  demandDeferredFonts,
  ensureFontsRegistered,
  emojiPendingPromise,
  cjkPendingPromise,
  demandFacesForScriptText,
  noteNavigateText,
  scriptPendingPromises,
  fontDeferActive,
  startFontPrefetch,
  forceMonoFace,
  fontLoaderMode,
  setAuthorFontUpgradeHook,
  setFontUpgradeCallback,
  upgradePendingPromise,
  upgradeToFullFonts,
} from "./font-loader.ts";

const SESSION_CLOSED_ERROR = new Error("PageScript session closed");
let sessionClosing = false;
let resolveSessionClosing = () => {};
const sessionClosingSignal = new NativePromise<void>((resolve) => {
  resolveSessionClosing = resolve;
});

function recordFontUpgradeMutation(): void {
  try {
    const internalState = getInternalState();
    internalState.mutationSeq = (internalState.mutationSeq | 0) + 1;
    internalState.lastMutationAt = Date.now();
  } catch {}
}

function invalidateFontUpgradePaint(): void {
  try {
    invalidatePaintDom();
  } catch {}
}

function afterFontUpgrade(): void {
  try {
    state.dom?.fontsUpgraded?.();
  } catch {}
  recordFontUpgradeMutation();
  invalidateFontUpgradePaint();
}
setFontUpgradeCallback(afterFontUpgrade);

const MAX_FONT_UPGRADE_ERROR_URL_CHARS = 80;

function pendingAuthorFontUpgradeUrls(): string[] {
  const dom = state.dom;
  if (!dom || typeof dom.pendingAuthorFontUpgrades !== "function") return [];
  try {
    return dom.pendingAuthorFontUpgrades() ?? [];
  } catch {
    return [];
  }
}

async function fetchAuthorFontUpgrade(url: string): Promise<readonly [string, Uint8Array | null]> {
  try {
    return [url, await resolveFontUrlData(url)] as const;
  } catch (error) {
    console.warn(
      `[kitesurf-fonts] author upgrade fetch ${url.slice(0, MAX_FONT_UPGRADE_ERROR_URL_CHARS)} failed:`,
      String(error),
    );
    return [url, null] as const;
  }
}

function applyAuthorFontUpgrade(url: string, bytes: Uint8Array | null): void {
  if (!bytes || bytes.length === 0) return;
  try {
    upgradeAuthorFontFace(url, bytes);
  } catch (error) {
    console.warn(
      `[kitesurf-fonts] author upgrade swap ${url.slice(0, MAX_FONT_UPGRADE_ERROR_URL_CHARS)} failed:`,
      String(error),
    );
  }
}

setAuthorFontUpgradeHook(async () => {
  const urls = pendingAuthorFontUpgradeUrls();
  const fetched = await Promise.all(urls.map(fetchAuthorFontUpgrade));
  for (const [url, bytes] of fetched) {
    applyAuthorFontUpgrade(url, bytes);
  }
});

ksGlobal.__ksFontOutlineDemand = (): Promise<void> | null => {
  if (fontLoaderMode() !== "lazy") return null;
  return upgradeToFullFonts();
};
import { packException, packResult } from "./pack.ts";
import {
  dispatchLifecycle,
  extractScripts,
  planScripts,
  runAsyncPhase,
  runModulePhase,
  runRegularPhase,
} from "./scripts.ts";
import {
  DEFAULT_VIEWPORT_HEIGHT_PX,
  DEFAULT_VIEWPORT_WIDTH_PX,
  ksEventCtors,
  ksGlobal,
  state,
} from "./state.ts";
import { sanitizeCdpNodeTree } from "./cdp-nodes.ts";
import type { ShimDocument, ShimElement } from "./types.ts";
import {
  intersectionObserverStats,
  recheckIntersectionObservers,
} from "./intersection-observer.ts";
import { isolateKillLine, reportEngineError, setTailToken } from "./engine-error.ts";
import { installWasmTerminatedHandler } from "./wasm-crash.ts";
import { armTransitionDrain, isAnimating } from "./transitions.ts";
import {
  hasPendingAnimationFrames,
  beginRafDriverTurn,
  endRafDriverTurn,
  nextTimerTask,
  pageTimerDueWithin,
  pumpDuePageTasks,
  pumpPageTask,
  timerWheelStats,
  timersScheduledCount,
} from "./page-tasks.ts";
import { installGlobals } from "./globals.ts";
import { installNativeToString, markEngineFunctions } from "./native-functions.ts";

import {
  DomHandle,
  setDimsOnlyImages,
  setDarkColorScheme,
  setTtyUaCss,
  setTtyCellGrid,
  monoAdvancePerEm,
  setPixelFreeSession,
  upgradeAuthorFontFace,
  font_families_json,
  ks_boa_force_collect,
  ks_bridge_pins,
  ks_cycle_collect,
  ks_cycle_stats,
  ks_counter_style_rule,
  ks_parse_inline_style,
  ks_parse_typed_numeric_value,
  ks_parse_typed_style_value,
  ks_parse_stylesheet_structured,
  ks_serialize_inline_style,
  ks_get_property_value,
  ks_canonicalize_page_selectors,
  ks_encoding_name,
  ks_percent_encode_after_encoding,
  ks_encode_html,
  RuleStyleDeclarationStore,
  ks_ua_stylesheet,
  set_ks_tracing,
  ks_set_emit_hook,
  ks_js_span_enter,
  ks_js_span_exit,
  ks_call_cdp,
} from "./wasm-glue.js";
import {
  buildDocument,
  armKsOtel,
  ksSpan,
  cancelModelContextTool,
  callModelContextTool,
  listModelContextTools,
  stopModelContextToolWatch,
  setControlValueAsUser,
  decodeHtmlBytes,
  parseUrlForNode,
  detachedWrapperStats,
} from "./dom-shim.js";
import type { BuildDocumentOpts, BuildDocumentResult } from "./dom-shim.js";

import type { IsolateKillMarker } from "@kitesurf/jsrpc-types/shared";

const ISOLATE_KILL_MARKER: IsolateKillMarker = "[ks-kill]";

ksGlobal.__ksJsSpanEnter = ks_js_span_enter;
ksGlobal.__ksJsSpanExit = ks_js_span_exit;

interface FragmentLookupDoc {
  getElementById?: (id: string) => unknown;
  getElementsByName?: (name: string) => ArrayLike<unknown>;
}

function queuePageTask(callback: () => void): void {
  try {
    ksGlobal.setTimeout(callback, 0);
  } catch {
    try {
      callback();
    } catch {}
  }
}

function fragmentFromUrl(url: string): string | null {
  const hashIndex = String(url || "").indexOf("#");
  if (hashIndex < 0) return null;
  let fragment = url.slice(hashIndex + 1);
  try {
    fragment = decodeURIComponent(fragment);
  } catch {}
  return fragment;
}

function fragmentElement(doc: FragmentLookupDoc, fragment: string) {
  return ((doc.getElementById && doc.getElementById(fragment)) ||
    (doc.getElementsByName && doc.getElementsByName(fragment)[0]) ||
    null) as { scrollIntoView?: () => void } | null;
}

function scrollEmptyFragment(fragment: string): boolean {
  if (fragment !== "") return false;
  setScrollOffset(state.scrollX, 0);
  return true;
}

function scrollFragmentElement(element: { scrollIntoView?: () => void } | null): boolean {
  if (!element || typeof element.scrollIntoView !== "function") return false;
  element.scrollIntoView();
  return true;
}

function scrollNamedFragment(fragment: string): void {
  const doc = state.document as FragmentLookupDoc | null;
  if (!doc) return;
  const element = fragmentElement(doc, fragment);
  if (!scrollFragmentElement(element) && fragment === "top") setScrollOffset(state.scrollX, 0);
}

function scrollFragment(url: string): void {
  const fragment = fragmentFromUrl(url);
  if (fragment === null) return;
  if (scrollEmptyFragment(fragment)) return;
  scrollNamedFragment(fragment);
}

function scrollToFragment(url: string): void {
  try {
    scrollFragment(url);
  } catch (error) {
    console.error("[kitesurf] scrollToFragment failed:", error);
  }
}

let __ks_dispatchTrustedEvent: ((target: any, event: any) => boolean) | null = null;
let __ks_activateLabel: BuildDocumentResult["__ks_activateLabel"] | null = null;

let __ksRangeDrag: { el: any; changed: boolean } | null = null;

let __ksMouseDownTarget: any = null;
let __ksPointerDownCanceled = false;
let __ksCaretDragActive = false;
let __ksControlCaretAnchor: { el: any; offset: number } | null = null;
let __ksCaretDragOrigin: { x: number; y: number } | null = null;

function caretX(clientX: number, clientY: number, eventType: string): number {
  const cellWidth = Number(ksGlobal.__ks_tty_cell_w) || 0;
  if (!(cellWidth > 0)) return clientX;
  const left = Math.floor(clientX / cellWidth) * cellWidth;
  const CARET_CELL_EDGE_INSET_PX = 0.5;
  return caretDragPosition(
    left,
    cellWidth,
    clientX,
    clientY,
    eventType,
    __ksCaretDragOrigin,
    CARET_CELL_EDGE_INSET_PX,
  );
}

function caretDragPosition(
  left: number,
  cellWidth: number,
  clientX: number,
  clientY: number,
  eventType: string,
  dragOrigin: { x: number; y: number } | null,
  inset: number,
): number {
  if (eventType !== "mousemove" || !dragOrigin) return left + inset;
  const forward = isForwardCaretDrag(clientX, clientY, dragOrigin);
  return forward ? left + cellWidth - inset : left + inset;
}

function isForwardCaretDrag(
  clientX: number,
  clientY: number,
  dragOrigin: { x: number; y: number },
): boolean {
  return clientY > dragOrigin.y || (clientY === dragOrigin.y && clientX >= dragOrigin.x);
}
let __ksOverTarget: any = null;
let lastMousePosition: { x: number; y: number } | null = null;
let __ksOverChain: any[] = [];

let __ksSpaceArmedTarget: any = null;
let __ksSuppressChar = false;

function __ks_dispatchTrusted(target: any, event: any): boolean {
  if (__ks_dispatchTrustedEvent) {
    return __ks_dispatchTrustedEvent(target, event);
  }
  return target.dispatchEvent(event);
}

function setValueRawOnControl(element: any, value: string): void {
  let prototype = Object.getPrototypeOf(element);
  while (prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor && typeof descriptor.set === "function") {
      descriptor.set.call(element, value);
      return;
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  element.value = value;
}

function findControlValueGetter(element: any): ((this: any) => unknown) | undefined {
  let proto = Object.getPrototypeOf(element);
  while (proto) {
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && typeof desc.get === "function") return desc.get;
    proto = Object.getPrototypeOf(proto);
  }
  return undefined;
}

function controlValueString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function getValueRawOnControl(el: any): string {
  const getter = findControlValueGetter(el);
  const value = getter ? getter.call(el) : el.value;
  return controlValueString(value);
}

const KEYBOARD_ACTIVATABLE_INPUT_TYPES = new Set([
  "button",
  "submit",
  "reset",
  "checkbox",
  "radio",
  "image",
]);

function isButtonOrSummaryTag(tagName: string): boolean {
  return tagName === "BUTTON" || tagName === "SUMMARY";
}

function hasAnchorHref(element: ShimElement): boolean {
  return element.getAttribute?.("href") != null;
}

function isKeyboardActivatableInput(element: ShimElement): boolean {
  const type = String(element.getAttribute?.("type") || "").toLowerCase();
  return KEYBOARD_ACTIVATABLE_INPUT_TYPES.has(type);
}

function keyboardActivationForTag(element: ShimElement, tagName: string): boolean {
  if (isButtonOrSummaryTag(tagName)) return true;
  if (tagName === "A") return hasAnchorHref(element);
  return tagName === "INPUT" && isKeyboardActivatableInput(element);
}

function isKeyboardActivatable(element: ShimElement): boolean {
  try {
    const tagName = String(element.tagName || "").toUpperCase();
    return keyboardActivationForTag(element, tagName);
  } catch {
    return false;
  }
}

interface FocusableTabStop {
  element: ShimElement;
  tabIndex: number;
  domOrder: number;
}

const FORM_CONTROL_TAGS = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA"]);
const LINK_TAGS = new Set(["A", "AREA"]);

function isDisabledTabStop(element: ShimElement, tagName: string): boolean {
  return (
    isDisabledFormControl(element, tagName) ||
    isHiddenInput(tagName, element) ||
    isInertTabStop(element)
  );
}

function isDisabledFormControl(element: ShimElement, tagName: string): boolean {
  if (!FORM_CONTROL_TAGS.has(tagName)) return false;
  return Boolean(element.hasAttribute?.("disabled") || element.closest?.("fieldset[disabled]"));
}

function isHiddenInput(tagName: string, element: ShimElement): boolean {
  return tagName === "INPUT" && element.type === "hidden";
}

function isInertTabStop(element: ShimElement): boolean {
  return Boolean(element.closest?.("[inert]"));
}

function isNaturalTabStopTag(tagName: string): boolean {
  return FORM_CONTROL_TAGS.has(tagName) || tagName === "SUMMARY";
}

function isLinkTabStop(element: ShimElement, tagName: string): boolean {
  return LINK_TAGS.has(tagName) && Boolean(element.hasAttribute?.("href"));
}

function isEditableTabStop(editable: string | null): boolean {
  return editable !== null && editable.toLowerCase() !== "false";
}

function hasNaturalTabStop(
  element: ShimElement,
  tagName: string,
  editable: string | null,
): boolean {
  return (
    isNaturalTabStopTag(tagName) || isLinkTabStop(element, tagName) || isEditableTabStop(editable)
  );
}

function parseTabIndex(rawTabIndex: string | null): number | null {
  if (rawTabIndex === null || !/^[+-]?\d+$/.test(rawTabIndex.trim())) return null;
  const tabIndex = Number(rawTabIndex.trim());
  return Number.isFinite(tabIndex) ? tabIndex : null;
}

function isVisibleTabStop(element: ShimElement): boolean {
  return hasTabStopClientRect(element) && tabStopVisibleByStyle(element);
}

function hasTabStopClientRect(element: ShimElement): boolean {
  return Boolean(element.getClientRects?.()?.length);
}

function tabStopVisibleByStyle(element: ShimElement): boolean {
  const visibility = state.window?.getComputedStyle?.(element).visibility;
  return visibility !== "hidden" && visibility !== "collapse";
}

function readTabStopAttributes(element: ShimElement): {
  editable: string | null;
  tabIndex: number | null;
} {
  const editable = element.getAttribute?.("contenteditable") ?? null;
  const tabIndex = parseTabIndex(element.getAttribute?.("tabindex") ?? null);
  return { editable, tabIndex };
}

function tabStopIndexCandidate(element: ShimElement, tagName: string): number | null {
  const attributes = readTabStopAttributes(element);
  const isNatural = hasNaturalTabStop(element, tagName, attributes.editable);
  return attributes.tabIndex ?? (isNatural ? 0 : null);
}

function isVisibleNonnegativeTabIndex(index: number, element: ShimElement): boolean {
  return index >= 0 && isVisibleTabStop(element);
}

function resolveFocusableTabIndex(element: ShimElement, tagName: string): number | null {
  const candidate = tabStopIndexCandidate(element, tagName);
  if (candidate === null) return null;
  return isVisibleNonnegativeTabIndex(candidate, element) ? candidate : null;
}

function focusableTabIndex(element: ShimElement): number | null {
  const tagName = element.tagName ?? "";
  if (isDisabledTabStop(element, tagName)) return null;
  return resolveFocusableTabIndex(element, tagName);
}

function collectFocusableTabStops(
  documentNode: NonNullable<typeof state.document>,
): FocusableTabStop[] {
  const focusableElements: FocusableTabStop[] = [];
  const candidates = documentNode.querySelectorAll(
    "a[href], area[href], button, input, select, textarea, summary, [tabindex], [contenteditable]",
  );
  for (const element of Array.from(candidates)) {
    const tabIndex = focusableTabIndex(element);
    if (tabIndex === null) continue;
    focusableElements.push({ element, tabIndex, domOrder: focusableElements.length });
  }
  return focusableElements;
}

function compareTabStops(first: FocusableTabStop, second: FocusableTabStop): number {
  if (first.tabIndex === 0) {
    return second.tabIndex === 0 ? first.domOrder - second.domOrder : 1;
  }
  if (second.tabIndex === 0) return -1;
  return first.tabIndex - second.tabIndex || first.domOrder - second.domOrder;
}

function nextTabStopIndex(
  focusableElements: FocusableTabStop[],
  activeElement: unknown,
  reverse: boolean,
): number {
  const currentIndex = focusableElements.findIndex(({ element }) => element === activeElement);
  if (currentIndex < 0) return reverse ? focusableElements.length - 1 : 0;
  const step = reverse ? focusableElements.length - 1 : 1;
  return (currentIndex + step) % focusableElements.length;
}

function moveTabFocus(reverse: boolean): void {
  const documentNode = state.document;
  if (!documentNode) return;
  const focusableElements = collectFocusableTabStops(documentNode);
  if (!focusableElements.length) return;
  focusableElements.sort(compareTabStops);
  const nextElement =
    focusableElements[nextTabStopIndex(focusableElements, state.getActiveElement(), reverse)]
      .element;
  focusTabStop(nextElement);
}

function focusTabStop(element: ShimElement): void {
  element.focus?.();
  if (state.getActiveElement() === element) {
    element.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }
}

interface KeyScrollInit {
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  ttyKeyboard?: boolean;
}

const MAX_SCROLLABLE_ANCESTOR_DEPTH = 32;
const DEFAULT_KEY_SCROLL_STEP_PX = 40;
const SCROLL_BLOCKING_CONTROL_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

interface KeyScrollMetrics {
  lineHeight: number;
  lineWidth: number;
  pageHeight: number;
}

interface ScrollDelta {
  x: number;
  y: number;
}

const ZERO_SCROLL_DELTA: ScrollDelta = { x: 0, y: 0 };

function contentEditableScrollState(element: ShimElement): boolean | null {
  const editable = element.getAttribute?.("contenteditable");
  if (editable === null || editable === undefined) return null;
  return editable.toLowerCase() !== "false";
}

function focusedElementBlocksPageScroll(focused: ShimElement | null): boolean {
  for (
    let element: ShimElement | null | undefined = focused, depth = 0;
    element && depth < MAX_SCROLLABLE_ANCESTOR_DEPTH;
    element = element.parentElement, depth++
  ) {
    const decision = ancestorScrollDecision(element);
    if (decision === true) return true;
    if (decision === false) return false;
  }
  return false;
}

function ancestorScrollDecision(element: ShimElement): boolean | null {
  if (SCROLL_BLOCKING_CONTROL_TAGS.has(element.tagName ?? "")) return true;
  return contentEditableScrollState(element);
}

function keyScrollMetrics(): KeyScrollMetrics {
  const cellHeight = Number(ksGlobal.__ks_tty_cell_h) || 0;
  const cellWidth = Number(ksGlobal.__ks_tty_cell_w) || 0;
  const lineHeight = cellHeight || DEFAULT_KEY_SCROLL_STEP_PX;
  const lineWidth = cellWidth || DEFAULT_KEY_SCROLL_STEP_PX;
  return {
    lineHeight,
    lineWidth,
    pageHeight: Math.max(lineHeight, state.paintViewportH - lineHeight),
  };
}

function ctrlKeyScrollDelta(
  key: string,
  ttyKeyboard: boolean,
  metrics: KeyScrollMetrics,
): ScrollDelta {
  return ttyKeyboard ? ttyControlScrollDelta(key, metrics) : ZERO_SCROLL_DELTA;
}

function ttyControlScrollDelta(key: string, metrics: KeyScrollMetrics): ScrollDelta {
  const halfPage = Math.max(
    metrics.lineHeight,
    Math.floor(state.paintViewportH / (2 * metrics.lineHeight)) * metrics.lineHeight,
  );
  switch (key) {
    case "f":
      return { x: 0, y: metrics.pageHeight };
    case "b":
      return { x: 0, y: -metrics.pageHeight };
    case "d":
      return { x: 0, y: halfPage };
    case "u":
      return { x: 0, y: -halfPage };
    default:
      return ZERO_SCROLL_DELTA;
  }
}

function arrowKeyScrollDelta(key: string, metrics: KeyScrollMetrics): ScrollDelta | null {
  switch (key) {
    case "ArrowDown":
      return { x: 0, y: metrics.lineHeight };
    case "ArrowUp":
      return { x: 0, y: -metrics.lineHeight };
    case "ArrowRight":
      return { x: metrics.lineWidth, y: 0 };
    case "ArrowLeft":
      return { x: -metrics.lineWidth, y: 0 };
    default:
      return null;
  }
}

function ttyLetterScrollDelta(key: string, metrics: KeyScrollMetrics): ScrollDelta | null {
  switch (key) {
    case "j":
      return { x: 0, y: metrics.lineHeight };
    case "k":
      return { x: 0, y: -metrics.lineHeight };
    case "l":
      return { x: metrics.lineWidth, y: 0 };
    case "h":
      return { x: -metrics.lineWidth, y: 0 };
    default:
      return null;
  }
}

function pageKeyScrollDelta(
  key: string,
  isSpace: boolean,
  shiftKey: boolean | undefined,
  metrics: KeyScrollMetrics,
): ScrollDelta {
  const direction = pageKeyScrollDirection(key, isSpace, shiftKey);
  return direction === 0 ? ZERO_SCROLL_DELTA : { x: 0, y: direction * metrics.pageHeight };
}

function pageKeyScrollDirection(
  key: string,
  isSpace: boolean,
  shiftKey: boolean | undefined,
): -1 | 0 | 1 {
  if (key === "PageDown") return 1;
  if (key === "PageUp") return -1;
  if (!isSpace) return 0;
  return shiftKey ? -1 : 1;
}

function isSpaceScrollKey(key: string): boolean {
  return key === " " || key === "Spacebar";
}

function isButtonOrSummaryElement(element: ShimElement | null): boolean {
  if (!element) return false;
  return isButtonOrSummaryTag(element.tagName ?? "");
}

function shouldSuppressSpaceScroll(key: string, focused: ShimElement | null): boolean {
  return isSpaceScrollKey(key) && isButtonOrSummaryElement(focused);
}

function preferredDirectionalScrollDelta(
  key: string,
  init: KeyScrollInit | undefined,
  metrics: KeyScrollMetrics,
): ScrollDelta | null {
  const arrowDelta = arrowKeyScrollDelta(key, metrics);
  if (arrowDelta) return arrowDelta;
  if (init?.ttyKeyboard && !init.shiftKey) {
    return ttyLetterScrollDelta(key, metrics);
  }
  return null;
}

function normalKeyScrollDelta(
  key: string,
  init: KeyScrollInit | undefined,
  focused: ShimElement | null,
  metrics: KeyScrollMetrics,
): ScrollDelta {
  const isSpace = key === " " || key === "Spacebar";
  if (shouldSuppressSpaceScroll(key, focused)) return ZERO_SCROLL_DELTA;
  const directionalDelta = preferredDirectionalScrollDelta(key, init, metrics);
  if (directionalDelta) return directionalDelta;
  return pageKeyScrollDelta(key, isSpace, init?.shiftKey, metrics);
}

function tryScrollByWheel(target: ShimElement | null, delta: ScrollDelta): boolean {
  const scrollByWheel: unknown = ksGlobal.__ks_scrollByWheel;
  if (typeof scrollByWheel !== "function" || typeof target?._id !== "number") return false;
  try {
    return Boolean(scrollByWheel(target._id, delta.x, delta.y));
  } catch (error) {
    console.warn("[kitesurf-tty] scrollByWheel failed:", String(error));
    return false;
  }
}

function applyKeyScrollDelta(target: ShimElement | null, delta: ScrollDelta): void {
  if (delta.x === 0 && delta.y === 0) return;
  if (tryScrollByWheel(target, delta)) return;
  scrollBy(delta.x, delta.y);
}

function scrollForKey(key: string, init: KeyScrollInit | undefined): void {
  const documentNode = state.document;
  if (shouldIgnoreKeyScroll(documentNode, init) || !documentNode) return;
  const focused = state.getActiveElement();
  if (focusedElementBlocksPageScroll(focused)) return;
  const metrics = keyScrollMetrics();
  const delta = keyScrollDelta(key, init, focused, metrics);
  applyKeyScrollDelta(focused || documentNode.body, delta);
}

function shouldIgnoreKeyScroll(
  documentNode: typeof state.document,
  init: KeyScrollInit | undefined,
): boolean {
  return !documentNode || Boolean(init?.altKey || init?.metaKey);
}

function keyScrollDelta(
  key: string,
  init: KeyScrollInit | undefined,
  focused: ShimElement | null,
  metrics: KeyScrollMetrics,
): ScrollDelta {
  if (init?.ctrlKey) return ctrlKeyScrollDelta(key, init.ttyKeyboard === true, metrics);
  return normalKeyScrollDelta(key, init, focused, metrics);
}

const MAX_ANCESTOR_CHAIN_NODES = 512;

function __ksAncestorChain(node: any): any[] {
  const chain: any[] = [];
  let currentNode = node;
  for (let depth = 0; currentNode && depth < MAX_ANCESTOR_CHAIN_NODES; depth++) {
    chain.push(currentNode);
    const next = safeParentNode(currentNode);
    if (next === currentNode) break;
    currentNode = next;
  }
  return chain;
}

function safeParentNode(node: any): any {
  try {
    return node.parentNode || null;
  } catch {
    return null;
  }
}

function findCommonAncestor(firstChain: any[], secondChain: any[]): any {
  for (const node of firstChain) {
    if (secondChain.indexOf(node) !== -1) return node;
  }
  return null;
}

function __ksCommonAncestor(firstNode: any, secondNode: any): any {
  if (!firstNode || !secondNode) return null;
  if (firstNode === secondNode) return firstNode;
  return findCommonAncestor(__ksAncestorChain(firstNode), __ksAncestorChain(secondNode));
}

function __ksIsConnected(node: any): boolean {
  try {
    return node != null && node.isConnected === true;
  } catch {
    return false;
  }
}

function __ksFirstConnected(chain: any[]): any {
  for (const candidate of chain) {
    if (__ksIsConnected(candidate)) return candidate;
  }
  return null;
}

function __ksSetOverTarget(node: any, chain?: any[]): void {
  __ksOverTarget = node;
  __ksOverChain = node ? chain || __ksAncestorChain(node) : [];
}

function takePendingSubmitNav() {
  const internalState = getInternalState();
  internalState.dispatchingUserEvent = false;
  const nav = internalState.pendingSubmitNav;
  internalState.pendingSubmitNav = null;
  return nav;
}

function __ksFireBoundaryEvent(
  node: any,
  type: string,
  related: any,
  bubbles: boolean,
  init: any,
): void {
  const pointer = type.startsWith("pointer");
  const EventConstructor = pointer ? ksEventCtors.PointerEvent : ksEventCtors.MouseEvent;
  if (typeof EventConstructor !== "function" || !node) return;
  try {
    __ks_dispatchTrusted(
      node,
      new EventConstructor(type, boundaryEventInit(pointer, related, bubbles, init)),
    );
  } catch {}
}

function boundaryEventInit(pointer: boolean, related: any, bubbles: boolean, init: any): object {
  return {
    ...init,
    ...(pointer ? { pointerId: 1, pointerType: "mouse", isPrimary: true } : {}),
    bubbles,
    cancelable: bubbles,
    composed: bubbles,
    button: 0,
    detail: 0,
    relatedTarget: related || null,
  };
}

function isBoundaryEventElement(node: any): boolean {
  try {
    return node && node.nodeType === 1;
  } catch {
    return false;
  }
}

type BoundaryEventDispatcher = (node: any, type: string, related: any, bubbles: boolean) => void;

function dispatchBoundaryExit(
  from: any,
  to: any,
  common: any,
  fire: BoundaryEventDispatcher,
  kind: string,
): void {
  if (!from) return;
  fire(from, `${kind}out`, to, true);
  for (const node of __ksAncestorChain(from)) {
    if (node === common) break;
    if (isBoundaryEventElement(node)) fire(node, `${kind}leave`, to, false);
  }
}

function dispatchBoundaryEnter(
  from: any,
  to: any,
  common: any,
  fire: BoundaryEventDispatcher,
  kind: string,
): void {
  if (!to) return;
  fire(to, `${kind}over`, from, true);
  dispatchBoundaryEnterAncestors(boundaryEnterAncestors(to, common), from, fire, kind);
}

function boundaryEnterAncestors(to: any, common: any): any[] {
  const entered: any[] = [];
  for (const node of __ksAncestorChain(to)) {
    if (node === common) break;
    if (isBoundaryEventElement(node)) entered.push(node);
  }
  return entered;
}

function dispatchBoundaryEnterAncestors(
  entered: any[],
  from: any,
  fire: BoundaryEventDispatcher,
  kind: string,
): void {
  for (let i = entered.length - 1; i >= 0; i--) {
    fire(entered[i], `${kind}enter`, from, false);
  }
}

function __ksDispatchBoundaryEvents(from: any, to: any, init: any): void {
  const common = __ksCommonAncestor(from, to);
  const fire: BoundaryEventDispatcher = (node, type, related, bubbles) =>
    __ksFireBoundaryEvent(node, type, related, bubbles, init);
  for (const kind of ["pointer", "mouse"]) {
    dispatchBoundaryExit(from, to, common, fire, kind);
    dispatchBoundaryEnter(from, to, common, fire, kind);
  }
}

interface ContentWindowPostMessageArgs {
  message: unknown;
  targetOrigin: unknown;
  transfer: any[];
}

function isPostMessageOptions(value: unknown): boolean {
  return value === null || typeof value === "object";
}

function usesPostMessageOptions(args: any[], targetOrigin: unknown): boolean {
  return args.length < 3 && targetOrigin !== undefined && isPostMessageOptions(targetOrigin);
}

function postMessageOptionsValues(targetOrigin: any): {
  targetOrigin: unknown;
  transfer: unknown;
} {
  if (targetOrigin === null) return { targetOrigin: undefined, transfer: undefined };
  const transfer = targetOrigin.transfer;
  return { targetOrigin: targetOrigin.targetOrigin, transfer };
}

function collectPostMessageTransfer(rawTransfer: any): any[] {
  if (rawTransfer === undefined) return [];
  if (!isIterableTransferList(rawTransfer)) {
    throw new TypeError(
      "Failed to execute 'postMessage' on 'Window': The provided value cannot be converted to a sequence.",
    );
  }
  const transfer: any[] = [];
  for (const transferable of rawTransfer) {
    if (!isTransferListObject(transferable)) {
      throw new TypeError(
        "Failed to execute 'postMessage' on 'Window': Transferable entry is not an object.",
      );
    }
    transfer.push(transferable);
  }
  return transfer;
}

function isIterableTransferList(value: any): boolean {
  return (
    value !== null && typeof value === "object" && typeof value[Symbol.iterator] === "function"
  );
}

function isTransferListObject(value: any): boolean {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function contentWindowPostMessageArgs(args: any[]): ContentWindowPostMessageArgs {
  if (args.length === 0) {
    throw new TypeError(
      "Failed to execute 'postMessage' on 'Window': 1 argument required, but only 0 present.",
    );
  }
  const message = args[0];
  let targetOrigin: any = args[1];
  let rawTransfer: any = args.length >= 3 ? args[2] : undefined;
  if (usesPostMessageOptions(args, targetOrigin)) {
    const options = postMessageOptionsValues(targetOrigin);
    rawTransfer = options.transfer;
    targetOrigin = options.targetOrigin;
  }
  return { message, targetOrigin, transfer: collectPostMessageTransfer(rawTransfer) };
}

function postMessageDataCloneError(message: string): Error {
  const DOMExceptionConstructor: any = ksGlobal.DOMException;
  return typeof DOMExceptionConstructor === "function"
    ? new DOMExceptionConstructor(message, "DataCloneError")
    : Object.assign(new Error(message), { name: "DataCloneError" });
}

function serializePostMessage(message: unknown): string {
  try {
    return JSON.stringify(message === undefined ? null : message) ?? "null";
  } catch {
    const DOMExceptionConstructor: any = ksGlobal.DOMException;
    throw DOMExceptionConstructor
      ? new DOMExceptionConstructor("The object could not be cloned.", "DataCloneError")
      : new Error("DataCloneError: the object could not be cloned.");
  }
}

function validatePostMessageTargetOrigin(targetOrigin: string): void {
  if (targetOrigin === "*" || targetOrigin === "/") return;
  try {
    new URL(targetOrigin);
  } catch {
    const DOMExceptionConstructor: any = ksGlobal.DOMException;
    const message = `Failed to execute 'postMessage' on 'Window': Invalid target origin '${targetOrigin}'.`;
    throw DOMExceptionConstructor
      ? new DOMExceptionConstructor(message, "SyntaxError")
      : new Error(message);
  }
}

function isMessagePortTransferable(value: any, MessagePortConstructor: any): boolean {
  return typeof MessagePortConstructor === "function" && value instanceof MessagePortConstructor;
}

function validatePostMessageTransferable(value: any, MessagePortConstructor: any): void {
  if (isMessagePortTransferable(value, MessagePortConstructor)) {
    validateMessagePortTransferable(value);
    return;
  }
  if (value instanceof ArrayBuffer) {
    validateArrayBufferTransferable(value);
    return;
  }
  throw postMessageDataCloneError("Value is not transferable.");
}

function validateMessagePortTransferable(value: any): void {
  if (value._closed || value._detached) {
    throw postMessageDataCloneError("MessagePort is already detached.");
  }
}

function validateArrayBufferTransferable(value: ArrayBuffer): void {
  if (value.detached === true) {
    throw postMessageDataCloneError("ArrayBuffer is already detached.");
  }
}

function validatePostMessageTransfers(transfer: any[], MessagePortConstructor: any): void {
  const seen = new Set();
  for (const transferable of transfer) {
    if (seen.has(transferable)) {
      throw postMessageDataCloneError("Duplicate transferable in transfer list.");
    }
    seen.add(transferable);
    validatePostMessageTransferable(transferable, MessagePortConstructor);
  }
}

function transferPostMessageItem(transferable: any, MessagePortConstructor: any): void {
  if (isMessagePortTransferable(transferable, MessagePortConstructor)) {
    if (typeof transferable.__ksTransfer === "function") transferable.__ksTransfer();
  } else if (typeof transferable.transfer === "function") {
    transferable.transfer();
  }
}

function transferPostMessageItems(transfer: any[], MessagePortConstructor: any): void {
  for (const transferable of transfer) {
    transferPostMessageItem(transferable, MessagePortConstructor);
  }
}

function postMessageSourceOrigin(): string {
  try {
    return new URL(state.pageUrl || "").origin;
  } catch {
    return "";
  }
}

function sendContentWindowPostMessage(
  iframeElement: any,
  dataJson: string,
  targetOrigin: string,
): void {
  sendUpstreamEvent({
    event: "kitesurf.postMessage",
    params: {
      toFrameOwnerId: typeof iframeElement?._id === "number" ? iframeElement._id : -1,
      dataJson,
      targetOrigin,
      sourceOrigin: postMessageSourceOrigin(),
    },
  });
}

function __wireContentWindowPostMessage(contentWindow: any, iframeElement: any): void {
  contentWindow.postMessage = function (...args: any[]): void {
    const postMessageArgs = contentWindowPostMessageArgs(args);
    const dataJson = serializePostMessage(postMessageArgs.message);
    const targetOrigin =
      postMessageArgs.targetOrigin === undefined ? "/" : String(postMessageArgs.targetOrigin);
    validatePostMessageTargetOrigin(targetOrigin);
    const MessagePortConstructor: any = ksGlobal.MessagePort;
    validatePostMessageTransfers(postMessageArgs.transfer, MessagePortConstructor);
    transferPostMessageItems(postMessageArgs.transfer, MessagePortConstructor);
    sendContentWindowPostMessage(iframeElement, dataJson, targetOrigin);
  };
}

const FACADE_LOCATION_PARTS = [
  "protocol",
  "host",
  "hostname",
  "port",
  "pathname",
  "search",
  "hash",
] as const;

interface FacadeLocation {
  href: string;
  readonly origin: string;
  toString(): string;
  assign(value: unknown): void;
  replace(value: unknown): void;
  reload(): void;
}

const iframeFacadeLocations = new WeakMap<object, FacadeLocation>();

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return String(Reflect.get(Object(error), "message") || error);
}

function errorMessageOrValue(error: unknown): string {
  return String(Reflect.get(Object(error), "message") ?? error);
}

function classicBucketErrorDetail(error: unknown): string {
  const errorObject = Object(error);
  const message: unknown = Reflect.get(errorObject, "message");
  if (!error || !message) return String(error);
  const name: unknown = Reflect.get(errorObject, "name");
  const stack: unknown = Reflect.get(errorObject, "stack");
  return String(name) + ": " + String(message) + (stack ? "\n" + String(stack) : "");
}

function locationInputString(value: unknown): string {
  if (typeof value === "symbol") {
    throw new TypeError("Cannot convert a Symbol value to a string");
  }
  return String(value);
}

function warnIframeFailure(error: unknown, context: Record<string, unknown>): void {
  try {
    console.warn("[kitesurf-iframe] operation failed", {
      ...context,
      error: error instanceof Error ? error.message : String(error),
    });
  } catch {}
}

function facadeLocationBaseUrl(): string | undefined {
  return state.document?.baseURI || state.pageUrl || undefined;
}

function invalidFacadeLocationUrlError(iframeEl: object, contentWindow: object): DOMException {
  const error = new DOMException("Invalid URL", "SyntaxError");
  const frameWindow: unknown = Reflect.get(iframeEl, "__ks_iframeContentWindow", iframeEl);
  const frameDomException: unknown =
    Reflect.get(contentWindow, "DOMException", contentWindow) ??
    (isObjectRecord(frameWindow)
      ? Reflect.get(frameWindow, "DOMException", frameWindow)
      : undefined);
  if (typeof frameDomException === "function") {
    Object.defineProperty(error, "constructor", { value: frameDomException });
  }
  return error;
}

function resolveFacadeLocationHref(href: string, iframeEl: object, contentWindow: object): string {
  try {
    return new URL(href, facadeLocationBaseUrl()).toString();
  } catch {
    throw invalidFacadeLocationUrlError(iframeEl, contentWindow);
  }
}

function navigateFacadeLocation(iframeEl: object, resolved: string): void {
  try {
    handleIframeSrcChange(iframeEl, resolved);
  } catch (error) {
    warnIframeFailure(error, { operation: "navigate location", url: resolved });
  }
}

function __makeFacadeLocation(iframeEl: object, url: string, contentWindow: object) {
  let current = url;
  const loc: FacadeLocation = {
    get href() {
      return current;
    },
    set href(v: string) {
      const href = locationInputString(v);
      const resolved = resolveFacadeLocationHref(href, iframeEl, contentWindow);
      current = resolved;
      navigateFacadeLocation(iframeEl, resolved);
    },
    get origin() {
      try {
        return new URL(current).origin;
      } catch (error) {
        warnIframeFailure(error, { operation: "read location origin", url: current });
        return "null";
      }
    },
    toString() {
      return current;
    },
    assign(v: unknown) {
      loc.href = locationInputString(v);
    },
    replace(v: unknown) {
      loc.href = locationInputString(v);
    },
    reload() {
      loc.href = current;
    },
  };
  for (const part of FACADE_LOCATION_PARTS) {
    Object.defineProperty(loc, part, {
      enumerable: true,
      get() {
        try {
          return new URL(current)[part];
        } catch (error) {
          warnIframeFailure(error, {
            operation: "read location component",
            part,
            url: current,
          });
          return "";
        }
      },
      set(v: unknown) {
        try {
          const next = new URL(current);
          next[part] = String(v);
          loc.href = next.toString();
        } catch (error) {
          warnIframeFailure(error, {
            operation: "write location component",
            part,
            url: current,
          });
        }
      },
    });
  }
  return loc;
}

function setIframeFacadeLocation(contentWindow: object, iframeEl: object, url: string): void {
  const location = __makeFacadeLocation(iframeEl, url, contentWindow);
  if (iframeFacadeLocations.has(contentWindow)) {
    iframeFacadeLocations.set(contentWindow, location);
    return;
  }
  iframeFacadeLocations.set(contentWindow, location);
  Object.defineProperty(contentWindow, "location", {
    enumerable: true,
    configurable: false,
    get() {
      return iframeFacadeLocations.get(contentWindow);
    },
    set(value: unknown) {
      const current = iframeFacadeLocations.get(contentWindow);
      if (current) current.href = locationInputString(value);
    },
  });
}

function __makeCrossOriginContentWindow(iframeElement: any, url: string) {
  const win = ksGlobal.window ?? globalThis;
  const contentWindow: any = {
    document: null,
    parent: win,
    top: win,
    frames: [],
    name: (() => {
      try {
        return String(iframeElement.getAttribute?.("name") ?? "");
      } catch {
        return "";
      }
    })(),
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
  };
  setIframeFacadeLocation(contentWindow, iframeElement, url);
  contentWindow.self = contentWindow;
  contentWindow.window = contentWindow;
  __wireContentWindowPostMessage(contentWindow, iframeElement);
  return contentWindow;
}

function __decorateContentWindow(contentWindow: any) {
  const pageGlobal: any = globalThis;
  const names = [
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "ReferenceError",
    "URIError",
    "EvalError",
    "Array",
    "Object",
    "String",
    "Number",
    "Boolean",
    "Symbol",
    "Promise",
    "Function",
    "Date",
    "RegExp",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "JSON",
    "Math",
    "Node",
    "Element",
    "Document",
    "DocumentFragment",
    "Event",
    "MessageEvent",
    "CustomEvent",
    "DOMException",
    "NodeList",
    "HTMLCollection",
    "DOMParser",
    "Range",
    "StaticRange",
    "URL",
    "URLSearchParams",
    "Blob",
    "FormData",
    "Headers",
    "Request",
    "Response",
    "AbortController",
    "AbortSignal",
  ];
  for (const globalName of names) {
    if (contentWindow[globalName] === undefined && pageGlobal[globalName] !== undefined) {
      contentWindow[globalName] = pageGlobal[globalName];
    }
  }
}

interface StaticIframeSetup {
  document: { querySelectorAll(selector: string): unknown };
  parser: any;
}

function staticIframeSetup(): StaticIframeSetup | null {
  const document = ksGlobal.document;
  if (!document || typeof document.querySelectorAll !== "function") return null;
  const DOMParserConstructor = ksGlobal.DOMParser;
  if (!DOMParserConstructor) return null;
  return { document, parser: DOMParserConstructor };
}

function queryStaticIframes(document: StaticIframeSetup["document"]): any {
  try {
    return document.querySelectorAll("iframe");
  } catch {
    return undefined;
  }
}

function readIframeSrc(iframeElement: any): string {
  try {
    return String(iframeElement.getAttribute?.("src") ?? "");
  } catch {
    return "";
  }
}

function resolveIframeUrl(iframeElement: any, src: string): string {
  if (!src || src === "about:blank") return "about:blank";
  try {
    return parseUrlForNode(iframeElement, src, state.pageUrl || undefined).toString();
  } catch {
    return "about:blank";
  }
}

function preinstallStaticIframe(iframeElement: any, win: unknown, DOMParserConstructor: any): void {
  if (!iframeElement || iframeElement.__ks_iframeContentWindow) return;
  const src = readIframeSrc(iframeElement);
  const resolvedUrl = resolveIframeUrl(iframeElement, src);
  installPlaceholderContentDocument(iframeElement, resolvedUrl, win, DOMParserConstructor);
}

function preinstallStaticIframes(): void {
  const setup = staticIframeSetup();
  if (!setup) return;
  const iframeElements = queryStaticIframes(setup.document);
  if (iframeElements === undefined) return;
  const win = ksGlobal.window ?? globalThis;
  for (const iframeElement of iframeElements as any) {
    preinstallStaticIframe(iframeElement, win, setup.parser);
  }
}

function mintDynamicFrameId(): string {
  const DYNAMIC_FRAME_ID_RADIX = 16;
  const DYNAMIC_FRAME_ID_HEX_DIGITS = 32;
  let out = "";
  for (let i = 0; i < DYNAMIC_FRAME_ID_HEX_DIGITS; i++) {
    out += Math.floor(Math.random() * DYNAMIC_FRAME_ID_RADIX).toString(DYNAMIC_FRAME_ID_RADIX);
  }
  return out;
}

const pendingDocumentLoads = new WeakMap<object, object>();
const SRCDOC_URL = "about:srcdoc";

function isAboutBlankUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "about:" && u.pathname === "blank";
  } catch {
    return false;
  }
}

function readSrcdoc(iframeEl: unknown): string | null {
  if (!isObjectRecord(iframeEl)) return null;
  const getAttribute = iframeEl.getAttribute;
  if (typeof getAttribute !== "function") return null;
  const value: unknown = Reflect.apply(getAttribute, iframeEl, ["srcdoc"]);
  return typeof value === "string" ? value : null;
}

function queueSrcdocLoad(
  iframeEl: object,
  srcdoc: string,
  win: unknown,
  DOMParserConstructor: unknown,
): void {
  const pendingLoad = {};
  pendingDocumentLoads.set(iframeEl, pendingLoad);
  Promise.resolve().then(() => {
    if (pendingDocumentLoads.get(iframeEl) !== pendingLoad) return;
    pendingDocumentLoads.delete(iframeEl);
    void loadDynamicIframe(iframeEl, SRCDOC_URL, win, DOMParserConstructor, srcdoc);
  });
}

interface IframeNavigationTarget {
  src: string;
  url: string;
}

function dynamicIframeNavigationTarget(
  iframeEl: any,
  srcdoc: string | null,
): IframeNavigationTarget {
  const src = readIframeSrc(iframeEl);
  return {
    src,
    url: srcdoc === null ? resolveIframeUrl(iframeEl, src) : SRCDOC_URL,
  };
}

function attachDynamicIframe(iframeEl: any, resolvedUrl: string): string {
  const frameId = mintDynamicFrameId();
  iframeEl.__ks_iframeFrameId = frameId;
  sendUpstreamEvent({
    event: "kitesurf.frameAttached",
    params: {
      frameId,
      ownerBackendNodeId: iframeEl._id ?? -1,
      url: resolvedUrl,
    },
  });
  return frameId;
}

function originOfUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function isCrossOriginFrameUrl(url: string): boolean {
  const pageOrigin = originOfUrl(state.pageUrl);
  const frameOrigin = originOfUrl(url);
  return Boolean(pageOrigin && frameOrigin && pageOrigin !== frameOrigin);
}

function setCrossOriginIframeDocument(iframeEl: any, resolvedUrl: string): void {
  const contentWindow =
    iframeEl.__ks_iframeContentWindow ?? __makeCrossOriginContentWindow(iframeEl, resolvedUrl);
  try {
    contentWindow.document = null;
  } catch {}
  setIframeFacadeLocation(contentWindow, iframeEl, resolvedUrl);
  iframeEl.__ks_iframeContentDocument = null;
  iframeEl.__ks_iframeContentWindow = contentWindow;
}

function scheduleCrossOriginIframeLoad(iframeEl: any, frameId: string, resolvedUrl: string): void {
  Promise.resolve().then(() => {
    setCrossOriginIframeDocument(iframeEl, resolvedUrl);
    emitFrameLifecycle(frameId, resolvedUrl);
    fireIframeLoad(iframeEl);
  });
}

function completeInsertedIframeLoad(
  iframeEl: any,
  srcdoc: string | null,
  src: string,
  resolvedUrl: string,
  frameId: string,
  win: unknown,
  DOMParserConstructor: any,
): void {
  if (srcdoc !== null) {
    queueSrcdocLoad(iframeEl, srcdoc, win, DOMParserConstructor);
    return;
  }
  if (isAboutBlankUrl(resolvedUrl) || !src) {
    emitFrameLifecycle(frameId, "about:blank");
    fireIframeLoad(iframeEl);
    return;
  }
  if (isCrossOriginFrameUrl(resolvedUrl)) {
    scheduleCrossOriginIframeLoad(iframeEl, frameId, resolvedUrl);
    return;
  }
  void loadDynamicIframe(iframeEl, resolvedUrl, win, DOMParserConstructor);
}

function handleDynamicIframeInsert(iframeEl: any): void {
  if (!iframeEl) return;
  if (iframeEl.__ks_iframeContentWindow) {
    handleIframeSrcChange(iframeEl);
    return;
  }
  const win = ksGlobal.window ?? globalThis;
  const DOMParserConstructor = ksGlobal.DOMParser;
  if (!DOMParserConstructor) return;
  const srcdoc = readSrcdoc(iframeEl);
  const { src, url: resolvedUrl } = dynamicIframeNavigationTarget(iframeEl, srcdoc);
  installPlaceholderContentDocument(
    iframeEl,
    resolvedUrl,
    win,
    DOMParserConstructor,
    "about:blank",
  );
  const frameId = attachDynamicIframe(iframeEl, resolvedUrl);
  completeInsertedIframeLoad(
    iframeEl,
    srcdoc,
    src,
    resolvedUrl,
    frameId,
    win,
    DOMParserConstructor,
  );
}

function hasIframeContentWindow(iframeEl: any): boolean {
  return Boolean(iframeEl && iframeEl.__ks_iframeContentWindow);
}

function iframeNavigationTarget(iframeEl: any, urlOverride?: string): IframeNavigationTarget {
  if (typeof urlOverride === "string" && urlOverride.length > 0) {
    return { src: urlOverride, url: urlOverride };
  }
  const src = readIframeSrc(iframeEl);
  return { src, url: resolveIframeUrl(iframeEl, src) };
}

function scheduleCrossOriginSourceChange(
  iframeEl: any,
  frameId: string,
  resolvedUrl: string,
): void {
  setCrossOriginIframeDocument(iframeEl, resolvedUrl);
  Promise.resolve().then(() => {
    emitFrameLifecycle(frameId, resolvedUrl);
    fireIframeLoad(iframeEl);
  });
}

function scheduleBlankIframeNavigation(
  iframeEl: any,
  frameId: string,
  resolvedUrl: string,
  win: unknown,
  DOMParserConstructor: any,
): void {
  installPlaceholderContentDocument(
    iframeEl,
    resolvedUrl,
    win,
    DOMParserConstructor,
    undefined,
    frameNavigationReferrer(resolvedUrl),
  );
  const pendingLoad = {};
  pendingDocumentLoads.set(iframeEl, pendingLoad);
  Promise.resolve().then(() => {
    if (pendingDocumentLoads.get(iframeEl) !== pendingLoad) return;
    pendingDocumentLoads.delete(iframeEl);
    emitFrameLifecycle(frameId, resolvedUrl);
    fireIframeLoad(iframeEl);
  });
}

function isBlankIframeNavigation(src: string, resolvedUrl: string): boolean {
  return isAboutBlankUrl(resolvedUrl) || !src;
}

function usesIframeLocationOverride(urlOverride: string | undefined): boolean {
  return typeof urlOverride === "string" && urlOverride.length > 0;
}

function queueIframeSrcdocLoadIfNeeded(
  iframeEl: any,
  urlOverride: string | undefined,
  win: unknown,
  DOMParserConstructor: any,
): boolean {
  const srcdoc = usesIframeLocationOverride(urlOverride) ? null : readSrcdoc(iframeEl);
  if (srcdoc === null) return false;
  queueSrcdocLoad(iframeEl, srcdoc, win, DOMParserConstructor);
  return true;
}

function isCrossOriginSourceChange(src: string, resolvedUrl: string): boolean {
  return Boolean(src) && !isAboutBlankUrl(resolvedUrl) && isCrossOriginFrameUrl(resolvedUrl);
}

function handleResolvedIframeSourceChange(
  iframeEl: any,
  src: string,
  resolvedUrl: string,
  win: unknown,
  DOMParserConstructor: any,
  post: IframePost | undefined,
): void {
  const frameId = (iframeEl as any).__ks_iframeFrameId;
  if (isCrossOriginSourceChange(src, resolvedUrl)) {
    scheduleCrossOriginSourceChange(iframeEl, frameId, resolvedUrl);
    return;
  }
  if (isBlankIframeNavigation(src, resolvedUrl)) {
    scheduleBlankIframeNavigation(iframeEl, frameId, resolvedUrl, win, DOMParserConstructor);
    return;
  }
  void loadDynamicIframe(iframeEl, resolvedUrl, win, DOMParserConstructor, undefined, post);
}

function handleIframeSrcChange(iframeEl: any, urlOverride?: string, post?: IframePost): void {
  if (!hasIframeContentWindow(iframeEl)) return;
  pendingDocumentLoads.delete(iframeEl);
  const win = ksGlobal.window ?? globalThis;
  const DOMParserConstructor = ksGlobal.DOMParser;
  if (!DOMParserConstructor) return;
  if (queueIframeSrcdocLoadIfNeeded(iframeEl, urlOverride, win, DOMParserConstructor)) return;
  const { src, url: resolvedUrl } = iframeNavigationTarget(iframeEl, urlOverride);
  handleResolvedIframeSourceChange(iframeEl, src, resolvedUrl, win, DOMParserConstructor, post);
}

// The referrer a frame navigation from this document to `url` carries,
// which is what the committed frame document reports.
function frameNavigationReferrer(url: string): string {
  return determineReferrer(state.pageUrl, url, parseReferrerPolicy(startupReferrerPolicy));
}

// dom-shim's ParsedDocument reports this slot as document.referrer.
interface FrameDocument {
  _referrer?: string;
}

function setFrameReferrer(doc: FrameDocument | null, referrer: string): void {
  if (doc) doc._referrer = referrer;
}

function preparePlaceholderDocument(
  contentDoc: any,
  documentUrl: string,
  referrer: string | undefined,
): void {
  if (!contentDoc) return;
  contentDoc._mutable = true;
  setFrameReferrer(contentDoc, referrer ?? state.pageUrl);
  if (documentUrl) {
    try {
      Object.defineProperty(contentDoc, "_baseUrl", {
        value: documentUrl,
        configurable: true,
        writable: true,
      });
    } catch {}
  }
}

function parsePlaceholderDocument(
  DOMParserConstructor: any,
  documentUrl: string,
  referrer: string | undefined,
): any {
  let contentDoc: any = null;
  try {
    const parser = new DOMParserConstructor();
    // No doctype: an about:blank document is in quirks mode.
    contentDoc = parser.parseFromString("<html><head></head><body></body></html>", "text/html");
  } catch {}
  preparePlaceholderDocument(contentDoc, documentUrl, referrer);
  return contentDoc;
}

function placeholderFrameName(iframeEl: any): string {
  try {
    return String(iframeEl.getAttribute?.("name") ?? "");
  } catch {
    return "";
  }
}

function createPlaceholderContentWindow(
  iframeEl: any,
  url: string,
  win: any,
  contentDoc: any,
): any {
  const contentWindow: any = {
    document: contentDoc,
    parent: win,
    top: win,
    frames: [],
    name: placeholderFrameName(iframeEl),
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
  };
  setIframeFacadeLocation(contentWindow, iframeEl, url);
  contentWindow.self = contentWindow;
  contentWindow.window = contentWindow;
  contentWindow.frameElement = iframeEl;
  __decorateContentWindow(contentWindow);
  __wireContentWindowPostMessage(contentWindow, iframeEl);
  return contentWindow;
}

function setPlaceholderDefaultView(contentDoc: any, contentWindow: any): void {
  if (!contentDoc) return;
  try {
    Object.defineProperty(contentDoc, "defaultView", {
      value: contentWindow,
      configurable: true,
    });
  } catch {}
}

function installPlaceholderContentDocument(
  iframeEl: any,
  url: string,
  win: any,
  DOMParserConstructor: any,
  docUrl?: string,
  // Unset for the initial about:blank document, whose referrer is its
  // creator's URL; a navigation to about:blank passes its own.
  referrer?: string,
) {
  const documentUrl = docUrl ?? url;
  const contentDoc = parsePlaceholderDocument(DOMParserConstructor, documentUrl, referrer);
  const contentWindow = createPlaceholderContentWindow(iframeEl, url, win, contentDoc);
  setPlaceholderDefaultView(contentDoc, contentWindow);
  iframeEl.__ks_iframeContentDocument = contentDoc;
  iframeEl.__ks_iframeContentWindow = contentWindow;
}

function fetchDynamicIframeDocument(url: string, post: IframePost | undefined): Promise<Response> {
  const NAVIGATION_POST_BODY_BYTE_MASK = 0xff;
  const init: RequestInit | undefined = post
    ? {
        method: "POST",
        headers: { "content-type": post.contentType },
        body: Uint8Array.from(
          post.body,
          (character) => character.charCodeAt(0) & NAVIGATION_POST_BODY_BYTE_MASK,
        ),
      }
    : undefined;
  return trustedFetch(url, init, {
    resourceType: "Document",
    initiator: "parser",
  });
}

function warnDynamicIframeStatus(response: Response, url: string): void {
  try {
    console.warn("[kitesurf-iframe] dynamic iframe fetch " + response.status + " for " + url);
  } catch {}
}

interface DynamicIframeSource {
  html: string;
  characterSet: string;
  decodedResponse: boolean;
  finalUrl: string;
  contentType: string | null;
  bytes: Uint8Array | null;
}

function responseHasIframeBody(response: Response): boolean {
  return Boolean(response && response.ok && response.status !== 204 && response.status !== 205);
}

async function responseIframeBytes(response: Response, url: string): Promise<Uint8Array | null> {
  if (responseHasIframeBody(response)) {
    return new Uint8Array(await response.arrayBuffer());
  }
  if (response && !response.ok) warnDynamicIframeStatus(response, url);
  return null;
}

async function loadDynamicIframeBytes(
  url: string,
  post: IframePost | undefined,
  source: DynamicIframeSource,
): Promise<void> {
  const blob = state.blobUrls.get(url);
  if (blob) {
    source.contentType = blob.type || null;
    source.bytes = new Uint8Array(await blob.arrayBuffer());
    return;
  }
  const response = await fetchDynamicIframeDocument(url, post);
  source.finalUrl = response && response.url ? response.url : url;
  source.contentType = responseHeaderGet(response, "content-type");
  source.bytes = await responseIframeBytes(response, url);
}

function warnDynamicIframeFetchError(url: string, error: unknown): void {
  try {
    console.warn(
      "[kitesurf-iframe] dynamic iframe fetch failed for " + url + ":",
      error instanceof Error ? error.message : String(error),
    );
  } catch {}
}

async function fetchDynamicIframeSource(
  url: string,
  post: IframePost | undefined,
  srcdoc: string | undefined,
): Promise<DynamicIframeSource> {
  const source: DynamicIframeSource = {
    html: "",
    characterSet: "UTF-8",
    decodedResponse: false,
    finalUrl: url,
    contentType: null,
    bytes: null,
  };
  if (srcdoc !== undefined) {
    source.html = srcdoc;
    source.decodedResponse = true;
    source.contentType = "text/html";
    return source;
  }
  await fetchAndDecodeDynamicIframeSource(url, post, source);
  return source;
}

async function fetchAndDecodeDynamicIframeSource(
  url: string,
  post: IframePost | undefined,
  source: DynamicIframeSource,
): Promise<void> {
  try {
    await loadDynamicIframeBytes(url, post, source);
    if (source.bytes !== null) {
      const decoded = decodeHtmlBytes(source.bytes, source.contentType ?? "");
      source.html = decoded.html;
      source.characterSet = ks_encoding_name(decoded.charset) ?? "UTF-8";
      source.decodedResponse = true;
    }
  } catch (error) {
    warnDynamicIframeFetchError(url, error);
  }
}

function parseDynamicIframeDocument(
  source: DynamicIframeSource,
  DOMParserConstructor: any,
  url: string,
): Record<string, unknown> | null {
  if (!source.decodedResponse) return null;
  const html = source.html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  return parseDynamicIframeHtml(source, html, DOMParserConstructor, url);
}

function parseDynamicIframeHtml(
  source: DynamicIframeSource,
  html: string,
  DOMParserConstructor: any,
  url: string,
): Record<string, unknown> | null {
  try {
    const parser = new DOMParserConstructor();
    const parserMime = pickDomParserMime(source.contentType);
    const parsedDocument: unknown = parser.parseFromString(html, parserMime);
    if (!isObjectRecord(parsedDocument)) return null;
    parsedDocument._mutable = true;
    parsedDocument._characterSet = source.characterSet;
    return parsedDocument;
  } catch (error) {
    try {
      console.warn(
        "[kitesurf-iframe] dynamic iframe parse failed for " + url + ":",
        error instanceof Error ? error.message : String(error),
      );
    } catch {}
    return null;
  }
}

function defineFrameDocumentBaseUrl(document: object, url: string): void {
  try {
    Object.defineProperty(document, "_baseUrl", {
      value: url,
      configurable: true,
      writable: true,
    });
  } catch {}
}

function dynamicIframeDocumentBaseUrl(srcdoc: string | undefined, finalUrl: string): string {
  return srcdoc !== undefined ? state.document?.baseURI || state.pageUrl || finalUrl : finalUrl;
}

function installDynamicIframeDocumentWindow(
  iframeEl: any,
  newDoc: Record<string, unknown>,
  finalUrl: string,
): void {
  const existingWin = iframeEl.__ks_iframeContentWindow;
  if (!existingWin) return;
  existingWin.document = newDoc;
  setIframeFacadeLocation(existingWin, iframeEl, finalUrl);
  try {
    Object.defineProperty(newDoc, "defaultView", {
      value: existingWin,
      configurable: true,
    });
  } catch {}
}

function commitDynamicIframeDocument(
  iframeEl: any,
  newDoc: Record<string, unknown>,
  srcdoc: string | undefined,
  finalUrl: string,
): void {
  defineFrameDocumentBaseUrl(newDoc, dynamicIframeDocumentBaseUrl(srcdoc, finalUrl));
  setFrameReferrer(newDoc, frameNavigationReferrer(finalUrl));
  installDynamicIframeDocumentWindow(iframeEl, newDoc, finalUrl);
  iframeEl.__ks_iframeContentDocument = newDoc;
}

function warnPlaceholderCharacterSet(frameId: unknown, error: unknown): void {
  console.warn("[kitesurf-iframe] failed to set placeholder character set", { frameId, error });
}

function setPlaceholderCharacterSet(
  placeholderDoc: object,
  iframeEl: any,
  characterSet: string,
): void {
  try {
    if (!Reflect.set(placeholderDoc, "_characterSet", characterSet, placeholderDoc)) {
      throw new TypeError("Failed to set iframe placeholder character set");
    }
  } catch (error) {
    warnPlaceholderCharacterSet(iframeEl.__ks_iframeFrameId, error);
  }
}

function setPlaceholderXmlMetadata(placeholderDoc: object, parserMime: string): void {
  if (parserMime === "text/html") return;
  try {
    Reflect.set(placeholderDoc, "_contentType", parserMime, placeholderDoc);
  } catch {}
  try {
    Reflect.set(placeholderDoc, "_isXml", true, placeholderDoc);
  } catch {}
}

function updateIframePlaceholderDocument(
  iframeEl: any,
  characterSet: string,
  contentType: string | null,
  finalUrl: string,
): void {
  const placeholderDoc: unknown = iframeEl.__ks_iframeContentDocument;
  if (isObjectRecord(placeholderDoc)) {
    setPlaceholderCharacterSet(placeholderDoc, iframeEl, characterSet);
    defineFrameDocumentBaseUrl(placeholderDoc, finalUrl);
    setFrameReferrer(placeholderDoc, frameNavigationReferrer(finalUrl));
    setPlaceholderXmlMetadata(placeholderDoc, pickDomParserMime(contentType));
  }
  const existingWin = iframeEl.__ks_iframeContentWindow;
  if (existingWin) setIframeFacadeLocation(existingWin, iframeEl, finalUrl);
}

async function loadDynamicIframe(
  iframeEl: any,
  url: string,
  win: any,
  DOMParserConstructor: any,
  srcdoc?: string,
  post?: IframePost,
): Promise<void> {
  const source = await fetchDynamicIframeSource(url, post, srcdoc);
  const newDoc = parseDynamicIframeDocument(source, DOMParserConstructor, url);
  if (newDoc) {
    commitDynamicIframeDocument(iframeEl, newDoc, srcdoc, source.finalUrl);
  } else {
    updateIframePlaceholderDocument(
      iframeEl,
      source.characterSet,
      source.contentType,
      source.finalUrl,
    );
  }
  const frameId = (iframeEl as any).__ks_iframeFrameId;
  emitFrameLifecycle(frameId, source.finalUrl);
  fireIframeLoad(iframeEl);
}

function emitFrameLifecycle(frameId: unknown, url: string): void {
  if (typeof frameId !== "string") return;
  sendUpstreamEvent({ event: "kitesurf.frameNavigated", params: { frameId, url } });
  sendUpstreamEvent({
    event: "kitesurf.frameLifecycle",
    params: { frameId, name: "DOMContentLoaded" },
  });
  sendUpstreamEvent({ event: "kitesurf.frameLifecycle", params: { frameId, name: "load" } });
  sendUpstreamEvent({ event: "kitesurf.frameStoppedLoading", params: { frameId } });
}

function dispatchWindowUnload(): void {
  if (!state.window) return;
  dispatchLifecycle(state.window, "beforeunload", { bubbles: false, cancelable: true });
  dispatchLifecycle(state.window, "pagehide", { bubbles: false });
  dispatchLifecycle(state.window, "unload", { bubbles: false });
}

function compileEventAttribute(element: any, handlerName: string): void {
  try {
    compileEventAttributeIfNeeded(element, handlerName);
  } catch {}
}

function compileEventAttributeIfNeeded(element: any, handlerName: string): void {
  if (hasEventAttributeHandler(element, handlerName)) return;
  const handlerSource = eventAttributeHandlerSource(element, handlerName);
  if (handlerSource === null) return;
  const eventHandler = compileAttributeHandler(handlerSource);
  if (eventHandler) assignEventAttributeHandler(element, handlerName, eventHandler);
}

function hasEventAttributeHandler(element: any, handlerName: string): boolean {
  return typeof element?.[handlerName] === "function";
}

function eventAttributeHandlerSource(element: any, handlerName: string): string | null {
  const source = element?.getAttribute?.(handlerName);
  if (typeof source !== "string" || source.length === 0) return null;
  return source;
}

function compileAttributeHandler(handlerSource: string): Function | null {
  try {
    return new Function("event", handlerSource);
  } catch {
    return null;
  }
}

function assignEventAttributeHandler(element: any, handlerName: string, handler: Function): void {
  try {
    element[handlerName] = handler;
  } catch {}
}

const DOM_PARSER_MIME_TYPES = new Map([
  ["text/html", "text/html"],
  ["application/xhtml+xml", "application/xhtml+xml"],
  ["image/svg+xml", "image/svg+xml"],
  ["application/xml", "application/xml"],
  ["text/xml", "application/xml"],
]);

function pickDomParserMime(contentType: string | null | undefined): string {
  if (typeof contentType !== "string" || contentType.length === 0) return "text/html";
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  return DOM_PARSER_MIME_TYPES.get(mediaType) ?? "text/html";
}

// Transform-only (ink) damage clips each node's ink rect at the last record and now, so the old
// position is cleared. A node with no recorded rect forces one full frame.
const inkRects = new Map<number, number[]>();
const MAX_TRACKED_INK_RECTS = 64;
const MAX_PARTIAL_DAMAGE_CANDIDATES = 256;
const MAX_PARTIAL_DAMAGE_COVERAGE = 0.6;
const MAX_SCENE_CLIP_DIMENSION_PX = 2_560;

function isScrollFar(
  scrollDeltaX: number,
  scrollDeltaY: number,
  viewportWidth: number,
  viewportHeight: number,
): boolean {
  return Math.abs(scrollDeltaX) >= viewportWidth || Math.abs(scrollDeltaY) >= viewportHeight;
}

function currentPinnedRectState(
  pinnedRects: Map<number, number[]> | undefined,
): { current: Map<number, number[]>; previous: Map<number, number[]> } | null {
  if (!pinnedRects || !pinnedAtRecord || pinnedRects.size !== pinnedAtRecord.size) return null;
  return { current: pinnedRects, previous: pinnedAtRecord };
}

function addVerticalScrollPatch(
  addRect: (x: number, y: number, width: number, height: number, padding: number) => void,
  scrollDeltaY: number,
  viewportWidth: number,
  viewportHeight: number,
): void {
  if (scrollDeltaY === 0) return;
  addRect(
    0,
    scrollDeltaY > 0 ? viewportHeight - scrollDeltaY : 0,
    viewportWidth,
    Math.abs(scrollDeltaY),
    0,
  );
}

function addHorizontalScrollPatch(
  addRect: (x: number, y: number, width: number, height: number, padding: number) => void,
  scrollDeltaX: number,
  viewportWidth: number,
  viewportHeight: number,
): void {
  if (scrollDeltaX === 0) return;
  addRect(
    scrollDeltaX > 0 ? viewportWidth - scrollDeltaX : 0,
    0,
    Math.abs(scrollDeltaX),
    viewportHeight,
    0,
  );
}

function addPinnedScrollPatches(
  pinnedRects: Map<number, number[]>,
  previousPinnedRects: Map<number, number[]>,
  scrollDeltaX: number,
  scrollDeltaY: number,
  addRect: (x: number, y: number, width: number, height: number, padding: number) => void,
): boolean {
  for (const [id, [x, y, width, height]] of pinnedRects) {
    const previousRect = previousPinnedRects.get(id);
    if (!previousRect) return false;
    addRect(x, y, width, height, DAMAGE_INK_PADDING_PX);
    addRect(
      previousRect[0] - scrollDeltaX,
      previousRect[1] - scrollDeltaY,
      previousRect[2],
      previousRect[3],
      DAMAGE_INK_PADDING_PX,
    );
  }
  return true;
}

function readInkRect(paint: DomHandle, id: number): number[] | undefined {
  let rect: Float64Array | undefined;
  try {
    rect = paint.inkRect(id);
  } catch {
    return undefined;
  }
  return rect && rect.length === 4 ? Array.from(rect) : undefined;
}

// Partial clips pad damaged border boxes (or ink rects for transform-only damage) by this much.
// It is a heuristic: a large box-shadow, outline or filter can paint past it and leave stale
// pixels until the next full frame, because blitz exposes no ink-overflow rects.
const DAMAGE_INK_PADDING_PX = 8;
const MAX_PINNED_SCROLL_RECTS = 8;

let pinnedAtRecord: Map<number, number[]> | undefined;

function readPinnedRects(paint: DomHandle): Map<number, number[]> | undefined {
  const PINNED_RECT_VALUES_PER_RECORD = 5;
  let rectData: Float64Array | undefined;
  try {
    rectData = paint.pinnedRects();
  } catch {
    return undefined;
  }
  if (!rectData || rectData.length / PINNED_RECT_VALUES_PER_RECORD > MAX_PINNED_SCROLL_RECTS)
    return undefined;
  const pinnedRects = new Map<number, number[]>();
  for (
    let i = 0;
    i + PINNED_RECT_VALUES_PER_RECORD <= rectData.length;
    i += PINNED_RECT_VALUES_PER_RECORD
  ) {
    pinnedRects.set(rectData[i], [
      rectData[i + 1] - state.scrollX,
      rectData[i + 2] - state.scrollY,
      rectData[i + 3],
      rectData[i + 4],
    ]);
  }
  return pinnedRects;
}

function scrollPatches(
  scrollDeltaX: number,
  scrollDeltaY: number,
  viewportWidth: number,
  viewportHeight: number,
  pinnedRects: Map<number, number[]> | undefined,
): number[][] | string {
  if (isScrollFar(scrollDeltaX, scrollDeltaY, viewportWidth, viewportHeight)) return "scrollFar";
  const pinnedState = currentPinnedRectState(pinnedRects);
  if (!pinnedState) return "scrollPinned";
  const patches: number[][] = [];
  let totalArea = 0;
  const addRect = (
    rectX: number,
    rectY: number,
    rectWidth: number,
    rectHeight: number,
    padding: number,
  ) => {
    const x0 = Math.max(0, Math.floor(rectX - padding));
    const y0 = Math.max(0, Math.floor(rectY - padding));
    const x1 = Math.min(viewportWidth, Math.ceil(rectX + rectWidth + padding));
    const y1 = Math.min(viewportHeight, Math.ceil(rectY + rectHeight + padding));
    if (x1 <= x0 || y1 <= y0) return;
    patches.push([x0, y0, x1 - x0, y1 - y0]);
    totalArea += (x1 - x0) * (y1 - y0);
  };
  addVerticalScrollPatch(addRect, scrollDeltaY, viewportWidth, viewportHeight);
  addHorizontalScrollPatch(addRect, scrollDeltaX, viewportWidth, viewportHeight);
  if (
    !addPinnedScrollPatches(
      pinnedState.current,
      pinnedState.previous,
      scrollDeltaX,
      scrollDeltaY,
      addRect,
    )
  ) {
    return "scrollPinned";
  }
  return totalArea <= MAX_PARTIAL_DAMAGE_COVERAGE * viewportWidth * viewportHeight
    ? patches
    : "cutoff";
}

interface SceneClip {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SceneClipInput {
  x: number;
  y: number;
  width: number;
  height: number;
}

function hasSceneClipNumericFields(
  value: Record<string, unknown>,
): value is Record<string, unknown> & SceneClipInput {
  return (
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    typeof value.width === "number" &&
    typeof value.height === "number"
  );
}

function hasPositiveSceneClipSize(width: number, height: number): boolean {
  return width > 0 && height > 0;
}

function readSceneClip(value: unknown): SceneClipInput | null {
  if (!isObjectRecord(value)) return null;
  if (!hasSceneClipNumericFields(value)) return null;
  if (!hasPositiveSceneClipSize(value.width, value.height)) return null;
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return isUnknownArray(value) && value.every((entry) => typeof entry === "string");
}

function isNumberArray(value: unknown): value is number[] {
  return isUnknownArray(value) && value.every((entry) => typeof entry === "number");
}

interface PartialDamageRead {
  skipReason: string;
  candidates: Set<number> | null;
  inkIds: number[];
}

function partialDamageFailure(skipReason: string): PartialDamageRead {
  return { skipReason, candidates: null, inkIds: [] };
}

function partialDamageSummaryJson(paint: DomHandle): string | null {
  if (typeof paint.takeDamageSummary !== "function") return null;
  try {
    if (typeof paint.resolveLayout === "function") paint.resolveLayout();
  } catch {}
  return paint.takeDamageSummary() || "";
}

function partialDamageLayoutSkipReason(layout: unknown): string | null {
  if (isUnknownArray(layout) && layout.length === 0) return null;
  const names: unknown = layout || [];
  if (!isUnknownArray(names)) return "summaryThrew";
  const MAX_LAYOUT_DAMAGE_NAMES_LOGGED = 6;
  return "layoutDamage:" + names.slice(0, MAX_LAYOUT_DAMAGE_NAMES_LOGGED).join(",");
}

function partialDamageSummarySkipReason(summaryValue: unknown): string | null {
  if (!isObjectRecord(summaryValue)) return "layoutDamage:";
  if (summaryValue.layoutOverflow || summaryValue.paintOverflow) return "overflow";
  return partialDamageLayoutSkipReason(summaryValue.layout);
}

function addPartialDamagePaintIds(candidates: Set<number>, ids: unknown[]): void {
  for (const id of ids) candidates.add(Number(id) | 0);
}

function addPartialDamageEpochIds(candidates: Set<number>, ids: Set<number>): void {
  for (const id of ids) candidates.add(id | 0);
}

function partialDamageInkIds(inkNodes: unknown): number[] {
  if (!isUnknownArray(inkNodes)) return [];
  const inkIds: number[] = [];
  for (const id of inkNodes) inkIds.push(Number(id) | 0);
  return inkIds;
}

function partialDamageCandidates(
  paintNodes: unknown,
  inkNodes: unknown,
  epochDamage: Set<number>,
): PartialDamageRead {
  if (!isUnknownArray(paintNodes)) return { skipReason: "", candidates: null, inkIds: [] };
  const candidates = new Set<number>();
  addPartialDamagePaintIds(candidates, paintNodes);
  addPartialDamageEpochIds(candidates, epochDamage);
  return { skipReason: "", candidates, inkIds: partialDamageInkIds(inkNodes) };
}

function parsedPartialDamageValue(raw: string): unknown {
  if (!raw) return null;
  return JSON.parse(raw);
}

function partialDamageCandidatesFromSummary(
  summaryValue: unknown,
  epochDamage: Set<number>,
): PartialDamageRead {
  if (!isObjectRecord(summaryValue)) return partialDamageFailure("layoutDamage:");
  return partialDamageCandidates(summaryValue.paint, summaryValue.ink, epochDamage);
}

function parsePartialDamageSummary(raw: string, epochDamage: Set<number>): PartialDamageRead {
  try {
    const summaryValue = parsedPartialDamageValue(raw);
    if (!summaryValue) return partialDamageFailure("noSummary");
    const skipReason = partialDamageSummarySkipReason(summaryValue);
    if (skipReason !== null) return partialDamageFailure(skipReason);
    return partialDamageCandidatesFromSummary(summaryValue, epochDamage);
  } catch {
    return partialDamageFailure("summaryThrew");
  }
}

function readPartialDamageSummary(paint: DomHandle, epochDamage: Set<number>): PartialDamageRead {
  try {
    const raw = partialDamageSummaryJson(paint);
    if (raw === null) return partialDamageFailure("noWasmEntry");
    return parsePartialDamageSummary(raw, epochDamage);
  } catch {
    return partialDamageFailure("summaryThrew");
  }
}

interface PartialDamageRectOptions {
  paint: DomHandle;
  candidates: Set<number>;
  inkIds: number[];
  inkNow: Map<number, number[]>;
  viewportWidth: number;
  viewportHeight: number;
  sinceSeq: number | null;
  hasClip: boolean;
}

interface PartialDamageRectResult {
  clip: SceneClip | null;
  offscreen: boolean;
  skipReason: string;
}

// wasm-bindgen exposes this `JsValue` as `any`; validate the Rust `Rect` fields at the boundary.
function isWasmBoundingRect(
  value: unknown,
): value is Record<string, unknown> & { x: number; y: number; width: number; height: number } {
  return (
    isObjectRecord(value) &&
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    typeof value.width === "number" &&
    typeof value.height === "number"
  );
}

function readPartialDamageRect(
  value: unknown,
): { x: number; y: number; width: number; height: number } | null {
  if (!value) return null;
  if (!isObjectRecord(value)) return null;
  const width = Number(value.width);
  const height = Number(value.height);
  if (!hasPositiveSceneClipSize(width, height)) return null;
  return {
    x: partialDamageCoordinate(value.x),
    y: partialDamageCoordinate(value.y),
    width,
    height,
  };
}

function partialDamageCoordinate(value: unknown): number {
  return Number(value) || 0;
}

interface PartialDamageBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface PartialDamageClipGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

function addPartialDamageBoundsRect(
  bounds: PartialDamageBounds,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  if (x < bounds.minX) bounds.minX = x;
  if (y < bounds.minY) bounds.minY = y;
  if (x + width > bounds.maxX) bounds.maxX = x + width;
  if (y + height > bounds.maxY) bounds.maxY = y + height;
}

function partialDamageBounds(): PartialDamageBounds {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function addPartialDamageCandidateRects(
  options: PartialDamageRectOptions,
  bounds: PartialDamageBounds,
): boolean {
  for (const id of options.candidates) {
    let rawRect: unknown;
    try {
      rawRect = options.paint.getBoundingClientRect(id);
    } catch {
      return false;
    }
    const rect = readPartialDamageRect(rawRect);
    if (!rect) return false;
    addPartialDamageBoundsRect(bounds, rect.x, rect.y, rect.width, rect.height);
  }
  return true;
}

function addPartialDamageInkRects(
  options: PartialDamageRectOptions,
  bounds: PartialDamageBounds,
): { ok: boolean; skipReason: string } {
  for (const id of options.inkIds) {
    const result = addPartialDamageInkRect(options, bounds, id);
    if (!result.ok) return result;
  }
  return { ok: true, skipReason: "" };
}

function addPartialDamageInkRect(
  options: PartialDamageRectOptions,
  bounds: PartialDamageBounds,
  id: number,
): { ok: boolean; skipReason: string } {
  const previousInkRect = inkRects.get(id);
  const currentInkRect = readInkRect(options.paint, id);
  if (currentInkRect) options.inkNow.set(id, currentInkRect);
  const skipReason = previousInkRect ? "" : "inkFirst";
  if (!previousInkRect || !currentInkRect) return { ok: false, skipReason };
  addPartialDamageBoundsRect(
    bounds,
    previousInkRect[0],
    previousInkRect[1],
    previousInkRect[2],
    previousInkRect[3],
  );
  addPartialDamageBoundsRect(
    bounds,
    currentInkRect[0],
    currentInkRect[1],
    currentInkRect[2],
    currentInkRect[3],
  );
  return { ok: true, skipReason };
}

function partialDamageClipGeometry(bounds: PartialDamageBounds): PartialDamageClipGeometry | null {
  if (bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) return null;
  const x = Math.max(0, Math.floor(bounds.minX - DAMAGE_INK_PADDING_PX));
  const y = Math.max(0, Math.floor(bounds.minY - DAMAGE_INK_PADDING_PX));
  const width = Math.ceil(bounds.maxX + DAMAGE_INK_PADDING_PX) - x;
  const height = Math.ceil(bounds.maxY + DAMAGE_INK_PADDING_PX) - y;
  return { x, y, width, height };
}

function shouldCheckDamageClipOffscreen(options: PartialDamageRectOptions): boolean {
  return (
    options.sinceSeq !== null &&
    !options.hasClip &&
    options.viewportWidth > 0 &&
    options.viewportHeight > 0
  );
}

function isDamageClipOutsideViewport(
  clip: PartialDamageClipGeometry,
  viewportWidth: number,
  viewportHeight: number,
): boolean {
  return (
    clip.x >= state.scrollX + viewportWidth ||
    clip.y >= state.scrollY + viewportHeight ||
    clip.x + clip.width <= state.scrollX ||
    clip.y + clip.height <= state.scrollY
  );
}

function isPartialDamageClipOffscreen(
  options: PartialDamageRectOptions,
  clip: PartialDamageClipGeometry,
): boolean {
  return (
    shouldCheckDamageClipOffscreen(options) &&
    isDamageClipOutsideViewport(clip, options.viewportWidth, options.viewportHeight)
  );
}

function partialDamageClipCoverage(
  clip: PartialDamageClipGeometry,
  viewportWidth: number,
  viewportHeight: number,
): number {
  return viewportWidth > 0 && viewportHeight > 0
    ? (clip.width * clip.height) / (viewportWidth * viewportHeight)
    : 1;
}

function isPartialDamageClipWithinCoverage(
  clip: PartialDamageClipGeometry,
  coverage: number,
): boolean {
  return clip.width > 0 && clip.height > 0 && coverage <= MAX_PARTIAL_DAMAGE_COVERAGE;
}

function partialDamageRectFailure(skipReason: string): PartialDamageRectResult {
  return { clip: null, offscreen: false, skipReason: skipReason || "rectFail" };
}

function finishPartialDamageClip(
  options: PartialDamageRectOptions,
  clip: PartialDamageClipGeometry,
): PartialDamageRectResult {
  if (isPartialDamageClipOffscreen(options, clip)) {
    return { clip: null, offscreen: true, skipReason: "" };
  }
  const coverage = partialDamageClipCoverage(clip, options.viewportWidth, options.viewportHeight);
  if (isPartialDamageClipWithinCoverage(clip, coverage)) {
    return {
      clip: { x: clip.x, y: clip.y, w: clip.width, h: clip.height },
      offscreen: false,
      skipReason: "",
    };
  }
  return { clip: null, offscreen: false, skipReason: "cutoff" };
}

function partialDamageClip(options: PartialDamageRectOptions): PartialDamageRectResult {
  const bounds = partialDamageBounds();
  if (!addPartialDamageCandidateRects(options, bounds)) return partialDamageRectFailure("");
  const inkResult = addPartialDamageInkRects(options, bounds);
  if (!inkResult.ok) return partialDamageRectFailure(inkResult.skipReason);
  const clip = partialDamageClipGeometry(bounds);
  if (!clip) return partialDamageRectFailure("");
  return finishPartialDamageClip(options, clip);
}

interface PartialSceneOptions {
  paint: DomHandle;
  allowPartial: boolean;
  clientWire: boolean;
  epochLayoutDirty: boolean;
  baseSeq: number;
  epochBase: number;
  scrolled: boolean;
  allowScrollShift: boolean;
  scrollDeltaX: number;
  scrollDeltaY: number;
  sinceSeq: number | null;
  hasClip: boolean;
  epochDamage: Set<number>;
  viewportWidth: number;
  viewportHeight: number;
}

interface PartialScenePlan {
  skipReason: string;
  scrollClips: number[][];
  pinnedNow: Map<number, number[]> | undefined;
  inkIds: number[];
  inkNow: Map<number, number[]>;
  partialClip: SceneClip | null;
  unchangedReason: "noDamage" | "offscreen" | null;
}

function partialScenePolicySkipReason(options: PartialSceneOptions): string {
  if (!options.allowPartial) return "off";
  if (options.clientWire) return "clientWire";
  if (options.epochLayoutDirty) return "opaquePaint";
  return "";
}

function partialSceneSequenceSkipReason(options: PartialSceneOptions): string {
  if (options.baseSeq < 0 || options.baseSeq !== options.epochBase) return "base";
  if (options.scrolled && !options.allowScrollShift) return "scroll";
  return "";
}

function partialSceneViewportSkipReason(): string {
  if (
    state.paintViewportW !== state.lastRecordViewportW ||
    state.paintViewportH !== state.lastRecordViewportH
  ) {
    return "resize";
  }
  return "";
}

function initialPartialSceneSkipReason(options: PartialSceneOptions): string {
  const policySkip = partialScenePolicySkipReason(options);
  if (policySkip) return policySkip;
  const sequenceSkip = partialSceneSequenceSkipReason(options);
  if (sequenceSkip) return sequenceSkip;
  return partialSceneViewportSkipReason();
}

function emptyPartialScenePlan(skipReason: string): PartialScenePlan {
  return {
    skipReason,
    scrollClips: [],
    pinnedNow: undefined,
    inkIds: [],
    inkNow: new Map<number, number[]>(),
    partialClip: null,
    unchangedReason: null,
  };
}

function applyPartialSceneScrollPatches(
  options: PartialSceneOptions,
  plan: PartialScenePlan,
): void {
  plan.pinnedNow = readPinnedRects(options.paint);
  const patchResult = scrollPatches(
    options.scrollDeltaX,
    options.scrollDeltaY,
    options.viewportWidth,
    options.viewportHeight,
    plan.pinnedNow,
  );
  if (typeof patchResult === "string") plan.skipReason = patchResult;
  else plan.scrollClips = patchResult;
}

function hasScrollDamage(candidates: Set<number>, inkIds: number[]): boolean {
  return candidates.size > 0 || inkIds.length > 0;
}

function preparePartialSceneCandidates(
  options: PartialSceneOptions,
  damage: PartialDamageRead,
  plan: PartialScenePlan,
): Set<number> | null {
  const candidates = damage.candidates;
  if (!options.scrolled || !candidates) return candidates;
  if (hasScrollDamage(candidates, plan.inkIds)) plan.skipReason = "scrollDamage";
  else applyPartialSceneScrollPatches(options, plan);
  return null;
}

function isUnchangedPartialScene(
  options: PartialSceneOptions,
  candidates: Set<number> | null,
  inkIds: number[],
): boolean {
  return (
    options.sinceSeq !== null &&
    candidates !== null &&
    candidates.size === 0 &&
    inkIds.length === 0 &&
    !isAnimating()
  );
}

function partialSceneDamageCount(candidates: Set<number> | null, inkIds: number[]): number {
  return candidates ? candidates.size + inkIds.length : 0;
}

function partialSceneCandidateSkipReason(
  candidates: Set<number> | null,
  damageCount: number,
): string {
  if (candidates && damageCount === 0) return "noCandidates";
  if (damageCount > MAX_PARTIAL_DAMAGE_CANDIDATES) return "tooMany";
  return "";
}

function shouldPlanPartialDamageClip(
  candidates: Set<number> | null,
  damageCount: number,
): candidates is Set<number> {
  return candidates !== null && damageCount > 0 && damageCount <= MAX_PARTIAL_DAMAGE_CANDIDATES;
}

function applyPartialDamageClipResult(
  plan: PartialScenePlan,
  rectPlan: PartialDamageRectResult,
): void {
  if (rectPlan.offscreen) plan.unchangedReason = "offscreen";
  else if (rectPlan.clip) plan.partialClip = rectPlan.clip;
  else if (plan.skipReason === "") plan.skipReason = rectPlan.skipReason;
}

function applyPartialDamageClip(
  options: PartialSceneOptions,
  candidates: Set<number> | null,
  plan: PartialScenePlan,
  damageCount: number,
): void {
  if (!shouldPlanPartialDamageClip(candidates, damageCount)) return;
  const rectPlan = partialDamageClip({
    paint: options.paint,
    candidates,
    inkIds: plan.inkIds,
    inkNow: plan.inkNow,
    viewportWidth: options.viewportWidth,
    viewportHeight: options.viewportHeight,
    sinceSeq: options.sinceSeq,
    hasClip: options.hasClip,
  });
  applyPartialDamageClipResult(plan, rectPlan);
}

// A partial composites onto the client's retained frame, so it needs the client's painted base to
// be this epoch's base, with no unshiftable scroll or resize since. The client checks the base too.
function planPartialScene(options: PartialSceneOptions): PartialScenePlan {
  const plan = emptyPartialScenePlan(initialPartialSceneSkipReason(options));
  if (plan.skipReason !== "") return plan;
  const damage = readPartialDamageSummary(options.paint, options.epochDamage);
  plan.skipReason = damage.skipReason;
  plan.inkIds = damage.inkIds;
  if (plan.skipReason !== "") return plan;
  const candidates = preparePartialSceneCandidates(options, damage, plan);
  if (isUnchangedPartialScene(options, candidates, plan.inkIds)) {
    plan.unchangedReason = "noDamage";
    return plan;
  }
  const damageCount = partialSceneDamageCount(candidates, plan.inkIds);
  const candidateSkipReason = partialSceneCandidateSkipReason(candidates, damageCount);
  if (candidateSkipReason !== "") plan.skipReason = candidateSkipReason;
  applyPartialDamageClip(options, candidates, plan, damageCount);
  return plan;
}

interface ScenePatch {
  clip: SceneClip;
  scene: Uint8Array;
}

interface ScrollScenePatches {
  scene: Uint8Array | null;
  partialClip: SceneClip | null;
  patches: ScenePatch[];
}

function renderScrollScenePatches(
  renderClip: DomHandle["renderSceneClip"],
  scrollClips: number[][],
  scrollX: number,
  scrollY: number,
  clientWire: boolean,
): ScrollScenePatches {
  let scene: Uint8Array | null = null;
  let partialClip: SceneClip | null = null;
  const patches: ScenePatch[] = [];
  for (const [x, y, width, height] of scrollClips) {
    const clip = { x: x + scrollX, y: y + scrollY, w: width, h: height };
    const patchScene = renderClip(clip.x, clip.y, width, height, false, clientWire);
    if (!patchScene || patchScene.length === 0) {
      throw new Error("renderSceneClip returned empty");
    }
    if (!scene) {
      scene = patchScene;
      partialClip = clip;
    } else {
      patches.push({ clip, scene: patchScene });
    }
  }
  return { scene, partialClip, patches };
}

let awaitingIframeInstalls = false;
const IFRAME_INSTALL_WAIT_MS = 5_000;

const TLA_SETTLE_BUDGET_MS = 1_500;

function createIframeLoadEvent(): Event | null {
  const EventConstructor = ksEventCtors.Event || ksGlobal.CsEvent;
  if (!EventConstructor) return null;
  return new EventConstructor("load", { bubbles: false, cancelable: false });
}

function fireIframeLoad(iframeElement: any) {
  try {
    const event = createIframeLoadEvent();
    if (!event) return;
    compileEventAttribute(iframeElement, "onload");
    try {
      iframeElement.dispatchEvent?.(event);
    } catch {}
  } catch {}
}

installResourceFetchBridge();
ksGlobal.__ks_fontsReady = async () => {
  if (fontDeferActive()) {
    await awaitDeferredFonts();
    kickLayoutForFontFaceDiscovery();
  }
  return fontsIdle();
};
ksGlobal.__ks_fontsInflightCount = fontsInflightCount;
ksGlobal.__ks_fontDemand = demandDeferredFonts;
installFetchShim();
installConsoleWrapper();
// Install deferral after the fetch shim so retries still use the page's outbound path.
installDeferShim();
captureTrustedFetch();

let __ksSpanBuf: string[] = [];
let __ksSpanFlushScheduled = false;
let __ksSpanHookArmed = false;
let __ksSpanTotal = 0;
let __ksSpanCapped = false;
const __KS_SPAN_FLUSH_HIGH_WATER = 512;
const __KS_SPAN_BUDGET = 5000;

const EMPTY_KEYS = new Uint8Array(0);

function resourceHashes(value: unknown): Uint8Array {
  if (value === undefined || value === null) return EMPTY_KEYS;
  if (value instanceof Uint8Array) return value;
  throw new TypeError("Resource hashes must be a Uint8Array");
}

function spanSinkFromWorker(self: any): any {
  return self?.env?.KS_SPAN_SINK;
}

function disarmSpanSink(): void {
  if (!__ksSpanHookArmed) return;
  try {
    ks_set_emit_hook(null);
  } catch {}
  __ksSpanHookArmed = false;
}

function flushSpanBatch(self: any, sink: any): void {
  __ksSpanFlushScheduled = false;
  if (__ksSpanBuf.length === 0) return;
  const batch = __ksSpanBuf;
  __ksSpanBuf = [];
  const flushPromise = Promise.resolve()
    .then(() => sink.emit(batch))
    .catch(() => {});
  try {
    self.ctx.waitUntil(flushPromise);
  } catch {}
}

function scheduleSpanFlush(self: any, sink: any): void {
  const flush = (): void => flushSpanBatch(self, sink);
  if (__ksSpanBuf.length >= __KS_SPAN_FLUSH_HIGH_WATER) {
    flush();
    return;
  }
  if (__ksSpanFlushScheduled) return;
  __ksSpanFlushScheduled = true;
  try {
    nativeSetTimeout(flush, 0);
  } catch {
    queueMicrotask(flush);
  }
}

function recordSpanForSink(self: any, sink: any, record: string): void {
  if (__ksSpanTotal >= __KS_SPAN_BUDGET) {
    if (!__ksSpanCapped) {
      __ksSpanCapped = true;
      __ksSpanBuf.push(
        `{"name":"child.spans.capped","attributes":[{"key":"budget","value":{"intValue":"${__KS_SPAN_BUDGET}"}}]}`,
      );
      scheduleSpanFlush(self, sink);
    }
    return;
  }
  __ksSpanTotal++;
  __ksSpanBuf.push(record);
  scheduleSpanFlush(self, sink);
}

function armSpanSink(self: any, traced: boolean): void {
  const sink = spanSinkFromWorker(self);
  if (!traced || !sink) {
    disarmSpanSink();
    return;
  }
  __ksSpanTotal = 0;
  __ksSpanCapped = false;
  if (__ksSpanHookArmed) return;
  __ksSpanHookArmed = true;
  try {
    ks_set_emit_hook((record: string) => recordSpanForSink(self, sink, record));
  } catch {
    __ksSpanHookArmed = false;
  }
}

const MAX_ANCESTOR_STYLE_HOPS = 128;

interface MouseTarget extends ShimElement {
  parentNode?: MouseTarget | null;
  childNodes?: ArrayLike<MouseTarget>;
  disabled?: boolean;
  pseudo?: (name: string) => unknown;
  setAttribute?: (name: string, value: string) => void;
  removeAttribute?: (name: string) => void;
  form?: NonNullable<ShimElement["form"]> & { reset?: () => void };
}

type PseudoMouseTarget = MouseTarget & Required<Pick<MouseTarget, "pseudo">>;

type AttributeTarget = MouseTarget &
  Required<Pick<MouseTarget, "hasAttribute" | "setAttribute" | "removeAttribute">>;
function hasAttributeMethods(node: MouseTarget): node is AttributeTarget {
  return (
    typeof node.hasAttribute === "function" &&
    typeof node.setAttribute === "function" &&
    typeof node.removeAttribute === "function"
  );
}

type TextControl = ShimElement & Required<Pick<ShimElement, "setSelectionRange">>;
function isTextControl(node: ShimElement | null): node is TextControl {
  if (!node) return false;
  const tag = (node.tagName || "").toUpperCase();
  return (tag === "INPUT" || tag === "TEXTAREA") && typeof node.setSelectionRange === "function";
}

function resolveMouseTargetLayout(paint: DomHandle): void {
  try {
    if (typeof paint.resolveLayout === "function") paint.resolveLayout();
  } catch {}
}

function forceMouseTargetRestyle(paint: DomHandle, sequence: number): void {
  if (sequence > state.lastForceRestyleSeq) {
    try {
      if (typeof paint.forceFullRestyle === "function") paint.forceFullRestyle();
    } catch {}
    state.lastForceRestyleSeq = sequence;
  }
}

function mouseHitAtPoint(paint: DomHandle, clientX: number, clientY: number): unknown {
  try {
    return paint.elementFromPoint(clientX + state.scrollX, clientY + state.scrollY);
  } catch {
    invalidatePaintDom();
    return -1;
  }
}

function resolveMouseTargetHit(paintHitId: unknown): MouseTarget | null {
  if (typeof paintHitId === "number" && paintHitId >= 0) {
    return state.resolveNodeId(paintHitId);
  }
  return null;
}

function shouldSetMousePseudoTarget(
  eventType: string,
  paint: DomHandle,
  targetEl: MouseTarget | null,
): targetEl is PseudoMouseTarget {
  return Boolean(
    targetEl &&
    eventType !== "mousemove" &&
    eventType !== "wheel" &&
    typeof paint.pseudoKindAtPoint === "function" &&
    typeof targetEl.pseudo === "function",
  );
}

function pseudoNameForKind(kind: unknown): string | null {
  if (kind === 1) return "::before";
  if (kind === 2) return "::after";
  return null;
}

function setMousePseudoTarget(
  eventType: string,
  clientX: number,
  clientY: number,
  event: MouseInputEvent,
  paint: DomHandle,
  targetEl: MouseTarget | null,
): void {
  if (!shouldSetMousePseudoTarget(eventType, paint, targetEl)) return;
  try {
    const kind = paint.pseudoKindAtPoint(clientX + state.scrollX, clientY + state.scrollY);
    const pseudoName = pseudoNameForKind(kind);
    if (pseudoName !== null) event.pseudoTarget = targetEl.pseudo(pseudoName);
  } catch {}
}

type PageSelection = NonNullable<ReturnType<NonNullable<ShimDocument["getSelection"]>>>;

type MouseInputEvent = NonNullable<Parameters<BuildDocumentResult["__ks_activateLabel"]>[1]> &
  Partial<InstanceType<BuildDocumentResult["WheelEvent"]>>;

function mouseTargetAtPoint(
  eventType: string,
  clientX: number,
  clientY: number,
  event: MouseInputEvent,
): MouseTarget | null {
  let targetEl: MouseTarget | null = null;
  try {
    const paint = ensurePaintDom();
    if (!paint) return null;
    const seqNow = cascadeSeq();
    resolveMouseTargetLayout(paint);
    forceMouseTargetRestyle(paint, seqNow);
    targetEl = resolveMouseTargetHit(mouseHitAtPoint(paint, clientX, clientY));
    setMousePseudoTarget(eventType, clientX, clientY, event, paint, targetEl);
  } catch {
    targetEl = null;
  }
  return targetEl;
}

function readCaretPosition(value: unknown): { nodeId: number; offset: number } | null {
  if (!Array.isArray(value)) return null;
  const nodeId: unknown = value[0];
  const offset: unknown = value[1];
  return typeof nodeId === "number" && typeof offset === "number" ? { nodeId, offset } : null;
}

function safeCaretOffset(offset: number, valueLength: number): number {
  return Math.max(0, Math.min(Number(offset) || 0, valueLength));
}

function textControlSelectionBounds(
  caretNode: TextControl,
  safeOffset: number,
): { start: number; end: number } {
  const start =
    typeof caretNode.selectionStart === "number" ? caretNode.selectionStart : safeOffset;
  const end = typeof caretNode.selectionEnd === "number" ? caretNode.selectionEnd : start;
  return { start, end };
}

function updateTextControlMouseMove(caretNode: TextControl, safeOffset: number): void {
  const anchor = __ksControlCaretAnchor;
  if (anchor?.el !== caretNode) return;
  const direction = safeOffset < anchor.offset ? "backward" : "forward";
  caretNode.setSelectionRange(
    Math.min(anchor.offset, safeOffset),
    Math.max(anchor.offset, safeOffset),
    direction,
  );
}

function setCollapsedTextControlSelection(caretNode: TextControl, safeOffset: number): void {
  if (typeof caretNode.__ksCollapseSelectionTo === "function") {
    caretNode.__ksCollapseSelectionTo(safeOffset);
  } else {
    caretNode.setSelectionRange(safeOffset, safeOffset);
  }
  __ksControlCaretAnchor = { el: caretNode, offset: safeOffset };
}

function setTextControlSelection(
  caretNode: TextControl,
  safeOffset: number,
  shiftKey: boolean,
  start: number,
  end: number,
): void {
  if (shiftKey) {
    const anchor = caretNode.selectionDirection === "backward" ? end : start;
    caretNode.setSelectionRange(
      Math.min(anchor, safeOffset),
      Math.max(anchor, safeOffset),
      safeOffset < anchor ? "backward" : "forward",
    );
    __ksControlCaretAnchor = { el: caretNode, offset: anchor };
    return;
  }
  setCollapsedTextControlSelection(caretNode, safeOffset);
}

function updateTextControlCaret(
  caretNode: TextControl,
  offset: number,
  eventType: string,
  event: MouseInputEvent,
  clientX: number,
  clientY: number,
): void {
  const valueLength = String(caretNode.value || "").length;
  const safeOffset = safeCaretOffset(offset, valueLength);
  const { start, end } = textControlSelectionBounds(caretNode, safeOffset);
  if (eventType === "mousemove") {
    updateTextControlMouseMove(caretNode, safeOffset);
    return;
  }
  setTextControlSelection(caretNode, safeOffset, event.shiftKey, start, end);
  if (event.button === 0) {
    __ksCaretDragActive = true;
    __ksCaretDragOrigin = { x: clientX, y: clientY };
  }
}

function documentSelection(): PageSelection | null {
  const documentNode = state.document;
  return documentNode && typeof documentNode.getSelection === "function"
    ? documentNode.getSelection()
    : null;
}

function extendDocumentSelection(
  selection: PageSelection,
  caretNode: ShimElement,
  offset: number,
): void {
  if (selection.rangeCount > 0) selection.extend(caretNode, offset);
  else selection.collapse(caretNode, offset);
}

function updateDocumentSelectionMouseMove(
  selection: PageSelection,
  caretNode: ShimElement,
  offset: number,
): void {
  if (selection.rangeCount > 0) selection.extend(caretNode, offset);
}

function shouldExtendDocumentSelection(
  event: MouseInputEvent,
  targetEl: MouseTarget | null,
): boolean {
  return event.shiftKey && !findAnchorAncestor(targetEl);
}

function beginDocumentSelectionDrag(
  event: MouseInputEvent,
  clientX: number,
  clientY: number,
): void {
  if (event.button === 0 && !event.shiftKey) {
    __ksCaretDragActive = true;
    __ksCaretDragOrigin = { x: clientX, y: clientY };
  }
}

function updateDocumentCaretSelection(
  caretNode: ShimElement | null,
  offset: number,
  eventType: string,
  event: MouseInputEvent,
  targetEl: MouseTarget | null,
  clientX: number,
  clientY: number,
): void {
  const selection = documentSelection();
  if (!caretNode || !selection) return;
  if (eventType === "mousemove") {
    updateDocumentSelectionMouseMove(selection, caretNode, offset);
    return;
  }
  if (shouldExtendDocumentSelection(event, targetEl)) {
    extendDocumentSelection(selection, caretNode, offset);
    return;
  }
  selection.collapse(caretNode, offset);
  beginDocumentSelectionDrag(event, clientX, clientY);
}

function updateCaretSelection(
  caretNode: ShimElement | null,
  offset: number,
  eventType: string,
  event: MouseInputEvent,
  targetEl: MouseTarget | null,
  clientX: number,
  clientY: number,
): void {
  if (isTextControl(caretNode)) {
    updateTextControlCaret(caretNode, offset, eventType, event, clientX, clientY);
    return;
  }
  updateDocumentCaretSelection(caretNode, offset, eventType, event, targetEl, clientX, clientY);
}

function updateCaretFromMouse(
  eventType: string,
  event: MouseInputEvent,
  targetEl: MouseTarget | null,
  clientX: number,
  clientY: number,
): void {
  try {
    const paint = ensurePaintDom();
    if (!paint || typeof paint.caretFromPoint !== "function") return;
    // wasm-bindgen types this result as `any`; Rust returns null or [node id, offset].
    const caretPosition = readCaretPosition(
      paint.caretFromPoint(
        caretX(clientX, clientY, eventType) + state.scrollX,
        clientY + state.scrollY,
      ),
    );
    if (!caretPosition) return;
    updateCaretSelection(
      state.resolveNodeId(caretPosition.nodeId),
      caretPosition.offset,
      eventType,
      event,
      targetEl,
      clientX,
      clientY,
    );
  } catch {}
}

function documentCharacterSet(label: unknown): string {
  if (typeof label !== "string" || label.length === 0) return "UTF-8";
  try {
    return ks_encoding_name(label) ?? "UTF-8";
  } catch {
    return "UTF-8";
  }
}

async function pumpPageTasksAsDriver(frameIntervalMs: unknown) {
  if (typeof frameIntervalMs !== "number") return pumpDuePageTasks();
  beginRafDriverTurn(frameIntervalMs);
  try {
    return await pumpDuePageTasks();
  } finally {
    endRafDriverTurn();
  }
}

const BUTTON_ACTIVATION_TAGS = new Set(["BUTTON", "INPUT", "A", "SUMMARY", "LABEL"]);

function isButtonActivationAncestor(element: MouseTarget): boolean {
  return BUTTON_ACTIVATION_TAGS.has((element.tagName || "").toUpperCase());
}

function shouldFindButtonActivationParent(
  element: MouseTarget | null | undefined,
): element is MouseTarget {
  return Boolean(element && element !== state.document && !isButtonActivationAncestor(element));
}

function findButtonActivationTarget(targetEl: MouseTarget): MouseTarget {
  let activator: MouseTarget | null | undefined = targetEl;
  while (shouldFindButtonActivationParent(activator)) activator = activator.parentNode;
  if (!activator || activator === state.document) return targetEl;
  return activator;
}

function isButtonSubmitType(tagName: string, typeAttr: string): boolean {
  return tagName === "BUTTON" && (typeAttr === "" || typeAttr === "submit");
}

function isInputSubmitType(tagName: string, typeAttr: string): boolean {
  return tagName === "INPUT" && (typeAttr === "submit" || typeAttr === "image");
}

function isButtonActivationSubmit(tagName: string, typeAttr: string): boolean {
  return isButtonSubmitType(tagName, typeAttr) || isInputSubmitType(tagName, typeAttr);
}

function isButtonActivationReset(tagName: string, typeAttr: string): boolean {
  return (tagName === "BUTTON" || tagName === "INPUT") && typeAttr === "reset";
}

function buttonActivationAction(element: MouseTarget): "submit" | "reset" | null {
  const tagName = (element.tagName || "").toUpperCase();
  const typeAttr = mouseTargetTypeAttribute(element);
  if (isButtonActivationSubmit(tagName, typeAttr)) return "submit";
  if (isButtonActivationReset(tagName, typeAttr)) return "reset";
  return null;
}

function mouseTargetTypeAttribute(element: MouseTarget): string {
  return ((element.getAttribute && element.getAttribute("type")) || "").toLowerCase();
}

function submitFromButtonActivation(
  form: NonNullable<MouseTarget["form"]>,
  activator: MouseTarget,
): string | null {
  if (typeof form.__ksRequestSubmit !== "function") return null;
  const navUrl = form.__ksRequestSubmit(activator);
  return typeof navUrl === "string" && navUrl.length > 0 ? navUrl : null;
}

function resetButtonActivationForm(form: NonNullable<MouseTarget["form"]>): void {
  if (typeof form.reset === "function") form.reset();
}

function buttonActivationNavigation(targetEl: MouseTarget): string | null {
  const activator = findButtonActivationTarget(targetEl);
  const action = buttonActivationAction(activator);
  if (!action || activator.disabled) return null;
  const form = activator.form;
  if (!form) return null;
  if (action === "submit") return submitFromButtonActivation(form, activator);
  resetButtonActivationForm(form);
  return null;
}

function isSummaryElement(element: MouseTarget | null | undefined): element is MouseTarget {
  return Boolean(element && (element.tagName || "").toUpperCase() === "SUMMARY");
}

function shouldFindSummaryParent(element: MouseTarget | null | undefined): element is MouseTarget {
  return Boolean(element && element !== state.document && !isSummaryElement(element));
}

function findSummaryAncestor(targetEl: MouseTarget): MouseTarget | null {
  let summary: MouseTarget | null | undefined = targetEl;
  while (shouldFindSummaryParent(summary)) summary = summary.parentNode;
  if (isSummaryElement(summary)) return summary;
  return null;
}

function isDetailsSummaryParent(
  details: MouseTarget | null | undefined,
): details is AttributeTarget {
  return Boolean(
    details && (details.tagName || "").toUpperCase() === "DETAILS" && hasAttributeMethods(details),
  );
}

function firstSummaryChild(details: MouseTarget): MouseTarget | null {
  const kids = details.childNodes || [];
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i];
    if (isSummaryElement(child)) return child;
  }
  return null;
}

function toggleDetailsOpen(details: AttributeTarget): void {
  if (details.hasAttribute("open")) details.removeAttribute("open");
  else details.setAttribute("open", "");
}

function dispatchDetailsToggle(details: MouseTarget): void {
  try {
    __ks_dispatchTrusted(
      details,
      new ksEventCtors.Event("toggle", { bubbles: false, cancelable: false }),
    );
  } catch {}
}

function toggleDetailsFromSummary(targetEl: MouseTarget): void {
  const summary = findSummaryAncestor(targetEl);
  if (!summary) return;
  const details = summary.parentNode;
  if (!isDetailsSummaryParent(details)) return;
  if (firstSummaryChild(details) !== summary) return;
  toggleDetailsOpen(details);
  dispatchDetailsToggle(details);
}

type AnchorNavigation = { kind: "hash" | "navigate"; url: string };

function anchorForActivation(
  targetEl: MouseTarget,
  clientX: number,
  clientY: number,
): MouseTarget | null {
  return findAnchorAncestor(targetEl) || findAnchorViaSingleChild(targetEl, clientX, clientY);
}

function isNonEmptyHref(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSameDocumentHashNavigation(resolved: string): boolean {
  return resolved.includes("#") && resolved.split("#")[0] === state.pageUrl.split("#")[0];
}

function queueHashChangeEvent(
  win: NonNullable<typeof state.window>,
  previous: string,
  resolved: string,
): void {
  queuePageTask(() => {
    try {
      const event: unknown = new ksEventCtors.HashChangeEvent("hashchange", {
        bubbles: false,
        cancelable: false,
        oldURL: previous,
        newURL: resolved,
      });
      __ks_dispatchTrusted(win, event);
    } catch {}
  });
}

function queuePopStateEvent(
  win: NonNullable<typeof state.window>,
  stateForPopstate: unknown,
): void {
  queuePageTask(() => {
    try {
      const event: unknown = new ksEventCtors.PopStateEvent("popstate", {
        bubbles: false,
        cancelable: false,
        state: stateForPopstate,
      });
      __ks_dispatchTrusted(win, event);
    } catch {}
  });
}

function completeHashAnchorNavigation(resolved: string): AnchorNavigation {
  const previous = state.pageUrl;
  state.pageUrl = resolved;
  const win = state.window;
  if (win) {
    const stateForPopstate = win.history?.state ?? null;
    queueHashChangeEvent(win, previous, resolved);
    queuePopStateEvent(win, stateForPopstate);
  }
  scrollToFragment(resolved);
  return { kind: "hash", url: resolved };
}

function resolveAnchorNavigation(anchor: MouseTarget, rawHref: string): AnchorNavigation | null {
  try {
    const resolved = parseUrlForNode(
      anchor,
      rawHref,
      state.pageUrl || "https://kitesurf.local/",
    ).toString();
    if (!isSameDocumentHashNavigation(resolved)) return { kind: "navigate", url: resolved };
    return completeHashAnchorNavigation(resolved);
  } catch {
    return null;
  }
}

function activateAnchorNavigation(
  targetEl: MouseTarget,
  clientX: number,
  clientY: number,
): AnchorNavigation | null {
  const anchor = anchorForActivation(targetEl, clientX, clientY);
  if (!anchor) return null;
  const rawHref = anchorHrefAttribute(anchor);
  if (!isNonEmptyHref(rawHref)) return null;
  return resolveAnchorNavigation(anchor, rawHref);
}

function notifyControlValueMutation(
  control: ShimElement,
  cursor: number,
  keyboardEventConstructor: BuildDocumentResult["Event"] | BuildDocumentResult["KeyboardEvent"],
): void {
  markControlUserEdited(control);
  collapseControlSelection(control, cursor);
  dispatchControlInputEvent(control, keyboardEventConstructor);
}

function markControlUserEdited(control: ShimElement): void {
  try {
    if (typeof control.__ksMarkUserEdited === "function") control.__ksMarkUserEdited();
  } catch {}
}

function collapseControlSelection(control: ShimElement, cursor: number): void {
  try {
    if (typeof control.__ksCollapseSelectionTo === "function") {
      control.__ksCollapseSelectionTo(cursor);
    } else if (typeof control.setSelectionRange === "function") {
      control.setSelectionRange(cursor, cursor);
    }
  } catch {}
}

function dispatchControlInputEvent(
  control: ShimElement,
  keyboardEventConstructor: BuildDocumentResult["Event"] | BuildDocumentResult["KeyboardEvent"],
): void {
  try {
    const inputEvent = new (ksEventCtors.Event || keyboardEventConstructor)("input", {
      bubbles: true,
      cancelable: false,
    });
    __ks_dispatchTrusted(control, inputEvent);
  } catch {}
}

function formSubmitControlType(element: ShimElement): string {
  return ((element.getAttribute && element.getAttribute("type")) || "").toLowerCase();
}

function isDefaultSubmitButton(element: ShimElement): boolean {
  const type = formSubmitControlType(element);
  return isButtonDefaultSubmit(element, type) || isInputDefaultSubmit(element, type);
}

function isButtonDefaultSubmit(element: ShimElement, type: string): boolean {
  return element.tagName === "BUTTON" && (type === "" || type === "submit");
}

function isInputDefaultSubmit(element: ShimElement, type: string): boolean {
  return element.tagName === "INPUT" && (type === "submit" || type === "image");
}

function findDefaultSubmitButton(form: NonNullable<ShimElement["form"]>): ShimElement | null {
  const elements = form.elements;
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    if (isDefaultSubmitButton(element)) return element;
  }
  return null;
}

const IMPLICIT_SUBMIT_EXCLUDED_TYPES = new Set([
  "button",
  "submit",
  "reset",
  "checkbox",
  "radio",
  "file",
  "image",
]);

function shouldSkipImplicitSubmit(focused: ShimElement): boolean {
  const typeAttr = formSubmitControlType(focused);
  return IMPLICIT_SUBMIT_EXCLUDED_TYPES.has(typeAttr);
}

function requestImplicitFormSubmit(form: ShimElement["form"]): string | null {
  if (!form || typeof form.__ksRequestSubmit !== "function") return null;
  const navUrl = form.__ksRequestSubmit(findDefaultSubmitButton(form));
  return isNonEmptyHref(navUrl) ? navUrl : null;
}

function submitFormOnEnter(focused: ShimElement): string | null {
  try {
    if (shouldSkipImplicitSubmit(focused)) return null;
    return requestImplicitFormSubmit(focused.form);
  } catch (err) {
    console.error("[kitesurf] implicit submit failed", err);
    return null;
  }
}

function dispatchEnterChange(
  focused: ShimElement,
  keyboardEventConstructor: BuildDocumentResult["Event"] | BuildDocumentResult["KeyboardEvent"],
): void {
  try {
    const changeEvent = new (ksEventCtors.Event || keyboardEventConstructor)("change", {
      bubbles: true,
      cancelable: false,
    });
    __ks_dispatchTrusted(focused, changeEvent);
  } catch {}
}

function readFormControlAttribute(element: ShimElement, name: string): unknown {
  const getAttribute: unknown = Reflect.get(element, "getAttribute");
  if (typeof getAttribute !== "function") {
    throw new TypeError("element.getAttribute is not a function");
  }
  return Reflect.apply(getAttribute, element, [name]);
}

function resolveFormControlNode(id: number): ShimElement | null {
  try {
    return state.resolveNodeId ? state.resolveNodeId(id) : null;
  } catch {
    return null;
  }
}

const CHECKED_INPUT_TYPES = new Set(["checkbox", "radio"]);

function isCheckedInputType(type: string): boolean {
  return CHECKED_INPUT_TYPES.has(type);
}

function collectCheckedInputState(
  id: number,
  element: ShimElement,
  tagName: string,
  checked: Array<[number, boolean]>,
): boolean | null {
  if (tagName !== "input") return null;
  const inputType = String(readFormControlAttribute(element, "type") || "text").toLowerCase();
  if (!isCheckedInputType(inputType)) return null;
  try {
    checked.push([id, !!Reflect.get(element, "checked")]);
    return true;
  } catch {
    return false;
  }
}

function isFormSelectOption(value: unknown): value is Record<string, unknown> & { _id: number } {
  return isObjectRecord(value) && typeof value._id === "number";
}

function collectSelectOptionsState(
  id: number,
  element: ShimElement,
  selected: Array<[number, boolean]>,
): boolean {
  try {
    const options: unknown = Reflect.get(element, "options");
    if (!isObjectRecord(options)) throw new TypeError("Select options are unavailable");
    const length: unknown = Reflect.get(options, "length");
    for (let index = 0; index < Number(length); index++) {
      const option: unknown = Reflect.get(options, String(index));
      if (!isFormSelectOption(option)) continue;
      selected.push([option._id, !!option.selected]);
    }
    return true;
  } catch {
    return false;
  }
}

function collectOtherFormControlState(
  id: number,
  element: ShimElement,
  tagName: string,
  values: Array<[number, string]>,
  selected: Array<[number, boolean]>,
): boolean {
  let complete = tagName === "select" ? collectSelectOptionsState(id, element, selected) : true;
  try {
    values.push([id, String(Reflect.get(element, "value") ?? "")]);
  } catch {
    complete = false;
  }
  return complete;
}

function collectFormControlState(
  id: number,
  values: Array<[number, string]>,
  checked: Array<[number, boolean]>,
  selected: Array<[number, boolean]>,
): boolean {
  const element = resolveFormControlNode(id);
  if (!element) return false;
  const tagName = String(Reflect.get(element, "localName") || "").toLowerCase();
  const checkedInput = collectCheckedInputState(id, element, tagName, checked);
  if (checkedInput !== null) return checkedInput;
  return collectOtherFormControlState(id, element, tagName, values, selected);
}

function linkAttributeString(value: unknown): string {
  return String(value ?? "");
}

function stylesheetLinkAttributes(attributes: unknown[]): { rel: string; href: string } {
  let rel = "";
  let href = "";
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    const name = linkAttributeString(attributes[index]).toLowerCase();
    const value = linkAttributeString(attributes[index + 1]);
    if (name === "rel") rel = value;
    else if (name === "href") href = value;
  }
  return { rel, href };
}

function isStylesheetRelation(rel: string): boolean {
  const tokens = new Set(rel.split(/\s+/).map((token) => token.toLowerCase()));
  return tokens.has("stylesheet") && !tokens.has("alternate");
}

function stylesheetHref(attributes: unknown[]): string | null {
  const link = stylesheetLinkAttributes(attributes);
  if (!isStylesheetRelation(link.rel)) return null;
  if (!link.href) return null;
  return link.href;
}

function attributesFromNodeInfo(info: unknown): unknown[] | undefined {
  if (!isObjectRecord(info)) return undefined;
  return isUnknownArray(info.attributes) ? info.attributes : undefined;
}

function drainPageCustomElementUpgrades(upgrades: (() => void) | undefined): void {
  if (typeof upgrades !== "function") return;
  try {
    upgrades();
  } catch (error) {
    console.warn("[kitesurf] custom-element drain threw", error);
  }
}

type PaintSequence = number | (() => number);

function readPaintSequence(sequence: PaintSequence): number {
  return typeof sequence === "function" ? sequence() : sequence;
}

function resolveCachedPaintLayout(paint: DomHandle): void {
  try {
    if (typeof paint.resolveLayout === "function") paint.resolveLayout();
  } catch {}
}

function shouldRestyleCachedPaint(sequence: PaintSequence): boolean {
  return readPaintSequence(sequence) > state.lastForceRestyleSeq;
}

function forceCachedPaintRestyle(paint: DomHandle): void {
  try {
    if (typeof paint.forceFullRestyle === "function") paint.forceFullRestyle();
  } catch {}
}

function prepareCachedPaint(
  paint: DomHandle,
  fresh: boolean,
  sequence: PaintSequence,
  sequenceAfterRestyle: PaintSequence = sequence,
): void {
  if (fresh) return;
  resolveCachedPaintLayout(paint);
  if (!shouldRestyleCachedPaint(sequence)) return;
  forceCachedPaintRestyle(paint);
  state.lastForceRestyleSeq = readPaintSequence(sequenceAfterRestyle);
}

function recordClassicModuleImport(bundleExec: string[], mod: any): void {
  bundleExec.push(
    "classic:imported(keys=" +
      JSON.stringify(Object.keys(mod || {})) +
      ",defaultKeys=" +
      JSON.stringify(Object.keys((mod && mod.default) || {})) +
      ")",
  );
}

function classicBucketRunner(mod: any): Function | null {
  const run = (mod && mod.default && mod.default.run) || mod.run;
  return typeof run === "function" ? run : null;
}

function recordClassicMissingRunner(bundleExec: string[], mod: any): void {
  bundleExec.push("classic:no-run-export");
  console.error("[kitesurf] classic regular bucket: no run() export", Object.keys(mod || {}));
}

function recordClassicRunnerSource(bundleExec: string[], run: Function): void {
  if (!startupCdpDebug) return;
  const CLASSIC_RUN_SOURCE_PREVIEW_CHARS = 80;
  bundleExec.push(
    "classic:run-fn(toString=" +
      JSON.stringify(String(run).slice(0, CLASSIC_RUN_SOURCE_PREVIEW_CHARS).replace(/\n/g, "\\n")) +
      ")",
  );
}

function recordClassicRunSuccess(
  bundleExec: string[],
  scriptStartedAt: number,
  nowMs: () => number,
): void {
  const elapsed = Math.round(nowMs() - scriptStartedAt);
  if (!startupCdpDebug) {
    bundleExec.push("classic:run-ok(ms=" + elapsed + ")");
    return;
  }
  const diag: Partial<BundleDiag> = getInternalState().bundleDiag || {};
  bundleExec.push(
    "classic:run-ok(ms=" +
      elapsed +
      ",entered=" +
      !!diag.entered +
      ",exited=" +
      !!diag.exited +
      ",bodyChars=" +
      diag.bodyChars +
      ")",
  );
  try {
    bundleExec.push("classic:entryDom(" + JSON.stringify(diag.entryDom) + ")");
    bundleExec.push("classic:exitDom(" + JSON.stringify(diag.exitDom) + ")");
  } catch (error) {
    bundleExec.push("classic:dom-snap-err(" + String(error) + ")");
  }
}

function reportClassicBucketError(bundleExec: string[], error: unknown): void {
  const CLASSIC_BUCKET_ERROR_DETAIL_CHARS = 200;
  const detail = classicBucketErrorDetail(error);
  bundleExec.push("classic:threw(" + detail.slice(0, CLASSIC_BUCKET_ERROR_DETAIL_CHARS) + ")");
  pushException(error, {
    scriptId: "bundle:classic-regular",
    url: "/__ks_user_classic_regular.js",
    text: "Uncaught",
  });
  console.error("[kitesurf] classic regular bucket threw: " + detail);
}

async function runClassicRegularBucket(
  bundleExec: string[],
  scriptStartedAt: number,
  nowMs: () => number,
) {
  try {
    const mod = await import("./__ks_user_classic_regular.js");
    recordClassicModuleImport(bundleExec, mod);
    const run = classicBucketRunner(mod);
    if (!run) {
      recordClassicMissingRunner(bundleExec, mod);
      return;
    }
    recordClassicRunnerSource(bundleExec, run);
    bundleExec.push("classic:run-call");
    await run();
    recordClassicRunSuccess(bundleExec, scriptStartedAt, nowMs);
  } catch (error) {
    reportClassicBucketError(bundleExec, error);
  }
}

// Collection runs between page tasks, and later epochs are paced by the measured
// cost so cycle collection stays near 1% of isolate CPU time.
const CYCLE_COLLECT_INTERVAL_MS = 2000;
const CYCLE_COLLECT_COST_FACTOR = 100;
let cycleCollectorStarted = false;

function startCycleCollector(): void {
  if (cycleCollectorStarted) return;
  cycleCollectorStarted = true;
  const tick = (): void => {
    let costMs = 0;
    try {
      costMs = ks_cycle_collect(true);
    } catch (err) {
      console.error({
        event: "cycle_collector_failed",
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        intervalMs: CYCLE_COLLECT_INTERVAL_MS,
        cycleStats: cycleCollectStatsForLog(),
      });
    }
    nativeSetTimeout(tick, Math.max(CYCLE_COLLECT_INTERVAL_MS, costMs * CYCLE_COLLECT_COST_FACTOR));
  };
  nativeSetTimeout(tick, CYCLE_COLLECT_INTERVAL_MS);
}

function cycleCollectStatsForLog(): unknown {
  try {
    const stats: unknown = JSON.parse(ks_cycle_stats());
    return stats;
  } catch {
    return null;
  }
}

type CurrentUrlChangeKind = Parameters<NonNullable<BuildDocumentOpts["setCurrentUrl"]>>[1];

function updateCurrentUrl(newUrl: string, kind: CurrentUrlChangeKind): void {
  if (typeof newUrl !== "string" || newUrl.length === 0) return;
  const previous = state.pageUrl;
  logCurrentUrlChange(previous, newUrl, kind);
  state.pageUrl = newUrl;
  dispatchCurrentUrlEvents(previous, newUrl, kind);
  reportCurrentUrlNavigation(previous, newUrl, kind);
}

function logCurrentUrlChange(previous: string, newUrl: string, kind: CurrentUrlChangeKind): void {
  if (!startupCdpDebug) return;
  try {
    console.log(
      "[kitesurf-debug] setCurrentUrl",
      JSON.stringify({ kind, previous, newUrl, same: previous === newUrl }),
    );
  } catch {}
}

function dispatchCurrentUrlEvents(
  previous: string,
  newUrl: string,
  kind: CurrentUrlChangeKind,
): void {
  const window = state.window;
  if (!shouldDispatchCurrentUrlEvents(previous, newUrl, kind, window)) return;
  const stateForPopstate = window.history?.state ?? null;
  queuePageTask(() => dispatchCurrentHashChange(previous, newUrl));
  queuePageTask(() => dispatchCurrentPopState(stateForPopstate));
  scrollToFragment(newUrl);
}

function shouldDispatchCurrentUrlEvents(
  previous: string,
  newUrl: string,
  kind: CurrentUrlChangeKind,
  window: typeof state.window,
): window is NonNullable<typeof window> {
  return kind === "hash" && previous !== newUrl && Boolean(window);
}

function dispatchCurrentHashChange(previous: string, newUrl: string): void {
  try {
    const event: any = new ksEventCtors.HashChangeEvent("hashchange", {
      bubbles: false,
      cancelable: false,
      oldURL: previous,
      newURL: newUrl,
    });
    __ks_dispatchTrusted(state.window, event);
  } catch {}
}

function dispatchCurrentPopState(stateForPopstate: unknown): void {
  try {
    const event: any = new ksEventCtors.PopStateEvent("popstate", {
      bubbles: false,
      cancelable: false,
      state: stateForPopstate,
    });
    __ks_dispatchTrusted(state.window, event);
  } catch {}
}

function reportCurrentUrlNavigation(
  previous: string,
  newUrl: string,
  kind: CurrentUrlChangeKind,
): void {
  if (previous !== newUrl && kind !== "navigate") return;
  try {
    sendUpstreamEvent({
      event: "kitesurf.navigatedWithinDocument",
      params: {
        url: newUrl,
        navigationType: currentUrlNavigationType(kind),
        kind,
        previousUrl: previous,
      },
    });
  } catch {}
}

function currentUrlNavigationType(kind: CurrentUrlChangeKind): "fragment" | "historyApi" | "other" {
  if (kind === "hash") return "fragment";
  if (kind === "pushState" || kind === "replaceState") return "historyApi";
  return "other";
}

interface InsertedScriptRecord {
  id: number;
  src: string;
  source: string;
  type: string;
  integrity: string;
  nonce: string;
  crossOrigin: string | null;
}

function handleInsertedScript(info: unknown): void {
  const script = insertedScriptRecord(info);
  if (script.src) {
    runInsertedExternalScript({
      id: script.id,
      src: script.src,
      type: script.type,
      integrity: script.integrity,
      nonce: script.nonce,
      crossOrigin: script.crossOrigin,
    });
    return;
  }
  if (script.source) runInsertedInlineScript(script.source, script.nonce);
}

function insertedScriptRecord(info: unknown): InsertedScriptRecord {
  const record = isObjectRecord(info) ? info : {};
  return {
    id: typeof record.id === "number" ? record.id : -1,
    src: stringField(record.src),
    source: stringField(record.source),
    type: stringField(record.type),
    integrity: stringField(record.integrity),
    nonce: stringField(record.nonce),
    crossOrigin: typeof record.crossOrigin === "string" ? record.crossOrigin : null,
  };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function runInsertedInlineScript(source: string, nonce: string): void {
  const metadata = { url: null, nonce, body: source };
  const decision = inlineInsertDecisionSync(metadata);
  if (decision) {
    runInsertedInlineSyncDecision(decision, source);
    return;
  }
  void runInsertedInlineAsync(metadata, source);
}

function runInsertedInlineSyncDecision(
  decision: ReturnType<typeof inlineInsertDecisionSync>,
  source: string,
): void {
  if (!decision) return;
  reportOnly(decision);
  if (decision.allowed) evalInsertedInlineScript(source);
  else reportBlocked(decision);
}

async function runInsertedInlineAsync(
  metadata: { url: null; nonce: string; body: string },
  source: string,
): Promise<void> {
  const verdict = await insertedScriptAllowed(metadata);
  reportOnly(verdict);
  if (!verdict.allowed) {
    reportBlocked(verdict);
    return;
  }
  evalInsertedInlineScript(source);
}

function evalInsertedInlineScript(source: string): void {
  try {
    evalInsertedOnBoa(source);
  } catch (error) {
    try {
      console.warn(
        "[kitesurf] inserted-script eval failed:",
        error instanceof Error ? error.message : String(error),
      );
    } catch {}
  }
}

export class PageScript extends WorkerEntrypoint implements PageScriptSession {
  async fetch(_req: Request) {
    return new Response("PageScript", { status: 404 });
  }

  async navigate(
    html: string,
    url: string,
    navigateOptions?: NavigateOptions,
  ): Promise<NavigateSummary> {
    state.navigateStarted = true;
    startCycleCollector();
    const context = createNavigationContext(html, url, navigateOptions);
    applyNavigationConnectionOptions(context.options);
    if (navigateOptions && Array.isArray(navigateOptions.bindingNames)) {
      this.installBindings(navigateOptions.bindingNames);
    }
    initializeNavigationSession(context, this);
    emitNavigateDiagnostic(context, "start", "teardown");
    const documentPreparation = prepareNavigationDocument(context);
    if (documentPreparation) await documentPreparation;
    const scripts = await executeNavigationScripts(context);
    state.setReadyState("interactive");
    dispatchLifecycle(state.document, "readystatechange", { bubbles: false });
    dispatchLifecycle(state.document, "DOMContentLoaded", {
      bubbles: true,
      cancelable: false,
    });
    armNavigationLoadCompletion(context, scripts);
    getInternalState().mutationSeq += 1;
    return navigationSummary(context, scripts.scriptCount);
  }

  async awaitLoad(): Promise<LoadCompletion> {
    // A pipelined awaitLoad may arrive before navigate publishes loadCompletion.
    if (!state.loadCompletion && state.navigateStarted) {
      await state.loadCompletionArmed;
    }
    const loadCompletion = state.loadCompletion;
    if (!loadCompletion) {
      return {
        console: [],
        cookieWrites: [],
        cdpMutations: [],
        exceptions: [],
        phases: {},
      };
    }
    try {
      const summary = await loadCompletion;
      return { ...summary, sentAt: Date.now() };
    } catch (err) {
      console.error("[kitesurf] awaitLoad: loadCompletion rejected:", err);
      return {
        console: drainConsole(),
        cookieWrites: state.drainCookieWrites(),
        cdpMutations: drainCdpMutations(),
        exceptions: drainExceptions(),
        phases: {},
      };
    }
  }

  killIsolate(reason?: string): void {
    const why = reason || "generation retired";
    const killLine = isolateKillLine(ISOLATE_KILL_MARKER, why);
    if (killLine) console.log(killLine);
    abortIsolate(`kitesurf: ${why}`);
  }

  makeRenderPort(): RenderPortContract & Rpc.RpcTargetBranded {
    const host = this;
    class RenderPort extends RpcTarget implements RenderPortContract {
      recordScene(args: QueryDomArgs<"recordScene">) {
        return host.queryDom("recordScene", args || {});
      }
      getPaintResources(args: QueryDomArgs<"getPaintResources">) {
        return host.queryDom("getPaintResources", args || {});
      }
      getFontUrlData(args: QueryDomArgs<"getFontUrlData">) {
        return host.queryDom("getFontUrlData", args || {});
      }
      recordPdfScenes(args: QueryDomArgs<"recordPdfScenes">) {
        return host.queryDom("recordPdfScenes", args || {});
      }
    }
    return new RenderPort();
  }

  openSession(init: ReceivedSessionInit | undefined): RetainedPageScriptSessionTarget {
    initializePageScriptSession(() => (this.env as any)?.KS_TAIL_TOKEN);
    // Duplicate these callback stubs; openSession arguments expire when the call returns.
    const upstream = duplicateUpstreamStub(init);
    const outbound = duplicateOutboundStub(init);
    if (outbound) setSessionOutbound(outbound);
    const cleanup = { closed: false, upstream, outbound };
    const closeSession = () => closePageScriptSession(cleanup);
    registerSessionUpstream(upstream);
    installWasmTerminatedHandler();
    return createPageScriptSessionTarget(this, closeSession);
  }

  async unload(): Promise<UnloadReply> {
    dispatchWindowUnload();
    if (state.dom) {
      try {
        state.dom.free();
      } catch {}
      state.dom = null;
    }
    invalidatePaintDom();
    state.pageUrl = "";
    state.document = null;
    state.window = null;
    state.getOpLog = () => [];
    state.setReadyState = () => {};
    const cookieWrites = state.drainCookieWrites();
    state.drainCookieWrites = () => [];
    state.setCookieString = () => {};
    installGlobals(null, null, {});
    return { ok: true, console: drainConsole(), cookieWrites };
  }

  async drainConsole(): Promise<DrainConsoleReply> {
    return {
      console: drainConsole(),
      cookieWrites: state.drainCookieWrites(),
      cdpMutations: drainCdpMutations(),
      exceptions: drainExceptions(),
      documentReopened: takeDocumentReopened(),
    };
  }

  async syncCookies(cookieString: string): Promise<OkReply> {
    state.setCookieString(typeof cookieString === "string" ? cookieString : "");
    return { ok: true };
  }

  async installBindings(names: string[]): Promise<OkReply> {
    const list = Array.isArray(names) ? names : [];
    for (const raw of list) installPageBinding(raw);
    return { ok: true };
  }

  async setFrameBitmap(params: FrameBitmapParams): Promise<FrameBitmapReply> {
    const bitmap = frameBitmapFromParams(params);
    if (!bitmap) return { ok: false, rc: -1, error: "bad args" };
    return applyFrameBitmap(bitmap);
  }

  async deliverMessage(params: DeliverMessageParams): Promise<{ ok: boolean; error?: string }> {
    return dispatchMessageDelivery(prepareMessageDelivery(params));
  }

  async deliverWorkerEvent(params: WorkerEventParams): Promise<OkReply> {
    deliverWorkerEvent(params);
    return { ok: true };
  }

  async installIframeContent(params: IframeContentParams): Promise<OkReply> {
    return installIframeContentInDocument(params);
  }

  async iframeInstallsSettled(): Promise<OkReply> {
    awaitingIframeInstalls = false;
    return { ok: true };
  }

  async evaluate(expression: string, options: EvalOptions): Promise<EvalResult> {
    const returnByValue = !!(options && options.returnByValue);
    const awaitPromise = options === undefined ? true : options.awaitPromise !== false;
    const expr = typeof expression === "string" ? expression : "undefined";
    return await runExpression(expr, { returnByValue, awaitPromise });
  }

  async compileScript(
    expression: string,
    sourceURL: string,
    persistScript: boolean,
  ): Promise<CompileScriptReply> {
    const expr = typeof expression === "string" ? expression : "";
    const url = typeof sourceURL === "string" ? sourceURL : "";
    try {
      // eslint-disable-next-line no-new, no-new-func
      new Function(expr);
    } catch (err) {
      return packException(err);
    }
    if (!persistScript) {
      return { ok: true, scriptId: null };
    }
    const scriptId = compileScriptEntry(expr, url);
    return { ok: true, scriptId };
  }

  async runScript(scriptId: string, options: EvalOptions): Promise<RunScriptReply> {
    const returnByValue = !!(options && options.returnByValue);
    const awaitPromise = options === undefined ? true : options.awaitPromise !== false;
    const entry = getCompiledScript(scriptId);
    if (!entry) {
      return packException(new Error(`No script with id ${scriptId} (was the context evicted?)`));
    }
    let expr = entry.source;
    if (entry.sourceURL) {
      expr = expr + "\n//# sourceURL=" + entry.sourceURL;
    }
    return await runExpression(expr, { returnByValue, awaitPromise });
  }

  async callFunctionOn(
    functionDeclaration: string,
    argumentSpecs: ArgSpec[],
    options: CallFunctionOnOptions,
  ): Promise<EvalResult> {
    const settings = callFunctionSettings(options);
    const result = await evaluateCallFunctionOn(functionDeclaration, argumentSpecs, settings);
    return drainEvalResult(result);
  }

  async releaseObject(objectId: string): Promise<OkReply> {
    releaseHandle(objectId);
    return { ok: true };
  }

  async getProperties(
    objectId: string,
    options: { ownProperties?: boolean },
  ): Promise<{ result: PropertyDescriptor[] }> {
    const ownOnly = !options || options.ownProperties !== false;
    const objectValue = lookupHandle(objectId);
    if (!isPropertyInspectable(objectValue)) return { result: [] };
    return { result: collectObjectProperties(objectValue, ownOnly) };
  }

  async dispatchMouseEvent(type: string, init: MouseEventInit): Promise<MouseDispatchReply> {
    if (!state.document || typeof ksEventCtors.MouseEvent !== "function") {
      return emptyMouseDispatchReply();
    }
    const outcome = newMouseDispatchOutcome();
    const internalState = getInternalState();
    internalState.dispatchingUserEvent = true;
    internalState.pendingSubmitNav = null;
    try {
      dispatchMouseEventBody(createMouseDispatchContext(type, init, outcome));
    } catch (err) {
      console.error("[kitesurf] Input.dispatchMouseEvent failed", err);
    } finally {
      applyPendingMouseNavigation(outcome);
    }
    return mouseDispatchReply(outcome);
  }

  async dispatchKeyEvent(type: string, init: KeyEventInit): Promise<KeyDispatchReply> {
    const eventConstructor = keyboardEventConstructor();
    const earlyReply = earlyKeyDispatchReply(type, eventConstructor);
    if (earlyReply) return earlyReply;
    const outcome = newKeyDispatchOutcome();
    const internalState = getInternalState();
    internalState.dispatchingUserEvent = true;
    internalState.pendingSubmitNav = null;
    try {
      dispatchKeyboardEventBody(
        createKeyboardDispatchContext(type, init, eventConstructor, outcome),
      );
    } catch (err) {
      console.error("[kitesurf] Input.dispatchKeyEvent failed", err);
    } finally {
      applyPendingKeyNavigation(outcome);
    }
    return keyDispatchReply(outcome);
  }

  queryDom<M extends QueryDomMethod>(method: M, args: QueryDomArgs<M>): Promise<QueryDomResult<M>>;
  async queryDom(
    method: QueryDomMethod,
    args: Record<string, unknown> | undefined,
  ): Promise<QueryDomResult<QueryDomMethod>> {
    if (method === "setFrameContext") return queryDomSetFrameContext(args);
    const pageState = state;
    requireQueryDomDocument(pageState);
    return queryDomWithDocument(pageState, method, args || {});
  }
}

interface NavigationContext {
  safeUrl: string;
  safeHtml: string;
  options: NavigateOptions | undefined;
  initialCookies: string;
  nowMs: () => number;
  traced: boolean;
  phases: Record<string, number>;
  phaseStartedAt: number;
  bundleExec: string[];
}

type NavigationDiagnosticEvent = "start" | "end";

interface NavigationDomSetup {
  dom: DomHandle;
  marker: string | null;
}

interface NavigationScriptResult {
  useBundle: boolean;
  legacyPlan: ReturnType<typeof planScripts> | null;
  scriptCount: number;
}

function createNavigationContext(
  html: string,
  url: string,
  options: NavigateOptions | undefined,
): NavigationContext {
  const nowMs = navigationClock();
  const context: NavigationContext = {
    safeUrl: safeNavigationUrl(url),
    safeHtml: safeNavigationHtml(html),
    options,
    initialCookies: initialNavigationCookies(options),
    nowMs,
    traced: false,
    phases: {},
    phaseStartedAt: 0,
    bundleExec: [],
  };
  logNavigationStart(context);
  return context;
}

function safeNavigationUrl(url: string): string {
  return typeof url === "string" ? url : "about:blank";
}

function safeNavigationHtml(html: string): string {
  return typeof html === "string" && html.length > 0
    ? html
    : "<html><head></head><body></body></html>";
}

function initialNavigationCookies(options: NavigateOptions | undefined): string {
  return typeof options?.cookies === "string" ? options.cookies : "";
}

function navigationClock(): () => number {
  return typeof performance !== "undefined" && performance.now
    ? () => performance.now()
    : () => Date.now();
}

function logNavigationStart(context: NavigationContext): void {
  if (!startupCdpDebug) return;
  const NAVIGATE_HTML_PREVIEW_CHARS = 200;
  try {
    console.log(
      "[kitesurf-debug] PageScript.navigate() called",
      JSON.stringify({
        url: context.safeUrl,
        htmlLength: context.safeHtml.length,
        htmlPreview: context.safeHtml.slice(0, NAVIGATE_HTML_PREVIEW_CHARS),
        startupScriptCount: startupInputSnapshot?.scriptDescriptorCount,
        startupSample: startupInputSnapshot?.scriptDescriptorSample,
        startupHasClassicRegular: startupHasClassicRegular,
      }),
    );
  } catch {}
}

function initializeNavigationSession(context: NavigationContext, host: PageScript): void {
  context.traced = context.options?.traced === true;
  awaitingIframeInstalls = context.options?.expectIframeInstalls === true;
  armNavigationTracing(host, context.traced);
  context.phaseStartedAt = context.nowMs();
}

function applyNavigationConnectionOptions(options: NavigateOptions | undefined): void {
  applyNavigationConnectionId(options);
  applyNavigationMainFrameId(options);
  applyNavigationCookieKey(options);
}

function applyNavigationConnectionId(options: NavigateOptions | undefined): void {
  const connectionId = options?.connectionId;
  if (typeof connectionId === "string") state.connectionId = connectionId;
}

function applyNavigationMainFrameId(options: NavigateOptions | undefined): void {
  const mainFrameId = options?.mainFrameId;
  if (typeof mainFrameId === "string") state.mainFrameId = mainFrameId;
}

function applyNavigationCookieKey(options: NavigateOptions | undefined): void {
  const cookieKey = options?.cookieKey;
  if (typeof cookieKey === "string") state.cookieKey = cookieKey;
}

function armNavigationTracing(host: PageScript, traced: boolean): void {
  try {
    set_ks_tracing(traced);
  } catch {}
  try {
    armKsOtel(traced);
  } catch {}
  try {
    armSpanSink(host, traced);
  } catch {}
}

function emitNavigateDiagnostic(
  context: NavigationContext,
  event: NavigationDiagnosticEvent,
  operation: string,
  extra?: Record<string, unknown>,
): void {
  if (!context.traced) return;
  try {
    sendUpstreamEvent({
      event: "kitesurf.diag",
      params: {
        ev: event,
        op: operation,
        t: context.nowMs(),
        ...(extra || {}),
      },
    });
  } catch {}
}

function markNavigationPhase(context: NavigationContext, name: string): void {
  const phaseEndedAt = context.nowMs();
  context.phases[name] = +(phaseEndedAt - context.phaseStartedAt).toFixed(3);
  context.phaseStartedAt = phaseEndedAt;
}

function prepareNavigationDocument(context: NavigationContext): Promise<void> | void {
  teardownPreviousNavigation(context);
  prepareNavigationEnvironment(context);
  emitNavigateDiagnostic(context, "start", "fonts");
  const fontRegistration = navigationFontRegistration(context);
  if (fontRegistration) return fontRegistration.then(() => finishNavigationDocument(context));
  finishNavigationDocument(context);
}

function finishNavigationDocument(context: NavigationContext): void {
  finishNavigationEnvironment(context);
  const domSetup = createNavigationDom(context);
  const built = buildNavigationDocument(context, domSetup);
  installBuiltNavigationDocument(built);
  installNavigationIframeHooks();
  applyBuiltDocumentLifecycleHooks(built);
  emitNavigateDiagnostic(context, "end", "shim");
  markNavigationPhase(context, "shimMs");
}

function teardownPreviousNavigation(context: NavigationContext): void {
  dispatchWindowUnload();
  if (state.dom) {
    try {
      state.dom.free();
    } catch {}
  }
  state.pageUrl = context.safeUrl;
  state.lastForceRestyleSeq = -1;
  state.currentMediaType = "screen";
  emitNavigateDiagnostic(context, "end", "teardown");
  markNavigationPhase(context, "teardownMs");
}

function prepareNavigationEnvironment(context: NavigationContext): void {
  setNavigationImageDimensions();
  applyNavigationDarkScheme(context.options);
  applyNavigationMonoFace(context.options);
  applyNavigationPixelFreeMode();
}

function navigationFontRegistration(context: NavigationContext): Promise<void> | null {
  if (fontDeferActive()) {
    startFontPrefetch(context.safeHtml);
    return null;
  }
  return ensureFontsRegistered(context.safeHtml);
}

function finishNavigationEnvironment(context: NavigationContext): void {
  emitNavigateDiagnostic(context, "end", "fonts");
  markNavigationPhase(context, "fontsMs");
  installNavigationTtyCss(context.options);
}

function setNavigationImageDimensions(): void {
  try {
    setDimsOnlyImages(true);
  } catch {}
}

function applyNavigationDarkScheme(options: NavigateOptions | undefined): void {
  const darkColorScheme = options?.darkColorScheme;
  if (typeof darkColorScheme !== "boolean") return;
  try {
    setDarkColorScheme(darkColorScheme);
  } catch {}
  ksGlobal.__ks_dark_scheme = darkColorScheme;
}

function applyNavigationMonoFace(options: NavigateOptions | undefined): void {
  if (typeof options?.ttyUaCss !== "number" || options.ttyUaCss <= 0) return;
  forceMonoFace();
}

function applyNavigationPixelFreeMode(): void {
  if (!startupPixelFree) return;
  try {
    setPixelFreeSession(true);
  } catch {}
}

function hasNavigationTtyGrid(options: NavigateOptions | undefined): boolean {
  return (
    typeof options?.ttyUaCss === "number" &&
    options.ttyUaCss > 0 &&
    typeof options.ttyCss === "string" &&
    options.ttyCss.length > 0
  );
}

function installNavigationTtyCss(options: NavigateOptions | undefined): void {
  if (hasNavigationTtyGrid(options)) {
    installNavigationTtyGrid(options);
    return;
  }
  const css = navigationTtyCss(options);
  if (css !== null) setTtyUaCss(css);
}

function navigationTtyCss(options: NavigateOptions | undefined): string | null {
  const css = options?.ttyCss;
  return typeof css === "string" && css.length > 0 ? css : null;
}

function installNavigationTtyGrid(options: NavigateOptions | undefined): void {
  const css = options?.ttyCss;
  if (typeof css !== "string") return;
  try {
    installNavigationTtyGridForCss(css, options);
  } catch (error) {
    console.warn("[kitesurf-tty] sheet install failed:", String(error));
  }
}

function installNavigationTtyGridForCss(css: string, options: NavigateOptions | undefined): void {
  const cellWidth = navigationTtyCellWidth(options);
  const cellHeight = navigationTtyCellHeight(options);
  ksGlobal.__ks_tty_cell_w = cellWidth;
  ksGlobal.__ks_tty_cell_h = cellHeight;
  const ratio = monoAdvancePerEm();
  if (ratio > 0) {
    installNavigationTtyGridSheet(css, cellWidth, cellHeight, ratio);
    return;
  }
  setTtyCellGrid(0, 0);
  console.warn("[kitesurf-tty] no mono face registered; sheet NOT installed");
}

function navigationTtyCellWidth(options: NavigateOptions | undefined): number {
  return positiveOptionOr(options?.ttyCellW, 8);
}

function navigationTtyCellHeight(options: NavigateOptions | undefined): number {
  return positiveOptionOr(options?.ttyCellH, 17);
}

function positiveOptionOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && value > 0 ? value : fallback;
}

function installNavigationTtyGridSheet(
  css: string,
  cellWidth: number,
  cellHeight: number,
  ratio: number,
): void {
  const fontPx = cellWidth / ratio;
  setTtyUaCss(css.replace(/\{\{FONT_PX\}\}/g, String(fontPx)));
  setTtyCellGrid(cellWidth, cellHeight);
  console.log(
    `[kitesurf-tty] sheet installed: cell=${cellWidth}x${cellHeight} ` +
      `advance/em=${ratio.toFixed(4)} font-size=${fontPx.toFixed(3)}px`,
  );
}

function createNavigationDom(context: NavigationContext): NavigationDomSetup {
  emitNavigateDiagnostic(context, "start", "parse");
  const sourceDoctype = sourceDoctypeOf(context.safeHtml);
  const marker = navigationDoctypeMarker(sourceDoctype);
  const parsedHtml = htmlWithNavigationDoctypeMarker(context.safeHtml, sourceDoctype, marker);
  const dom = new DomHandle(parsedHtml, context.safeUrl);
  state.dom = dom;
  noteNavigateText(dom);
  state.sourceDoctype = navigationSourceDoctype(sourceDoctype, marker);
  setNavigationViewport(dom, context.options);
  setNavigationDomDebugReference();
  state.scrollX = 0;
  state.scrollY = 0;
  invalidatePaintDom();
  emitNavigateDiagnostic(context, "end", "parse");
  markNavigationPhase(context, "parseMs");
  emitNavigateDiagnostic(context, "start", "shim");
  return { dom, marker };
}

function navigationDoctypeMarker(sourceDoctype: ReturnType<typeof sourceDoctypeOf>): string | null {
  return sourceDoctype ? `__kitesurf_doctype_${Math.random().toString(36).slice(2)}__` : null;
}

function htmlWithNavigationDoctypeMarker(
  html: string,
  sourceDoctype: ReturnType<typeof sourceDoctypeOf>,
  marker: string | null,
): string {
  if (!sourceDoctype || !marker) return html;
  return html.slice(0, sourceDoctype.end) + `<!--${marker}-->` + html.slice(sourceDoctype.end);
}

function navigationSourceDoctype(
  sourceDoctype: ReturnType<typeof sourceDoctypeOf>,
  marker: string | null,
): { markup: string; marker: string } | null {
  if (!sourceDoctype || !marker) return null;
  return { markup: sourceDoctype.markup, marker };
}

interface NavigationViewport {
  width: number;
  height: number;
}

function navigationViewport(options: NavigateOptions | undefined): NavigationViewport | null {
  const width = options?.viewportWidth;
  const height = options?.viewportHeight;
  if (typeof width !== "number") return null;
  if (typeof height !== "number") return null;
  return {
    width: Math.max(1, Math.floor(width)),
    height: Math.max(1, Math.floor(height)),
  };
}

function setNavigationViewport(dom: DomHandle, options: NavigateOptions | undefined): void {
  const viewport = navigationViewport(options);
  if (!viewport) return;
  state.paintViewportW = viewport.width;
  state.paintViewportH = viewport.height;
  try {
    const internalState = getInternalState();
    internalState.viewportW = viewport.width;
    internalState.viewportH = viewport.height;
  } catch {}
  try {
    dom.setViewport(viewport.width, viewport.height);
  } catch {}
}

function setNavigationDomDebugReference(): void {
  try {
    ksGlobal.__ks_dom_debug = state.dom;
  } catch {}
}

function buildNavigationDocument(
  context: NavigationContext,
  domSetup: NavigationDomSetup,
): BuildDocumentResult {
  installNativeToString();
  return ksSpan("dom.build_document", null, () =>
    buildDocument(domSetup.dom, createNavigationBuildOptions(context, domSetup.marker)),
  );
}

function createNavigationBuildOptions(
  context: NavigationContext,
  marker: string | null,
): BuildDocumentOpts {
  return {
    pageUrl: context.safeUrl,
    initialCookieString: context.initialCookies,
    doctypeMarker: marker,
    userAgent: startupUserAgent,
    referrer: startupReferrer,
    canonicalizeInlineStyle: canonicalizeNavigationInlineStyle,
    parseTypedStyleValue: parseNavigationTypedStyleValue,
    parseTypedNumericValue: parseNavigationTypedNumericValue,
    parseCounterStyleRule: parseNavigationCounterStyleRule,
    serializeInlineStyle: serializeNavigationInlineStyle,
    getInlinePropertyValue: navigationInlinePropertyValue,
    createRuleStyleDeclaration: createNavigationRuleStyleDeclaration,
    canonicalizePageSelectors: canonicalizeNavigationPageSelectors,
    characterSet: documentCharacterSet(context.options?.charset),
    encodingName: navigationEncodingName,
    percentEncodeAfterEncoding: ks_percent_encode_after_encoding,
    encodeHtml: ks_encode_html,
    getCurrentUrl: currentNavigationUrl,
    setCurrentUrl: updateCurrentUrl,
    getRectByAuthId: navigationRectByAuthId,
    getScrollInfoByAuthId: navigationScrollInfoByAuthId,
    getOffsetMetricsByAuthId: navigationOffsetMetricsByAuthId,
    getStickyShiftByAuthId: navigationStickyShiftByAuthId,
    hitTestViaPaint: navigationHitTestViaPaint,
    getComputedStyleForAuthId: computedStyleForAuthId,
    getComputedStyleValueForAuthId: computedStyleValueForAuthId,
    getExternalSheetRules: externalSheetRulesForNode,
    getScrollOffset: navigationScrollOffset,
    setScrollOffset: navigationSetScrollOffset,
    setWheelScrollOffset: (x, y) => navigationWheelScrollOffset(context, x, y),
    armTransitionDrain,
  };
}

function canonicalizeNavigationInlineStyle(css: string) {
  try {
    return ks_parse_inline_style(css);
  } catch {
    return [];
  }
}

function parseNavigationTypedStyleValue(property: string, cssText: string): unknown {
  try {
    return ks_parse_typed_style_value(property, cssText);
  } catch {
    return null;
  }
}

function parseNavigationTypedNumericValue(cssText: string): unknown {
  try {
    return ks_parse_typed_numeric_value(cssText);
  } catch {
    return null;
  }
}

function parseNavigationCounterStyleRule(css: string, field: string, value: string): unknown {
  try {
    return ks_counter_style_rule(css, field, value);
  } catch {
    return null;
  }
}

function serializeNavigationInlineStyle(css: string): string {
  try {
    return ks_serialize_inline_style(css);
  } catch {
    return "";
  }
}

function navigationInlinePropertyValue(css: string, property: string): string {
  try {
    return ks_get_property_value(css, property);
  } catch {
    return "";
  }
}

function createNavigationRuleStyleDeclaration(
  context: "style" | "keyframe" | "font-face" | "page",
  css: string,
  baseUrl: string,
): RuleStyleDeclarationStore {
  return new RuleStyleDeclarationStore(context, css, baseUrl);
}

function canonicalizeNavigationPageSelectors(prelude: string): string | undefined {
  try {
    return ks_canonicalize_page_selectors(prelude);
  } catch {
    return undefined;
  }
}

function navigationEncodingName(label: string): string | undefined {
  try {
    return ks_encoding_name(label);
  } catch {
    return undefined;
  }
}

function currentNavigationUrl(): string {
  return state.pageUrl;
}

type NavigationPaint = NonNullable<ReturnType<typeof ensurePaintDom>>;

function navigationPaintForAuthId(authId: number): NavigationPaint | null {
  if (typeof authId !== "number" || authId <= 0) return null;
  return ensurePaintDom();
}

function navigationRectByAuthId(
  authId: number,
): ReturnType<NonNullable<BuildDocumentOpts["getRectByAuthId"]>> {
  const paint = navigationPaintForAuthId(authId);
  if (!paint) return null;
  try {
    return rectWithScrollOffset(paint.getBoundingClientRect(authId));
  } catch {
    invalidatePaintDom();
    return null;
  }
}

function navigationScrollInfoByAuthId(
  authId: number,
): ReturnType<NonNullable<BuildDocumentOpts["getScrollInfoByAuthId"]>> {
  const paint = navigationPaintForAuthId(authId);
  if (!paint) return null;
  try {
    return paint.nodeScrollInfo(authId);
  } catch {
    invalidatePaintDom();
    return null;
  }
}

function navigationOffsetMetricsByAuthId(
  authId: number,
): ReturnType<NonNullable<BuildDocumentOpts["getOffsetMetricsByAuthId"]>> {
  const paint = navigationPaintForAuthId(authId);
  if (!paint) return null;
  try {
    return paint.offsetMetrics(authId);
  } catch {
    invalidatePaintDom();
    return null;
  }
}

function navigationStickyShiftByAuthId(
  authId: number,
): ReturnType<NonNullable<BuildDocumentOpts["getStickyShiftByAuthId"]>> {
  const paint = navigationPaintForAuthId(authId);
  if (!paint) return null;
  try {
    return paint.stickyShift(authId);
  } catch {
    invalidatePaintDom();
    return null;
  }
}

function navigationHitTestViaPaint(x: number, y: number): number {
  const paint = ensurePaintDom();
  if (!paint) return -1;
  try {
    const id = paint.elementFromPoint(x + state.scrollX, y + state.scrollY);
    return validNavigationHitTestId(id);
  } catch {
    invalidatePaintDom();
    return -1;
  }
}

function validNavigationHitTestId(id: unknown): number {
  return typeof id === "number" && id >= 0 ? id : -1;
}

function navigationScrollOffset(): { x: number; y: number } {
  return { x: state.scrollX, y: state.scrollY };
}

function navigationSetScrollOffset(x: number, y: number): ReturnType<typeof setScrollOffset> {
  return setScrollOffset(x, y);
}

function navigationWheelScrollOffset(
  context: NavigationContext,
  x: number,
  y: number,
): ReturnType<typeof setScrollOffset> {
  return setScrollOffset(
    x,
    y,
    Number(context.options?.ttyCellW) || 0,
    Number(context.options?.ttyCellH) || 0,
  );
}

function installBuiltNavigationDocument(built: BuildDocumentResult): void {
  state.document = built.document;
  state.window = built.window;
  startExternalSvgSpriteResolution();
  installBuiltNavigationCallbacks(built);
  installBuiltNavigationGlobals();
  installGlobals(state.document, state.window, built);
  preinstallStaticIframes();
  ksSpan("dom.mark_engine_functions", null, () =>
    markEngineFunctions([globalThis, state.window, state.document]),
  );
}

function startExternalSvgSpriteResolution(): void {
  try {
    void resolveExternalSvgSprites();
  } catch {}
}

function installBuiltNavigationCallbacks(built: BuildDocumentResult): void {
  installBuiltPageCallbacks(built);
  installBuiltNodeCallbacks(built);
  installBuiltEventCallbacks(built);
  __ks_dispatchTrustedEvent = built.__ks_dispatchTrustedEvent || null;
  __ks_activateLabel = built.__ks_activateLabel;
  state.dispatchTrustedEvent = __ks_dispatchTrusted;
}

function installBuiltPageCallbacks(built: BuildDocumentResult): void {
  state.getOpLog = built.getOpLog || (() => []);
  state.setReadyState = built.setReadyState || (() => {});
  state.drainCookieWrites = built.drainCookieWrites || (() => []);
}

function installBuiltNodeCallbacks(built: BuildDocumentResult): void {
  state.setCookieString = built.setCookieString || (() => {});
  state.resolveNodeId = built.nodeFor || (() => null);
  state.notifyImageResults = built.notifyImageResults || (() => {});
}

function installBuiltEventCallbacks(built: BuildDocumentResult): void {
  state.notifyStylesheetResults = built.notifyStylesheetResults || (() => {});
  state.getActiveElement = built.getActiveElement || (() => null);
  state.drainCdpMutationsRaw = built.drainCdpMutations || (() => []);
}

function installBuiltNavigationGlobals(): void {
  ksGlobal.__ks_canonicalize_inline_style = canonicalizeNavigationInlineStyle;
}

function installNavigationIframeHooks(): void {
  const internalState = getInternalState();
  internalState.afterIframeInsert = handleAfterIframeInsert;
  internalState.afterIframeRemove = handleAfterIframeRemove;
  internalState.afterIframeSrcChange = handleAfterIframeSrcChange;
  internalState.navigateIframe = handleIframeNavigation;
  internalState.endClassicScript = finishClassicScriptTurn;
  internalState.afterScriptInsert = handleInsertedScript;
}

function handleAfterIframeInsert(iframeElement: unknown): void {
  try {
    handleDynamicIframeInsert(iframeElement);
  } catch (error) {
    warnDynamicIframeInsert(error);
  }
}

function warnDynamicIframeInsert(error: unknown): void {
  try {
    console.warn(
      "[kitesurf-iframe] dynamic-insert handler failed:",
      error instanceof Error ? error.message : String(error),
    );
  } catch {}
}

function handleAfterIframeRemove(iframeElement: unknown): void {
  try {
    const frameId = (iframeElement as { __ks_iframeFrameId?: unknown } | null)?.__ks_iframeFrameId;
    if (typeof frameId !== "string" || frameId.length === 0) return;
    sendUpstreamEvent({ event: "kitesurf.frameDetached", params: { frameId } });
  } catch {}
}

function handleAfterIframeSrcChange(iframeElement: unknown): void {
  try {
    handleIframeSrcChange(iframeElement);
  } catch (error) {
    warnIframeSourceChange(error);
  }
}

function warnIframeSourceChange(error: unknown): void {
  try {
    console.warn(
      "[kitesurf-iframe] src-change handler failed:",
      error instanceof Error ? error.message : String(error),
    );
  } catch {}
}

function handleIframeNavigation(iframeElement: unknown, url: string, post?: IframePost): void {
  try {
    handleIframeSrcChange(iframeElement, url, post);
  } catch (error) {
    warnIframeFailure(error, { operation: "form target navigation", url });
  }
}

async function finishClassicScriptTurn(): Promise<void> {
  try {
    await drainSettleMicrotasks();
  } catch {}
  try {
    getInternalState().setCurrentScript?.(null);
  } catch {}
}

function applyBuiltDocumentLifecycleHooks(built: BuildDocumentResult): void {
  applyDeclarativeShadowRoots(built);
  stampInitialNamedGlobals(built);
}

function applyDeclarativeShadowRoots(built: BuildDocumentResult): void {
  if (typeof built.applyDeclarativeShadowRoots !== "function") return;
  try {
    built.applyDeclarativeShadowRoots();
  } catch {}
}

function stampInitialNamedGlobals(built: BuildDocumentResult): void {
  if (typeof built.stampInitialNamedGlobals !== "function") return;
  try {
    built.stampInitialNamedGlobals();
  } catch {}
}

async function executeNavigationScripts(
  context: NavigationContext,
): Promise<NavigationScriptResult> {
  const fontWait = deferredFontsObservedByScripts(context);
  if (fontWait) await fontWait;
  emitNavigateDiagnostic(context, "start", "regular_scripts");
  resetConsoleBuffer();
  resetExceptionBuffer();
  const useBundle = navigationUsesBundle();
  if (useBundle) {
    const scriptCount = await runBundledNavigationScripts(context);
    return { useBundle, legacyPlan: null, scriptCount };
  }
  const legacy = await runLegacyNavigationScripts(context);
  return {
    useBundle,
    legacyPlan: legacy.legacyPlan,
    scriptCount: legacy.scriptCount,
  };
}

function deferredFontsObservedByScripts(context: NavigationContext): Promise<void> | null {
  if (!fontDeferActive()) return null;
  if (!navigationHasScriptObservers(context.safeHtml)) return null;
  return awaitDeferredFontBytes();
}

function navigationHasScriptObservers(html: string): boolean {
  return startupScriptDescriptors.length > 0 || /\son\w+\s*=/i.test(html);
}

function navigationUsesBundle(): boolean {
  return startupHasClassicRegular || startupHasClassicAsync || startupModuleScriptCount > 0;
}

function shouldRunBundledNavigationScripts(): boolean {
  return startupHasClassicRegular || startupModuleScriptCount > 0;
}

async function runBundledNavigationScripts(context: NavigationContext): Promise<number> {
  const cssWait = waitForNavigationCriticalCss(context);
  if (cssWait) await cssWait;
  const classicRun = runBundledClassicRegularScripts(context);
  if (classicRun) await classicRun;
  const moduleRun = runBundledModuleScripts(context);
  if (moduleRun) await moduleRun;
  return navigationStartupScriptCount();
}

function waitForNavigationCriticalCss(context: NavigationContext): Promise<void> | void {
  if (!shouldRunBundledNavigationScripts()) return;
  const cssStart = Date.now();
  const cssDeadline = cssStart + CSS_CRITICAL_RESOURCE_WAIT_BUDGET_MS;
  const cssWait = waitForCriticalCssResources(cssDeadline);
  if (!cssWait) return;
  return cssWait.then((cssWaits) => {
    if (cssWaits > 0) context.bundleExec.push(`css-block:${Date.now() - cssStart}ms`);
  });
}

const CSS_CRITICAL_RESOURCE_WAIT_BUDGET_MS = 5000;
const CSS_CRITICAL_RESOURCE_POLL_INTERVAL_MS = 25;

function waitForCriticalCssResources(deadline: number): Promise<number> | null {
  if (!hasNavigationCriticalResources()) return null;
  if (Date.now() >= deadline) return null;
  return pollCriticalCssResources(deadline);
}

async function pollCriticalCssResources(deadline: number): Promise<number> {
  let waits = 0;
  while (true) {
    waits++;
    await NativePromise.race([
      nativeSleep(CSS_CRITICAL_RESOURCE_POLL_INTERVAL_MS),
      nextResourceSettle(),
    ]);
    if (!hasNavigationCriticalResources()) return waits;
    if (Date.now() >= deadline) return waits;
  }
}

function hasNavigationCriticalResources(): boolean {
  const dom = state.dom;
  if (!dom || typeof dom.hasPendingCriticalResources !== "function") return false;
  try {
    return Boolean(dom.hasPendingCriticalResources());
  } catch {
    return false;
  }
}

function runBundledClassicRegularScripts(context: NavigationContext): Promise<void> | void {
  if (startupHasClassicRegular) {
    context.bundleExec.push("classic:start");
    const scriptStartedAt = context.nowMs();
    resetBundleDiagnostics();
    return runClassicRegularBucket(context.bundleExec, scriptStartedAt, context.nowMs).then(() => {
      finishBundledClassicRegularScripts(context);
    });
  } else {
    context.bundleExec.push("classic:skipped(no-bundle)");
  }
  finishBundledClassicRegularScripts(context);
}

function finishBundledClassicRegularScripts(context: NavigationContext): void {
  emitNavigateDiagnostic(context, "end", "regular_scripts");
  markNavigationPhase(context, "regularScriptsMs");
  emitNavigateDiagnostic(context, "start", "module_scripts");
}

function resetBundleDiagnostics(): void {
  if (!startupCdpDebug) return;
  try {
    getInternalState().bundleDiag = null;
  } catch {}
}

function runBundledModuleScripts(context: NavigationContext): Promise<void> | void {
  if (startupModuleScriptCount > 0) installInitShims();
  context.bundleExec.push("module:count=" + startupModuleScriptCount);
  const progress: NavigationModuleProgress = { successCount: 0, failureCount: 0 };
  if (startupModuleScriptCount === 0) {
    finishNavigationModuleScripts(context, progress);
    finishBundledModuleScripts(context);
    return;
  }
  return runNavigationModuleImports(context, progress)
    .finally(() => finishNavigationModuleScripts(context, progress))
    .then(() => finishBundledModuleScripts(context));
}

function finishBundledModuleScripts(context: NavigationContext): void {
  emitNavigateDiagnostic(context, "end", "module_scripts");
  markNavigationPhase(context, "moduleScriptsMs");
}

interface NavigationModuleProgress {
  successCount: number;
  failureCount: number;
}

const MAX_MODULE_ERRORS_LOGGED = 3;
const MAX_MODULE_ERROR_MESSAGE_CHARS = 200;

async function runNavigationModuleImports(
  context: NavigationContext,
  progress: NavigationModuleProgress,
): Promise<void> {
  const drainUpgrades = (globalThis as { __ks_drainCustomElementUpgrades?: () => void })
    .__ks_drainCustomElementUpgrades;
  const pendingImports: Array<Promise<void>> = [];
  for (let moduleIndex = 0; moduleIndex < startupModuleScriptCount; moduleIndex++) {
    await runOneNavigationModule(context, moduleIndex, progress, pendingImports, drainUpgrades);
  }
  await settlePendingNavigationModules(pendingImports);
}

async function runOneNavigationModule(
  context: NavigationContext,
  moduleIndex: number,
  progress: NavigationModuleProgress,
  pendingImports: Promise<void>[],
  drainUpgrades: (() => void) | undefined,
): Promise<void> {
  const moduleUrl = startupModuleScriptUrls[moduleIndex] ?? "";
  const moduleImport = trackNavigationModuleImport(
    context,
    moduleIndex,
    moduleUrl,
    importModule(moduleUrl),
    progress,
  );
  const outcome = await NativePromise.race([
    moduleImport.then(() => "settled" as const),
    nativeSleep(0).then(() => "pending" as const),
  ]);
  if (outcome === "pending") {
    parkNavigationModuleImport(context, moduleIndex, moduleImport, pendingImports);
  }
  drainPageCustomElementUpgrades(drainUpgrades);
}

function trackNavigationModuleImport(
  context: NavigationContext,
  moduleIndex: number,
  moduleUrl: string,
  modulePromise: Promise<unknown>,
  progress: NavigationModuleProgress,
): Promise<void> {
  return modulePromise.then(
    () => {
      progress.successCount++;
    },
    (error) => {
      recordNavigationModuleFailure(context, moduleIndex, moduleUrl, error, progress);
    },
  );
}

function recordNavigationModuleFailure(
  context: NavigationContext,
  moduleIndex: number,
  moduleUrl: string,
  error: unknown,
  progress: NavigationModuleProgress,
): void {
  progress.failureCount++;
  if (progress.failureCount <= MAX_MODULE_ERRORS_LOGGED) {
    const message = errorMessageOrValue(error).slice(0, MAX_MODULE_ERROR_MESSAGE_CHARS);
    context.bundleExec.push("module:err[" + moduleIndex + "]=" + message);
  }
  pushException(error, {
    scriptId: "bundle:module-" + moduleIndex,
    url: moduleUrl || "/__ks_user_module_" + moduleIndex + ".js",
    text: "Uncaught",
  });
  console.error("[kitesurf] user module " + moduleIndex + " (" + moduleUrl + ") threw:", error);
}

function parkNavigationModuleImport(
  context: NavigationContext,
  moduleIndex: number,
  moduleImport: Promise<void>,
  pendingImports: Promise<void>[],
): void {
  context.bundleExec.push("module:tla-parked[" + moduleIndex + "]");
  drainInitShims();
  drainDeferParked();
  installInitShims();
  pendingImports.push(moduleImport);
}

async function settlePendingNavigationModules(pendingImports: Promise<void>[]): Promise<void> {
  if (pendingImports.length === 0) return;
  drainInitShims();
  await NativePromise.race([NativePromise.all(pendingImports), nativeSleep(TLA_SETTLE_BUDGET_MS)]);
}

function finishNavigationModuleScripts(
  context: NavigationContext,
  progress: NavigationModuleProgress,
): void {
  if (startupModuleScriptCount > 0) drainInitShims();
  drainDeferParked();
  context.bundleExec.push(
    "module:done(ok=" + progress.successCount + ",err=" + progress.failureCount + ")",
  );
}

function navigationStartupScriptCount(): number {
  return Array.isArray(startupScriptDescriptors) ? startupScriptDescriptors.length : 0;
}

interface LegacyNavigationScripts {
  legacyPlan: ReturnType<typeof planScripts>;
  scriptCount: number;
}

async function runLegacyNavigationScripts(
  context: NavigationContext,
): Promise<LegacyNavigationScripts> {
  const scripts = extractScripts();
  const legacyPlan = planScripts(scripts);
  await runRegularPhase(legacyPlan);
  emitNavigateDiagnostic(context, "end", "regular_scripts");
  markNavigationPhase(context, "regularScriptsMs");
  emitNavigateDiagnostic(context, "start", "module_scripts");
  await runModulePhase(legacyPlan);
  emitNavigateDiagnostic(context, "end", "module_scripts");
  markNavigationPhase(context, "moduleScriptsMs");
  return { legacyPlan, scriptCount: scripts.length };
}

function armNavigationLoadCompletion(
  context: NavigationContext,
  scripts: NavigationScriptResult,
): void {
  const startedAt = context.nowMs();
  state.loadCompletion = completeNavigationLoad(context, scripts, startedAt);
  state.settleLoadCompletionArmed();
}

function navigationSummary(context: NavigationContext, scriptCount: number): NavigateSummary {
  return {
    title: "",
    nodeCount: 0,
    documentNodeId: 0,
    url: context.safeUrl,
    scriptCount,
    readyState: "interactive",
    console: drainConsole(),
    cookieWrites: state.drainCookieWrites(),
    cdpMutations: drainCdpMutations(),
    exceptions: drainExceptions(),
    phases: context.phases,
    bundleExec: context.bundleExec,
    fontDegradedReads: deferredDegradedReads(),
  };
}

interface LoadPhaseProgress {
  phases: Record<string, number>;
  phaseStartedAt: number;
}

function loadPhaseProgress(startedAt: number): LoadPhaseProgress {
  return { phases: {}, phaseStartedAt: startedAt };
}

function markLoadPhase(
  context: NavigationContext,
  progress: LoadPhaseProgress,
  name: string,
): void {
  const phaseEndedAt = context.nowMs();
  progress.phases[name] = +(phaseEndedAt - progress.phaseStartedAt).toFixed(3);
  progress.phaseStartedAt = phaseEndedAt;
}

async function completeNavigationLoad(
  context: NavigationContext,
  scripts: NavigationScriptResult,
  startedAt: number,
): Promise<LoadCompletion> {
  const progress = loadPhaseProgress(startedAt);
  await runNavigationAsyncScripts(context, scripts, progress);
  await drainNavigationResources(context, progress);
  compileNavigationEventAttributes();
  await settleNavigationAfterLoad(context, progress);
  return {
    console: drainConsole(),
    cookieWrites: state.drainCookieWrites(),
    cdpMutations: drainCdpMutations(),
    exceptions: drainExceptions(),
    phases: progress.phases,
    readyAt: Date.now(),
  };
}

async function runNavigationAsyncScripts(
  context: NavigationContext,
  scripts: NavigationScriptResult,
  progress: LoadPhaseProgress,
): Promise<void> {
  emitNavigateDiagnostic(context, "start", "async_scripts");
  if (scripts.useBundle) {
    if (startupHasClassicAsync) await runClassicAsyncBucket();
  } else if (scripts.legacyPlan) {
    await runAsyncPhase(scripts.legacyPlan);
  }
  emitNavigateDiagnostic(context, "end", "async_scripts");
  markLoadPhase(context, progress, "asyncScriptsMs");
}

interface ClassicAsyncModule {
  default?: { run?: () => unknown };
  run?: () => unknown;
}

async function runClassicAsyncBucket(): Promise<void> {
  try {
    const module = (await importModule("./__ks_user_classic_async.js")) as ClassicAsyncModule;
    const run = classicAsyncBucketRunner(module);
    if (run) await run();
    else reportMissingClassicAsyncRunner(module);
  } catch (error) {
    pushException(error, {
      scriptId: "bundle:classic-async",
      url: "/__ks_user_classic_async.js",
      text: "Uncaught",
    });
    console.error("[kitesurf] classic async bucket threw:", error);
  }
}

function classicAsyncBucketRunner(module: ClassicAsyncModule): (() => unknown) | null {
  const run = (module && module.default && module.default.run) || module.run;
  return typeof run === "function" ? run : null;
}

function reportMissingClassicAsyncRunner(module: ClassicAsyncModule): void {
  console.error("[kitesurf] classic async bucket: no run() export", Object.keys(module || {}));
}

const RESOURCE_WAIT_BUDGET_MS = 25_000;
const RESOURCE_POLL_INTERVAL_MS = 10;
const SUBRESOURCE_INFLIGHT_WAIT_BACKSTOP_MS = 1_000;

interface NavigationResourceDrainState {
  startedAt: number;
  statsAtStart: ReturnType<typeof snapshotFetchStats>;
  quietTurnLimit: number;
  pollCount: number;
  activityWaveCount: number;
  quietTurns: number;
  iframeGateExpired: boolean;
}

interface NavigationResourceActivity {
  hasCriticalResources: boolean;
  hasBlockingSubresources: boolean;
  iframeInstallGatePending: boolean;
}

function createNavigationResourceDrainState(
  context: NavigationContext,
): NavigationResourceDrainState {
  return {
    startedAt: context.nowMs(),
    statsAtStart: snapshotFetchStats(),
    quietTurnLimit: Math.max(1, startupResourceDrainQuietTurns),
    pollCount: 0,
    activityWaveCount: 0,
    quietTurns: 0,
    iframeGateExpired: false,
  };
}

async function drainNavigationResources(
  context: NavigationContext,
  progress: LoadPhaseProgress,
): Promise<void> {
  emitNavigateDiagnostic(context, "start", "resource_drain");
  const drain = createNavigationResourceDrainState(context);
  await waitForNavigationResources(context, drain);
  reportNavigationResourceDrain(context, drain);
  markLoadPhase(context, progress, "resourceDrainMs");
}

async function waitForNavigationResources(
  context: NavigationContext,
  drain: NavigationResourceDrainState,
): Promise<void> {
  while (true) {
    throwIfNavigationSessionClosed();
    const activity = navigationResourceActivity(context, drain);
    if (navigationResourceDrainIsQuietEnough(drain, activity)) break;
    await waitForNavigationResourceDrainTurn(drain, activity);
    if (navigationResourceDrainBudgetExpired(context, drain)) break;
  }
}

function throwIfNavigationSessionClosed(): void {
  if (sessionClosing) throw SESSION_CLOSED_ERROR;
}

function navigationResourceActivity(
  context: NavigationContext,
  drain: NavigationResourceDrainState,
): NavigationResourceActivity {
  const hasCriticalResources = hasNavigationCriticalResources();
  reevaluateDeferredResources();
  return {
    hasCriticalResources,
    hasBlockingSubresources: blockingInflightCount() > 0,
    iframeInstallGatePending: navigationIframeInstallGatePending(context, drain),
  };
}

function reevaluateDeferredResources(): void {
  try {
    reevaluateDeferredUrls();
  } catch {}
}

function navigationIframeInstallGatePending(
  context: NavigationContext,
  drain: NavigationResourceDrainState,
): boolean {
  const pending =
    awaitingIframeInstalls && context.nowMs() - drain.startedAt < IFRAME_INSTALL_WAIT_MS;
  if (shouldReportExpiredIframeGate(pending, drain)) {
    drain.iframeGateExpired = true;
    console.warn(
      "[kitesurf-iframe] load gate expired after " +
        IFRAME_INSTALL_WAIT_MS +
        "ms without an iframeInstallsSettled; `load` was held " +
        "for the full backstop",
    );
  }
  return pending;
}

function shouldReportExpiredIframeGate(
  pending: boolean,
  drain: NavigationResourceDrainState,
): boolean {
  return awaitingIframeInstalls && !pending && !drain.iframeGateExpired;
}

function navigationResourceDrainIsQuietEnough(
  drain: NavigationResourceDrainState,
  activity: NavigationResourceActivity,
): boolean {
  return navigationResourcesAreQuiet(activity) && drain.quietTurns >= drain.quietTurnLimit;
}

function navigationResourcesAreQuiet(activity: NavigationResourceActivity): boolean {
  return (
    !activity.hasCriticalResources &&
    !activity.hasBlockingSubresources &&
    !activity.iframeInstallGatePending
  );
}

async function waitForNavigationResourceDrainTurn(
  drain: NavigationResourceDrainState,
  activity: NavigationResourceActivity,
): Promise<void> {
  if (navigationResourcesAreQuiet(activity)) {
    await waitForQuietNavigationResourceTurn(drain);
    return;
  }
  await waitForActiveNavigationResourceTurn(drain, activity);
}

async function waitForQuietNavigationResourceTurn(
  drain: NavigationResourceDrainState,
): Promise<void> {
  drain.quietTurns++;
  drain.pollCount++;
  await drainSettleMicrotasks();
  try {
    pumpPageTask();
  } catch (error) {
    reportEngineError("runtime", error, "pumpPageTask threw during load settle");
  }
  pumpNavigationResourceMessages();
  if (pageTimerDueWithin(RESOURCE_POLL_INTERVAL_MS)) {
    await NativePromise.race([
      nativeSleep(RESOURCE_POLL_INTERVAL_MS),
      nextTimerTask(),
      sessionClosingSignal,
    ]);
  }
}

function pumpNavigationResourceMessages(): void {
  try {
    (state.dom as { pumpResourceMessages?: () => void } | null)?.pumpResourceMessages?.();
  } catch {}
}

async function waitForActiveNavigationResourceTurn(
  drain: NavigationResourceDrainState,
  activity: NavigationResourceActivity,
): Promise<void> {
  if (drain.quietTurns > 0) drain.activityWaveCount++;
  drain.quietTurns = 0;
  drain.pollCount++;
  if (activity.hasBlockingSubresources) {
    await waitForBlockingNavigationSubresources();
  } else {
    await NativePromise.race([nativeSleep(RESOURCE_POLL_INTERVAL_MS), sessionClosingSignal]);
  }
}

async function waitForBlockingNavigationSubresources(): Promise<void> {
  await NativePromise.race([
    waitForInflightZero(),
    nativeSleep(SUBRESOURCE_INFLIGHT_WAIT_BACKSTOP_MS),
    sessionClosingSignal,
  ]);
}

function navigationResourceDrainBudgetExpired(
  context: NavigationContext,
  drain: NavigationResourceDrainState,
): boolean {
  return context.nowMs() - drain.startedAt > RESOURCE_WAIT_BUDGET_MS;
}

function reportNavigationResourceDrain(
  context: NavigationContext,
  drain: NavigationResourceDrainState,
): void {
  const statsAtEnd = snapshotFetchStats();
  emitNavigateDiagnostic(context, "end", "resource_drain", {
    polls: drain.pollCount,
    waves: drain.activityWaveCount,
    ...expiredIframeGateDiagnostic(drain),
    d_count: statsAtEnd.count - drain.statsAtStart.count,
    d_slot_ms: Math.round(statsAtEnd.slotMs - drain.statsAtStart.slotMs),
    d_fetch_ms: Math.round(statsAtEnd.fetchMs - drain.statsAtStart.fetchMs),
    d_deliver_ms: Math.round(statsAtEnd.deliverMs - drain.statsAtStart.deliverMs),
    max_deliver_ms: Math.round(statsAtEnd.maxDeliverMs),
  });
}

function expiredIframeGateDiagnostic(
  drain: NavigationResourceDrainState,
): Record<string, true> | {} {
  return drain.iframeGateExpired ? { iframe_gate_expired: true } : {};
}

function compileNavigationEventAttributes(): void {
  try {
    const body = (state.document as any)?.body;
    for (const attributeName of navigationEventAttributeNames(body)) {
      compileEventAttribute(body, attributeName);
    }
  } catch {}
}

function navigationEventAttributeNames(body: any): string[] {
  const attributes = body?.attributes;
  if (!attributes) return [];
  return Array.from(attributes as ArrayLike<unknown>, navigationEventAttributeName).filter((name) =>
    name.startsWith("on"),
  );
}

function navigationEventAttributeName(attribute: unknown): string {
  const name = attribute == null ? undefined : Reflect.get(Object(attribute), "name");
  return String(name || "");
}

type NavigationSettleState = [number, number, number];

interface PostLoadSettleProgress {
  passCount: number;
  previousState: NavigationSettleState;
}

function navigationSettleState(): NavigationSettleState {
  return [cascadeSeq() | 0, timersScheduledCount(), blockingInflightCount()];
}

async function settleNavigationAfterLoad(
  context: NavigationContext,
  progress: LoadPhaseProgress,
): Promise<void> {
  const baseline = navigationSettleState();
  dispatchNavigationLoadLifecycleEvents();
  const settleProgress = await runPostLoadSettlePasses(context, baseline);
  recordNavigationSettlePhases(progress, baseline, settleProgress);
  await settleAfterCustomElementUpgrades(settleProgress);
  startNavigationLateSpriteSweep();
  markLoadPhase(context, progress, "postLoadDrainMs");
}

function dispatchNavigationLoadLifecycleEvents(): void {
  state.setReadyState("complete");
  dispatchLifecycle(state.document, "readystatechange", { bubbles: false });
  dispatchLifecycle(state.window, "load", { bubbles: false });
  dispatchLifecycle(state.window, "pageshow", { bubbles: false });
}

async function runPostLoadSettlePasses(
  context: NavigationContext,
  baseline: NavigationSettleState,
): Promise<PostLoadSettleProgress> {
  let passCount = 0;
  let previousState = baseline;
  const startedAt = context.nowMs();
  const SETTLE_BUDGET_MS = 250;
  const MAX_POST_LOAD_SETTLE_PASSES = 3;
  for (let pass = 0; pass < MAX_POST_LOAD_SETTLE_PASSES; pass++) {
    await drainSettleMicrotasks();
    const currentState = navigationSettleState();
    const shouldContinue = shouldContinuePostLoadSettle(
      context,
      startedAt,
      SETTLE_BUDGET_MS,
      pass,
      currentState,
      previousState,
    );
    previousState = currentState;
    if (!shouldContinue) break;
    passCount++;
    await yieldToPageTasks();
  }
  return { passCount, previousState };
}

function shouldContinuePostLoadSettle(
  context: NavigationContext,
  startedAt: number,
  budgetMs: number,
  pass: number,
  current: NavigationSettleState,
  previous: NavigationSettleState,
): boolean {
  const outputMoved = navigationSettleOutputMoved(current, previous);
  const timersMoved = current[1] !== previous[1];
  if (!outputMoved && !timersMoved) return false;
  if (!outputMoved && pass > 0) return false;
  return context.nowMs() - startedAt <= budgetMs;
}

function navigationSettleOutputMoved(
  current: NavigationSettleState,
  previous: NavigationSettleState,
): boolean {
  return current[0] !== previous[0] || current[2] !== previous[2];
}

function recordNavigationSettlePhases(
  progress: LoadPhaseProgress,
  baseline: NavigationSettleState,
  settleProgress: PostLoadSettleProgress,
): void {
  const finalState = navigationSettleState();
  progress.phases.plPasses = settleProgress.passCount;
  progress.phases.plMutations = finalState[0] - baseline[0];
  progress.phases.plTimers = finalState[1] - baseline[1];
  progress.phases.plInflightEnd = finalState[2];
}

async function settleAfterCustomElementUpgrades(progress: PostLoadSettleProgress): Promise<void> {
  try {
    ksGlobal.__ks_drainCustomElementUpgrades?.();
    await drainSettleMicrotasks();
    const currentState = navigationSettleState();
    if (navigationSettleOutputMoved(currentState, progress.previousState)) {
      progress.passCount++;
      await yieldToPageTasks();
    }
    progress.previousState = currentState;
  } catch {}
}

function startNavigationLateSpriteSweep(): void {
  try {
    startLateSpriteSweep();
  } catch {}
}

function queryDomSetFrameContext(
  args: Record<string, unknown> | undefined,
): QueryDomResult<"setFrameContext"> {
  const parentOrigin = String(args?.parentOrigin ?? "");
  getInternalState().frameContext = { parentOrigin };
  return { ok: true } satisfies QueryDomResult<"setFrameContext">;
}

interface MouseDispatchOutcome {
  defaultPrevented: boolean;
  navigateTo: string | null;
  navigatePost: ReturnType<typeof takePendingSubmitNav>;
  hashNavigateTo: string | null;
}

interface MouseEventDispatchInit extends MouseEventInit {
  composed: boolean;
  pageX: number;
  pageY: number;
  movementX: number;
  movementY: number;
}

interface MouseDispatchContext {
  outcome: MouseDispatchOutcome;
  eventType: string;
  clientX: number;
  clientY: number;
  eventInit: MouseEventDispatchInit;
  event: MouseInputEvent;
  targetEl: MouseTarget | null;
  targetChain: MouseTarget[];
  checkableTarget: MouseTarget | null;
  previousCheckedState: boolean | undefined;
  compatibilityMouseAllowed: boolean;
}

function newMouseDispatchOutcome(): MouseDispatchOutcome {
  return {
    defaultPrevented: false,
    navigateTo: null,
    navigatePost: null,
    hashNavigateTo: null,
  };
}

function emptyMouseDispatchReply(): MouseDispatchReply {
  return {
    console: drainConsole(),
    cookieWrites: state.drainCookieWrites(),
    cdpMutations: drainCdpMutations(),
    defaultPrevented: false,
  };
}

function createMouseDispatchContext(
  type: string,
  init: MouseEventInit,
  outcome: MouseDispatchOutcome,
): MouseDispatchContext {
  const eventType = normalizedMouseEventType(type);
  const clientX = mouseCoordinate(init?.clientX);
  const clientY = mouseCoordinate(init?.clientY);
  const previousMousePosition = mousePositionForMovement(eventType);
  const eventInit = createMouseEventDispatchInit(init, clientX, clientY, previousMousePosition);
  updateLastMousePosition(eventType, clientX, clientY);
  return {
    outcome,
    eventType,
    clientX,
    clientY,
    eventInit,
    event: createMouseInputEvent(eventType, eventInit),
    targetEl: null,
    targetChain: [],
    checkableTarget: null,
    previousCheckedState: undefined,
    compatibilityMouseAllowed: true,
  };
}

function normalizedMouseEventType(type: string): string {
  return String(type || "click");
}

function mouseCoordinate(value: MouseEventInit["clientX"] | undefined): number {
  return typeof value === "number" ? value : 0;
}

function mousePositionForMovement(eventType: string): { x: number; y: number } | null {
  return eventType === "mousemove" ? lastMousePosition : null;
}

function createMouseEventDispatchInit(
  init: MouseEventInit,
  clientX: number,
  clientY: number,
  previousMousePosition: { x: number; y: number } | null,
): MouseEventDispatchInit {
  return {
    ...(init || {}),
    composed: true,
    pageX: clientX + state.scrollX,
    pageY: clientY + state.scrollY,
    movementX: mouseMovementDelta(clientX, previousMousePosition?.x),
    movementY: mouseMovementDelta(clientY, previousMousePosition?.y),
  };
}

function mouseMovementDelta(position: number, previous: number | undefined): number {
  return previous === undefined ? 0 : position - previous;
}

function updateLastMousePosition(eventType: string, clientX: number, clientY: number): void {
  if (eventType === "mousemove" || eventType === "mousedown" || eventType === "mouseup") {
    lastMousePosition = { x: clientX, y: clientY };
  }
}

function createMouseInputEvent(
  eventType: string,
  eventInit: MouseEventDispatchInit,
): MouseInputEvent {
  const pointerEventTypes = ["click", "auxclick", "dblclick", "contextmenu"];
  if (eventType === "wheel" && typeof ksEventCtors.WheelEvent === "function") {
    return new ksEventCtors.WheelEvent(eventType, eventInit);
  }
  if (pointerEventTypes.includes(eventType) && typeof ksEventCtors.PointerEvent === "function") {
    return new ksEventCtors.PointerEvent(eventType, {
      ...eventInit,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    });
  }
  return new ksEventCtors.MouseEvent(eventType, eventInit);
}

function dispatchMouseEventBody(context: MouseDispatchContext): void {
  selectMouseEventTarget(context);
  updateMouseRangeDrag(context);
  prepareCheckableMouseTarget(context);
  dispatchPointerAndMouseEvents(context);
  focusTargetAfterMouseDown(context);
  updateMouseCaret(context);
  startMouseRangeDrag(context);
  dispatchMouseWheelScroll(context);
  finishCheckableMouseTarget(context);
  activateMouseClickTarget(context);
}

function selectMouseEventTarget(context: MouseDispatchContext): void {
  context.targetEl = mouseEventTargetAtPoint(context);
  repairDisconnectedMouseOverTarget(context.eventInit);
  context.targetChain = __ksAncestorChain(context.targetEl);
  updateMouseOverTarget(context);
  reconnectMouseEventTarget(context);
  rememberMouseDownOrClickTarget(context);
}

function mouseEventTargetAtPoint(context: MouseDispatchContext): MouseTarget | null {
  return (
    mouseTargetAtPoint(context.eventType, context.clientX, context.clientY, context.event) ||
    mouseDocumentFallbackTarget()
  );
}

function mouseDocumentFallbackTarget(): MouseTarget | null {
  return state.document?.body || state.document?.documentElement || state.document;
}

function repairDisconnectedMouseOverTarget(eventInit: MouseEventDispatchInit): void {
  if (!__ksOverTarget || __ksIsConnected(__ksOverTarget)) return;
  const recomputed = __ksFirstConnected(__ksOverChain);
  __ksSetOverTarget(recomputed);
  __ksFireBoundaryEvent(recomputed, "pointerover", null, true, eventInit);
  __ksFireBoundaryEvent(recomputed, "mouseover", null, true, eventInit);
}

function updateMouseOverTarget(context: MouseDispatchContext): void {
  if (context.eventType !== "mousemove" || __ksOverTarget === context.targetEl) return;
  const from = __ksOverTarget;
  __ksSetOverTarget(context.targetEl, context.targetChain);
  __ksDispatchBoundaryEvents(from, context.targetEl, context.eventInit);
}

function reconnectMouseEventTarget(context: MouseDispatchContext): void {
  if (!context.targetEl || __ksIsConnected(context.targetEl)) return;
  const reconnected: MouseTarget | null = __ksFirstConnected(context.targetChain);
  if (!reconnected) return;
  context.targetEl = reconnected;
  if (context.eventType === "mousemove") __ksSetOverTarget(reconnected);
}

function rememberMouseDownOrClickTarget(context: MouseDispatchContext): void {
  if (context.eventType === "mousedown") {
    __ksMouseDownTarget = context.targetEl;
    return;
  }
  if (!shouldRetargetMouseClick(context)) return;
  const common: MouseTarget | null = __ksCommonAncestor(__ksMouseDownTarget, context.targetEl);
  if (common) context.targetEl = common;
}

function shouldRetargetMouseClick(context: MouseDispatchContext): boolean {
  return (
    isMouseClickType(context.eventType) &&
    Boolean(__ksMouseDownTarget) &&
    __ksMouseDownTarget !== context.targetEl
  );
}

function isMouseClickType(eventType: string): boolean {
  return eventType === "click" || eventType === "dblclick" || eventType === "auxclick";
}

function updateMouseRangeDrag(context: MouseDispatchContext): void {
  const rangeDrag = currentRangeInputDrag();
  if (!rangeDrag) return;
  if (context.eventType === "mousemove") {
    if (applyRangeInputFromX(rangeDrag.el, context.clientX)) rangeDrag.changed = true;
    return;
  }
  if (context.eventType === "mouseup") finishRangeInputDrag(rangeDrag, context.clientX);
}

function currentRangeInputDrag(): { el: any; changed: boolean } | null {
  return __ksRangeDrag && __ksRangeDrag.el ? __ksRangeDrag : null;
}

function finishRangeInputDrag(rangeDrag: { el: any; changed: boolean }, clientX: number): void {
  if (applyRangeInputFromX(rangeDrag.el, clientX)) rangeDrag.changed = true;
  if (rangeDrag.changed) dispatchRangeInputChange(rangeDrag.el);
  __ksRangeDrag = null;
}

function dispatchRangeInputChange(element: MouseTarget): void {
  try {
    __ks_dispatchTrusted(
      element,
      new ksEventCtors.Event("change", { bubbles: true, cancelable: false }),
    );
  } catch {}
}

function isRangeInput(element: MouseTarget | null): element is MouseTarget {
  if (!element || element.tagName !== "INPUT" || typeof element.getAttribute !== "function") {
    return false;
  }
  return (element.getAttribute("type") || "").toLowerCase() === "range";
}

function applyRangeInputFromX(element: MouseTarget, clientX: number): boolean {
  try {
    const rect = element.getBoundingClientRect?.();
    if (!rect || !(rect.width > 0)) return false;
    return setRangeInputValue(element, rangeInputValueAtX(element, rect, clientX));
  } catch {
    return false;
  }
}

function rangeInputValueAtX(
  element: MouseTarget,
  rect: NonNullable<ReturnType<NonNullable<MouseTarget["getBoundingClientRect"]>>>,
  clientX: number,
): string {
  const DEFAULT_RANGE_INPUT_MAX = 100;
  const RANGE_INPUT_THUMB_MIN_RADIUS_PX = 2;
  const RANGE_INPUT_THUMB_HEIGHT_FRACTION = 0.5;
  const RANGE_INPUT_THUMB_WIDTH_FRACTION = 0.25;
  const RANGE_INPUT_THUMB_RADIUS_FACTOR = 0.8;
  const RANGE_INPUT_MIN_TRACK_TRAVEL_PX = 1;
  const min = parseFloat(rangeInputAttribute(element, "min")) || 0;
  const maxRaw = parseFloat(rangeInputAttribute(element, "max"));
  const max = Math.max(min, Number.isFinite(maxRaw) ? maxRaw : DEFAULT_RANGE_INPUT_MAX);
  const step = rangeInputStep(rangeInputAttribute(element, "step"));
  const thumbRadius =
    Math.max(
      RANGE_INPUT_THUMB_MIN_RADIUS_PX,
      Math.min(
        rect.height * RANGE_INPUT_THUMB_HEIGHT_FRACTION,
        rect.width * RANGE_INPUT_THUMB_WIDTH_FRACTION,
      ),
    ) * RANGE_INPUT_THUMB_RADIUS_FACTOR;
  const travel = Math.max(RANGE_INPUT_MIN_TRACK_TRAVEL_PX, rect.width - 2 * thumbRadius);
  const fraction = Math.min(1, Math.max(0, (clientX - rect.left - thumbRadius) / travel));
  let raw = min + fraction * (max - min);
  if (step > 0) raw = min + Math.round((raw - min) / step) * step;
  raw = Math.min(max, Math.max(min, raw));
  return String(raw);
}

function rangeInputAttribute(element: MouseTarget, name: string): string {
  const getter = element.getAttribute;
  if (typeof getter !== "function") throw new TypeError("range input has no getAttribute");
  return getter.call(element, name) ?? "";
}

function rangeInputStep(stepAttr: string): number {
  if (stepAttr === "any") return 0;
  const step = parseFloat(stepAttr);
  return Number.isFinite(step) && step > 0 ? step : 1;
}

function setRangeInputValue(element: MouseTarget, next: string): boolean {
  if (getValueRawOnControl(element) === next) return false;
  setValueRawOnControl(element, next);
  try {
    __ks_dispatchTrusted(
      element,
      new ksEventCtors.InputEvent("input", { bubbles: true, cancelable: false }),
    );
  } catch {}
  return true;
}

function prepareCheckableMouseTarget(context: MouseDispatchContext): void {
  const target = checkableMouseTarget(context);
  if (!target) return;
  context.checkableTarget = target;
  context.previousCheckedState = !!target.checked;
  const nextCheckedState = isCheckboxInput(target) ? !context.previousCheckedState : true;
  setCheckedRaw(target, nextCheckedState);
}

function checkableMouseTarget(context: MouseDispatchContext): MouseTarget | null {
  const target = context.targetEl;
  if (!isClickedMouseInput(context, target)) return null;
  const type = (target.type || "").toLowerCase();
  return isCheckableInputType(type) ? target : null;
}

function isClickedMouseInput(
  context: MouseDispatchContext,
  target: MouseTarget | null,
): target is MouseTarget {
  return context.eventType === "click" && target !== null && target.tagName === "INPUT";
}

function isCheckableInputType(type: string): boolean {
  return type === "checkbox" || type === "radio";
}

function isCheckboxInput(element: MouseTarget): boolean {
  return (element.type || "").toLowerCase() === "checkbox";
}

function setCheckedRaw(element: MouseTarget, value: boolean | undefined): void {
  let prototype = Object.getPrototypeOf(element);
  while (prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "checked");
    if (descriptor && typeof descriptor.set === "function") {
      descriptor.set.call(element, value);
      return;
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  element.checked = value;
}

function dispatchPointerAndMouseEvents(context: MouseDispatchContext): void {
  dispatchMousePointerEvents(context);
  const allowed = context.compatibilityMouseAllowed
    ? __ks_dispatchTrusted(context.targetEl, context.event)
    : true;
  if (context.compatibilityMouseAllowed || context.eventType !== "mousedown") {
    context.outcome.defaultPrevented = !allowed;
  }
}

function dispatchMousePointerEvents(context: MouseDispatchContext): void {
  if (context.eventType === "mousedown") {
    __ksPointerDownCanceled = false;
    __ksPointerDownCanceled = !dispatchMousePointerEvent(context, "pointerdown");
    context.compatibilityMouseAllowed = !__ksPointerDownCanceled;
    context.outcome.defaultPrevented = !context.compatibilityMouseAllowed;
  } else if (context.eventType === "mousemove") {
    dispatchMousePointerEvent(context, "pointermove");
    context.compatibilityMouseAllowed = !__ksPointerDownCanceled;
  } else if (context.eventType === "mouseup") {
    dispatchMousePointerEvent(context, "pointerup");
    resetPointerCancellationAfterMouseUp(context);
  }
}

function resetPointerCancellationAfterMouseUp(context: MouseDispatchContext): void {
  if (!__ksPointerDownCanceled) return;
  context.compatibilityMouseAllowed = false;
  __ksPointerDownCanceled = false;
}

function dispatchMousePointerEvent(context: MouseDispatchContext, eventType: string): boolean {
  if (typeof ksEventCtors.PointerEvent !== "function") return true;
  const pointerInit = {
    ...context.eventInit,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  };
  const coalescedEvents =
    eventType === "pointermove"
      ? [new ksEventCtors.PointerEvent(eventType, pointerInit)]
      : undefined;
  return __ks_dispatchTrusted(
    context.targetEl,
    new ksEventCtors.PointerEvent(eventType, { ...pointerInit, coalescedEvents }),
  );
}

function focusTargetAfterMouseDown(context: MouseDispatchContext): void {
  if (shouldFocusAfterMouseDown(context)) focusMouseTarget(context.targetEl);
}

function shouldFocusAfterMouseDown(context: MouseDispatchContext): boolean {
  return context.eventType === "mousedown" && !context.outcome.defaultPrevented;
}

function focusMouseTarget(target: MouseTarget | null): void {
  const focusable = findFocusableAncestor(target);
  if (!focusable || typeof focusable.focus !== "function") {
    blurActiveDocumentElement();
    return;
  }
  try {
    focusable.focus();
  } catch {}
}

function blurActiveDocumentElement(): void {
  const activeElement = state.document?.activeElement;
  if (!activeElement || typeof activeElement.blur !== "function") return;
  try {
    activeElement.blur();
  } catch {}
}

function updateMouseCaret(context: MouseDispatchContext): void {
  if (shouldUpdateMouseCaret(context)) {
    updateCaretFromMouse(
      context.eventType,
      context.event,
      context.targetEl,
      context.clientX,
      context.clientY,
    );
  }
  clearMouseCaretAfterMouseUp(context.eventType);
}

function shouldUpdateMouseCaret(context: MouseDispatchContext): boolean {
  return isUnpreventedMouseDown(context) || isActiveMouseCaretDrag(context);
}

function isUnpreventedMouseDown(context: MouseDispatchContext): boolean {
  return context.eventType === "mousedown" && !context.outcome.defaultPrevented;
}

function isActiveMouseCaretDrag(context: MouseDispatchContext): boolean {
  return (
    context.eventType === "mousemove" && __ksCaretDragActive && (context.event.buttons & 1) === 1
  );
}

function clearMouseCaretAfterMouseUp(eventType: string): void {
  if (eventType === "mouseup") resetMouseCaretState();
}

function resetMouseCaretState(): void {
  __ksCaretDragActive = false;
  __ksControlCaretAnchor = null;
  __ksCaretDragOrigin = null;
}

function startMouseRangeDrag(context: MouseDispatchContext): void {
  if (!shouldStartMouseRangeDrag(context)) return;
  const target = context.targetEl;
  if (!target) return;
  __ksRangeDrag = { el: target, changed: false };
  if (applyRangeInputFromX(target, context.clientX)) __ksRangeDrag.changed = true;
}

function shouldStartMouseRangeDrag(context: MouseDispatchContext): boolean {
  return (
    context.eventType === "mousedown" &&
    !context.outcome.defaultPrevented &&
    isRangeInput(context.targetEl) &&
    !context.targetEl.disabled
  );
}

function dispatchMouseWheelScroll(context: MouseDispatchContext): void {
  if (!shouldApplyMouseWheelScroll(context)) return;
  const delta = mouseWheelDelta(context.event);
  if (!tryScrollWithWheelBridge(context.targetEl, delta.x, delta.y)) scrollByFallback(delta);
}

function shouldApplyMouseWheelScroll(context: MouseDispatchContext): boolean {
  return context.eventType === "wheel" && !context.outcome.defaultPrevented;
}

function mouseWheelDelta(event: MouseInputEvent): { x: number; y: number } {
  return { x: event.deltaX || 0, y: event.deltaY || 0 };
}

function scrollByFallback(delta: { x: number; y: number }): void {
  try {
    scrollBy(delta.x, delta.y);
  } catch {}
}

function tryScrollWithWheelBridge(
  target: MouseTarget | null,
  deltaX: number,
  deltaY: number,
): boolean {
  const wheelBridge = ksGlobal.__ks_scrollByWheel;
  if (typeof wheelBridge !== "function" || !target || typeof target._id !== "number") return false;
  try {
    wheelBridge(target._id, deltaX, deltaY);
    return true;
  } catch {
    return false;
  }
}

function finishCheckableMouseTarget(context: MouseDispatchContext): void {
  const target = context.checkableTarget;
  if (!target) return;
  if (context.outcome.defaultPrevented) {
    setCheckedRaw(target, context.previousCheckedState);
    return;
  }
  dispatchCheckableMouseEvents(target);
}

function dispatchCheckableMouseEvents(target: MouseTarget): void {
  try {
    __ks_dispatchTrusted(
      target,
      new ksEventCtors.InputEvent("input", { bubbles: true, cancelable: false }),
    );
  } catch {}
  try {
    __ks_dispatchTrusted(
      target,
      new ksEventCtors.Event("change", { bubbles: true, cancelable: false }),
    );
  } catch {}
}

function activateMouseClickTarget(context: MouseDispatchContext): void {
  activateMouseButton(context);
  activateMouseLabel(context);
  toggleMouseSelectDropdown(context);
  toggleMouseDetails(context);
  activateMouseAnchor(context);
}

function successfulMouseClickTarget(context: MouseDispatchContext): MouseTarget | null {
  if (context.eventType !== "click" || context.outcome.defaultPrevented) return null;
  return context.targetEl;
}

function activateMouseButton(context: MouseDispatchContext): void {
  const target = successfulMouseClickTarget(context);
  if (!target) return;
  try {
    const navigation = buttonActivationNavigation(target);
    if (navigation) context.outcome.navigateTo = navigation;
  } catch (error) {
    console.error("[kitesurf] button activation failed", error);
  }
}

function activateMouseLabel(context: MouseDispatchContext): void {
  const target = successfulMouseClickTarget(context);
  if (!target) return;
  // CDP clicks bypass Element.click(); the shim owns forwarding without exposing a page-global
  // hook or trusting a page-provided isTrusted property.
  try {
    __ks_activateLabel?.(target, context.event);
  } catch (error) {
    console.error("[kitesurf] label activation failed", error);
  }
}

function toggleMouseSelectDropdown(context: MouseDispatchContext): void {
  const target = successfulMouseClickTarget(context);
  if (!target) return;
  try {
    const select = selectAncestorForMouseTarget(target);
    const toggle = ksGlobal.__ksSelectDropdownToggle;
    if (select && typeof toggle === "function") toggle(select);
  } catch (error) {
    console.error("[kitesurf] select dropdown toggle failed", error);
  }
}

function selectAncestorForMouseTarget(target: MouseTarget): MouseTarget | null {
  let current: MouseTarget | null | undefined = target;
  while (isNonSelectMouseAncestor(current)) {
    current = current.parentNode;
  }
  return current ?? null;
}

function isNonSelectMouseAncestor(current: MouseTarget | null | undefined): current is MouseTarget {
  return Boolean(
    current && current !== state.document && (current.tagName || "").toUpperCase() !== "SELECT",
  );
}

function toggleMouseDetails(context: MouseDispatchContext): void {
  const target = successfulMouseClickTarget(context);
  if (!target) return;
  try {
    toggleDetailsFromSummary(target);
  } catch (error) {
    console.error("[kitesurf] details toggle failed", error);
  }
}

function activateMouseAnchor(context: MouseDispatchContext): void {
  const target = successfulMouseClickTarget(context);
  if (!target || target === state.document) return;
  const navigation = activateAnchorNavigation(target, context.clientX, context.clientY);
  applyMouseAnchorNavigation(context, navigation);
}

function applyMouseAnchorNavigation(
  context: MouseDispatchContext,
  navigation: ReturnType<typeof activateAnchorNavigation>,
): void {
  if (!navigation) return;
  if (navigation.kind === "hash") {
    context.outcome.hashNavigateTo = navigation.url;
  } else if (navigation.kind === "navigate") {
    context.outcome.navigateTo = navigation.url;
  }
}

function applyPendingMouseNavigation(outcome: MouseDispatchOutcome): void {
  const navigation = takePendingSubmitNav();
  if (!navigation || typeof navigation.url !== "string") return;
  if (typeof navigation.postData === "string") {
    outcome.navigatePost = navigation;
  } else if (!outcome.navigateTo) {
    outcome.navigateTo = navigation.url;
  }
}

function mouseDispatchReply(outcome: MouseDispatchOutcome): MouseDispatchReply {
  return {
    console: drainConsole(),
    cookieWrites: state.drainCookieWrites(),
    cdpMutations: drainCdpMutations(),
    defaultPrevented: outcome.defaultPrevented,
    navigateTo: outcome.navigateTo,
    navigatePost: outcome.navigatePost,
    hashNavigateTo: outcome.hashNavigateTo,
  };
}

type KeyEventConstructor = BuildDocumentResult["Event"] | BuildDocumentResult["KeyboardEvent"];

interface KeyDispatchOutcome {
  defaultPrevented: boolean;
  navigateTo: string | null;
  navigatePost: ReturnType<typeof takePendingSubmitNav>;
}

interface KeyDispatchContext {
  outcome: KeyDispatchOutcome;
  eventType: string;
  init: KeyEventInit;
  eventConstructor: KeyEventConstructor;
  event: unknown;
  focused: ShimElement | null;
  targetEl: ShimElement | NonNullable<typeof state.document> | null;
}

interface TextControlEdit {
  oldValue: string;
  newValue: string;
  nextCursor: number;
}

function emptyKeyDispatchReply(defaultPrevented: boolean): KeyDispatchReply {
  return {
    console: drainConsole(),
    cookieWrites: state.drainCookieWrites(),
    cdpMutations: drainCdpMutations(),
    defaultPrevented,
  };
}

function keyboardEventConstructor(): KeyEventConstructor {
  return ksEventCtors.KeyboardEvent || ksEventCtors.Event;
}

function earlyKeyDispatchReply(
  type: string,
  eventConstructor: KeyEventConstructor,
): KeyDispatchReply | null {
  if (!canDispatchKeyboardEvent(eventConstructor)) return emptyKeyDispatchReply(false);
  return keyboardSuppressionReply(type);
}

function canDispatchKeyboardEvent(eventConstructor: KeyEventConstructor): boolean {
  return Boolean(state.document) && typeof eventConstructor === "function";
}

function keyboardSuppressionReply(type: string): KeyDispatchReply | null {
  if (type === "keydown") __ksSuppressChar = false;
  if (type === "keypress" && __ksSuppressChar) return emptyKeyDispatchReply(true);
  return null;
}

function newKeyDispatchOutcome(): KeyDispatchOutcome {
  return { defaultPrevented: false, navigateTo: null, navigatePost: null };
}

function createKeyboardDispatchContext(
  type: string,
  init: KeyEventInit,
  eventConstructor: KeyEventConstructor,
  outcome: KeyDispatchOutcome,
): KeyDispatchContext {
  const eventType = String(type || "keydown");
  const event = new eventConstructor(eventType, { ...(init || {}), composed: true });
  const focused = state.getActiveElement();
  const document = state.document;
  const targetEl = keyboardDispatchTarget(focused, document);
  return { outcome, eventType, init, eventConstructor, event, focused, targetEl };
}

function keyboardDispatchTarget(
  focused: ShimElement | null,
  document: typeof state.document,
): ShimElement | NonNullable<typeof state.document> | null {
  if (focused) return focused;
  return keyboardDocumentFallbackTarget(document);
}

function keyboardDocumentFallbackTarget(
  document: typeof state.document,
): ShimElement | NonNullable<typeof state.document> | null {
  return document?.body || document?.documentElement || document;
}

function dispatchKeyboardEventBody(context: KeyDispatchContext): void {
  dispatchPrimaryKeyboardEvent(context);
  moveTabFocusForKeyboard(context);
  scrollPageForKeyboard(context);
  activateKeyboardTarget(context);
  applyKeyboardContentEditableInput(context);
  applyKeyboardTextControlInput(context);
}

function dispatchPrimaryKeyboardEvent(context: KeyDispatchContext): void {
  const allowed = __ks_dispatchTrusted(context.targetEl, context.event);
  context.outcome.defaultPrevented = !allowed;
  if (context.eventType === "keydown" && context.outcome.defaultPrevented) {
    __ksSuppressChar = true;
  }
}

function moveTabFocusForKeyboard(context: KeyDispatchContext): void {
  if (!isUnmodifiedTabKey(context) || context.outcome.defaultPrevented) return;
  moveTabFocus(!!context.init.shiftKey);
}

function isUnmodifiedTabKey(context: KeyDispatchContext): boolean {
  return (
    context.eventType === "keydown" &&
    context.init?.key === "Tab" &&
    keyboardModifiersUnpressed(context.init)
  );
}

function keyboardModifiersUnpressed(init: KeyEventInit): boolean {
  return !init.altKey && !init.ctrlKey && !init.metaKey;
}

function scrollPageForKeyboard(context: KeyDispatchContext): void {
  if (context.eventType !== "keydown" || context.outcome.defaultPrevented) return;
  scrollForKey(context.init?.key || "", context.init);
}

function activateKeyboardTarget(context: KeyDispatchContext): void {
  const keyName = keyboardKeyName(context.init);
  const isSpace = isSpaceKey(keyName);
  armSpaceKeyboardTarget(context, isSpace);
  const activateNow = shouldActivateKeyboardTarget(context, keyName, isSpace);
  clearReleasedSpaceKeyboardTarget(context, isSpace);
  if (activateNow) clickKeyboardTarget(context.focused);
}

function keyboardKeyName(init: KeyEventInit): string {
  return init && typeof init.key === "string" ? init.key : "";
}

function isSpaceKey(keyName: string): boolean {
  return keyName === " " || keyName === "Spacebar";
}

function armSpaceKeyboardTarget(context: KeyDispatchContext, isSpace: boolean): void {
  if (context.eventType !== "keydown") return;
  if (!isSpace) return;
  __ksSpaceArmedTarget = spaceKeyboardTarget(context.focused, context.outcome.defaultPrevented);
}

function spaceKeyboardTarget(
  focused: ShimElement | null,
  defaultPrevented: boolean,
): ShimElement | null {
  if (defaultPrevented || !focused) return null;
  return isKeyboardActivatable(focused) ? focused : null;
}

function shouldActivateKeyboardTarget(
  context: KeyDispatchContext,
  keyName: string,
  isSpace: boolean,
): boolean {
  const focused = context.focused;
  if (context.outcome.defaultPrevented || !focused) return false;
  return (
    isEnterKeyboardActivation(context, keyName, focused) ||
    isArmedSpaceKeyboardActivation(context, isSpace, focused)
  );
}

function isEnterKeyboardActivation(
  context: KeyDispatchContext,
  keyName: string,
  focused: ShimElement,
): boolean {
  return context.eventType === "keydown" && keyName === "Enter" && isKeyboardActivatable(focused);
}

function isArmedSpaceKeyboardActivation(
  context: KeyDispatchContext,
  isSpace: boolean,
  focused: ShimElement,
): boolean {
  return context.eventType === "keyup" && isSpace && __ksSpaceArmedTarget === focused;
}

function clearReleasedSpaceKeyboardTarget(context: KeyDispatchContext, isSpace: boolean): void {
  if (context.eventType === "keyup" && isSpace) __ksSpaceArmedTarget = null;
}

function clickKeyboardTarget(focused: ShimElement | null): void {
  if (!focused) return;
  try {
    focused.click?.();
  } catch {}
}

function isKeyboardCharacterEvent(eventType: string): boolean {
  return eventType === "keydown" || eventType === "keypress";
}

function applyKeyboardContentEditableInput(context: KeyDispatchContext): void {
  const editHost = context.outcome.defaultPrevented ? null : editingHostOf(context.focused);
  if (editHost) dispatchKeyboardContentEditableInput(context, editHost);
}

function dispatchKeyboardContentEditableInput(
  context: KeyDispatchContext,
  editHost: ShimElement,
): void {
  const key = keyboardKeyName(context.init);
  if (isContentEditableDeleteKey(context, key)) {
    deleteKeyboardContentEditable(editHost, key);
    return;
  }
  if (shouldInsertContentEditableText(context)) {
    insertKeyboardContentEditableText(context, editHost);
  }
}

function isContentEditableDeleteKey(context: KeyDispatchContext, key: string): boolean {
  return context.eventType === "keydown" && (key === "Backspace" || key === "Delete");
}

function deleteKeyboardContentEditable(editHost: ShimElement, key: string): void {
  editContentEditable(
    editHost,
    key === "Backspace" ? "deleteContentBackward" : "deleteContentForward",
    null,
    __ks_dispatchTrusted,
  );
}

function shouldInsertContentEditableText(context: KeyDispatchContext): boolean {
  return (
    isKeyboardCharacterEvent(context.eventType) &&
    typeof context.init.text === "string" &&
    Boolean(context.init.text) &&
    !context.init.ctrlKey &&
    !context.init.metaKey
  );
}

function insertKeyboardContentEditableText(
  context: KeyDispatchContext,
  editHost: ShimElement,
): void {
  if (!dispatchKeyboardKeypressIfNeeded(context)) {
    context.outcome.defaultPrevented = true;
    return;
  }
  insertTypedContentEditableText(context, editHost);
}

function insertTypedContentEditableText(context: KeyDispatchContext, editHost: ShimElement): void {
  const text = context.init.text;
  if (text === "\r" || text === "\n") {
    editContentEditable(
      editHost,
      context.init.shiftKey ? "insertLineBreak" : "insertParagraph",
      null,
      __ks_dispatchTrusted,
    );
    return;
  }
  if (!hasControlChar(text)) {
    editContentEditable(editHost, "insertText", text, __ks_dispatchTrusted);
  }
}

function dispatchKeyboardKeypressIfNeeded(context: KeyDispatchContext): boolean {
  if (context.eventType !== "keydown") return true;
  const keypress = new context.eventConstructor("keypress", { ...context.init, composed: true });
  return __ks_dispatchTrusted(context.targetEl, keypress);
}

function applyKeyboardTextControlInput(context: KeyDispatchContext): void {
  const focused = context.focused;
  if (
    !focused ||
    context.outcome.defaultPrevented ||
    !isKeyboardCharacterEvent(context.eventType)
  ) {
    return;
  }
  if (!isKeyboardTextControl(focused)) return;
  const edit = computeKeyboardTextControlEdit(context, focused);
  applyKeyboardTextControlEdit(context, focused, edit);
  submitKeyboardTextControl(context, focused);
}

function isKeyboardTextControl(element: ShimElement): boolean {
  return element.tagName === "INPUT" || element.tagName === "TEXTAREA";
}

function computeKeyboardTextControlEdit(
  context: KeyDispatchContext,
  element: ShimElement,
): TextControlEdit {
  const oldValue = getValueRawOnControl(element);
  const selection = textControlSelection(element, oldValue.length);
  const text = typeof context.init.text === "string" ? context.init.text : "";
  const key = keyboardKeyName(context.init);
  const inserted = insertKeyboardTextControlValue(oldValue, text, selection);
  if (inserted) return { oldValue, ...inserted };
  const deleted = deleteKeyboardTextControlValue(context, oldValue, key, selection);
  return {
    oldValue,
    ...(deleted ?? { newValue: oldValue, nextCursor: selection.start }),
  };
}

function textControlSelection(
  element: ShimElement,
  oldLength: number,
): { start: number; end: number } {
  const rawStart = typeof element.selectionStart === "number" ? element.selectionStart : oldLength;
  const rawEnd = typeof element.selectionEnd === "number" ? element.selectionEnd : rawStart;
  const start = Math.max(0, Math.min(rawStart, oldLength));
  return { start, end: Math.max(start, Math.min(rawEnd, oldLength)) };
}

function insertKeyboardTextControlValue(
  oldValue: string,
  text: string,
  selection: { start: number; end: number },
): { newValue: string; nextCursor: number } | null {
  if (text.length === 0 || hasControlChar(text)) return null;
  return {
    newValue: oldValue.slice(0, selection.start) + text + oldValue.slice(selection.end),
    nextCursor: selection.start + text.length,
  };
}

function deleteKeyboardTextControlValue(
  context: KeyDispatchContext,
  oldValue: string,
  key: string,
  selection: { start: number; end: number },
): { newValue: string; nextCursor: number } | null {
  if (context.eventType !== "keydown" || !isTextDeletionKey(key)) return null;
  if (selection.start !== selection.end) {
    return {
      newValue: oldValue.slice(0, selection.start) + oldValue.slice(selection.end),
      nextCursor: selection.start,
    };
  }
  if (key === "Backspace") return deleteTextControlCodePointBefore(oldValue, selection.start);
  return deleteTextControlCodePointAt(oldValue, selection.start);
}

function isTextDeletionKey(key: string): boolean {
  return key === "Backspace" || key === "Delete";
}

function deleteTextControlCodePointBefore(
  value: string,
  selectionStart: number,
): { newValue: string; nextCursor: number } {
  if (selectionStart === 0) return { newValue: value, nextCursor: selectionStart };
  const previous = selectionStart - 1;
  const deleteStart = startsSurrogatePairAt(value, previous) ? previous - 1 : previous;
  return {
    newValue: value.slice(0, deleteStart) + value.slice(selectionStart),
    nextCursor: deleteStart,
  };
}

function deleteTextControlCodePointAt(
  value: string,
  selectionStart: number,
): { newValue: string; nextCursor: number } {
  if (selectionStart >= value.length) return { newValue: value, nextCursor: selectionStart };
  const deleteEnd = endsSurrogatePairAt(value, selectionStart)
    ? selectionStart + 2
    : selectionStart + 1;
  return {
    newValue: value.slice(0, selectionStart) + value.slice(deleteEnd),
    nextCursor: selectionStart,
  };
}

const HIGH_SURROGATE_START_CODE_UNIT = 0xd800;
const HIGH_SURROGATE_END_CODE_UNIT = 0xdbff;
const LOW_SURROGATE_START_CODE_UNIT = 0xdc00;
const LOW_SURROGATE_END_CODE_UNIT = 0xdfff;

function startsSurrogatePairAt(value: string, lowIndex: number): boolean {
  return (
    lowIndex > 0 &&
    isLowSurrogateCodeUnit(value.charCodeAt(lowIndex)) &&
    isHighSurrogateCodeUnit(value.charCodeAt(lowIndex - 1))
  );
}

function endsSurrogatePairAt(value: string, highIndex: number): boolean {
  const lowIndex = highIndex + 1;
  return (
    isHighSurrogateCodeUnit(value.charCodeAt(highIndex)) &&
    lowIndex < value.length &&
    isLowSurrogateCodeUnit(value.charCodeAt(lowIndex))
  );
}

function isHighSurrogateCodeUnit(unit: number): boolean {
  return unit >= HIGH_SURROGATE_START_CODE_UNIT && unit <= HIGH_SURROGATE_END_CODE_UNIT;
}

function isLowSurrogateCodeUnit(unit: number): boolean {
  return unit >= LOW_SURROGATE_START_CODE_UNIT && unit <= LOW_SURROGATE_END_CODE_UNIT;
}

function applyKeyboardTextControlEdit(
  context: KeyDispatchContext,
  element: ShimElement,
  edit: TextControlEdit,
): void {
  if (edit.newValue === edit.oldValue) return;
  setValueRawOnControl(element, edit.newValue);
  notifyControlValueMutation(element, edit.nextCursor, context.eventConstructor);
}

function submitKeyboardTextControl(context: KeyDispatchContext, element: ShimElement): void {
  if (context.eventType !== "keydown" || keyboardKeyName(context.init) !== "Enter") return;
  if (element.tagName !== "INPUT") return;
  dispatchEnterChange(element, context.eventConstructor);
  const implicitNavigation = submitFormOnEnter(element);
  if (implicitNavigation) context.outcome.navigateTo = implicitNavigation;
}

function applyPendingKeyNavigation(outcome: KeyDispatchOutcome): void {
  const navigation = takePendingSubmitNav();
  if (!navigation || typeof navigation.url !== "string") return;
  if (typeof navigation.postData === "string") {
    outcome.navigatePost = navigation;
  } else if (!outcome.navigateTo) {
    outcome.navigateTo = navigation.url;
  }
}

function keyDispatchReply(outcome: KeyDispatchOutcome): KeyDispatchReply {
  return {
    console: drainConsole(),
    cookieWrites: state.drainCookieWrites(),
    cdpMutations: drainCdpMutations(),
    defaultPrevented: outcome.defaultPrevented,
    navigateTo: outcome.navigateTo,
    navigatePost: outcome.navigatePost,
  };
}

async function queryDomWithDocument(
  pageState: QueryDomActiveState,
  method: QueryDomMethod,
  queryArgs: Record<string, unknown>,
): Promise<QueryDomResult<QueryDomMethod>> {
  switch (method) {
    case "getDocument":
    case "nodeSubtree":
    case "getOuterHTMLAndSeq":
      return queryDomDocumentRead(pageState, method, queryArgs);
    case "getOuterHTML":
      return queryDomOuterHTML(pageState, queryArgs);
    case "querySelector":
    case "querySelectorAll":
    case "matchSelectorList":
      return queryDomSelectorRead(pageState, method, queryArgs);
    case "getAncestorElementIds":
      return queryDomAncestorElementIds(pageState, queryArgs);
    case "parseStyleSheet":
      return queryDomParseStylesheet(queryArgs);
    case "enumerateStyleSheets":
      return queryDomEnumerateStyleSheets(pageState);
    case "getSceneStats":
      return queryDomSceneStats();
    case "pumpTasks":
      return queryDomPumpTasks(queryArgs);
    case "recordScene":
      return queryDomRecordScene(pageState, queryArgs);
    case "getFontUrlData":
      return queryDomGetFontUrlData(queryArgs);
    case "getPaintResources":
      return queryDomGetPaintResources(pageState, queryArgs);
    case "recordPdfScenes":
      return queryDomRecordPdfScenes(queryArgs);
    case "getComputedStyle":
    case "getRect":
    case "elementFromPoint":
      return queryDomPaintGeometry(method, queryArgs);
    case "notRenderedNodeIds":
      return queryDomNotRenderedNodeIds(queryArgs);
    case "formStateSnapshot":
    case "setControlValueAsUser":
      return queryDomFormState(pageState, method, queryArgs);
    case "setViewport":
      return queryDomSetViewport(pageState, queryArgs);
    case "setMediaType":
      return queryDomSetMediaType(pageState, queryArgs);
    case "setSuppressBackgrounds":
      return queryDomSetSuppressBackgrounds(queryArgs);
    case "awaitPendingResources":
      return await queryDomAwaitPendingResources(pageState, queryArgs);
    case "pageBoxJson":
    case "setLayoutMode":
    case "getLayoutMode":
    case "setCdpDomActive":
      return queryDomLayoutSettings(pageState, method, queryArgs);
    case "layoutMetrics": {
      // One layout walk for both axes; documentScrollSize falls back to
      // the viewport when there is no paint DOM.
      const content = documentScrollSize();
      return {
        viewportWidth: state.paintViewportW,
        viewportHeight: state.paintViewportH,
        scrollX: state.scrollX,
        scrollY: state.scrollY,
        contentWidth: content.width,
        contentHeight: content.height,
      } satisfies QueryDomResult<"layoutMetrics">;
    }
    case "describeNode":
    case "resolveNode":
    case "getAttributes":
    case "focus":
      return queryDomNodeHandle(pageState, method, queryArgs);
    case "hasPendingCriticalResources":
      return queryDomHasPendingCriticalResources(pageState);
    case "getMemoryStats":
      return queryDomMemoryStats();
    case "boaForceCollect":
    case "getFontFaces":
    case "getMemprofDump":
    case "resetMemprof":
      return queryDomDiagnostics(method);
    case "webmcpGetTools":
    case "webmcpStopWatchingTools":
    case "webmcpCancelTool":
      return queryDomWebMcpRead(method, queryArgs);
    case "webmcpCallTool":
      return await queryDomWebMcpCall(queryArgs);
    case "getPageState":
      return queryDomPageState();
    case "markPaintDamage":
    case "paintDamageSince":
      return queryDomPaintDamage(method, queryArgs);
    default:
      return {};
  }
}

type QueryDomActiveState = typeof state & { dom: DomHandle };

type UpstreamSessionStub = NonNullable<ReceivedSessionInit["upstream"]>;
type OutboundSessionStub = NonNullable<ReceivedSessionInit["outbound"]>;

interface PageScriptSessionCleanup {
  closed: boolean;
  upstream: UpstreamSessionStub | null;
  outbound: OutboundSessionStub | null;
}

interface DisposableSessionStub {
  [Symbol.dispose]?: () => void;
}

function initializePageScriptSession(readTailToken: () => unknown): void {
  try {
    setTailToken(readTailToken());
  } catch {}
  if (!startupLagWatchdog) return;
  try {
    installLagWatchdog();
  } catch {}
}

function duplicateUpstreamStub(init: ReceivedSessionInit | undefined): UpstreamSessionStub | null {
  const stub = init?.upstream ?? null;
  return stub && stub.dup ? stub.dup() : stub;
}

function duplicateOutboundStub(init: ReceivedSessionInit | undefined): OutboundSessionStub | null {
  const stub = init?.outbound ?? null;
  return stub && stub.dup ? stub.dup() : stub;
}

function registerSessionUpstream(upstream: UpstreamSessionStub | null): void {
  if (!upstream) return;
  registerUpstreamSender((message) => {
    const upstreamPromise = upstream(message);
    if (upstreamPromise && upstreamPromise.catch) upstreamPromise.catch(() => {});
  });
}

function closePageScriptSession(cleanup: PageScriptSessionCleanup): void {
  if (cleanup.closed) return;
  cleanup.closed = true;
  clearUpstreamSender();
  if (cleanup.outbound) clearSessionOutbound(cleanup.outbound);
  disposeSessionStub(cleanup.upstream);
  disposeSessionStub(cleanup.outbound);
  sessionClosing = true;
  resolveSessionClosing();
}

function disposeSessionStub(stub: DisposableSessionStub | null): void {
  try {
    stub?.[Symbol.dispose]?.();
  } catch {}
}

function createPageScriptSessionTarget(
  host: PageScript,
  closeSession: () => void,
): RetainedPageScriptSessionTarget {
  class PageScriptSessionTarget extends RpcTarget implements RetainedPageScriptSessionTarget {
    call<M extends PageScriptMethod>(
      method: M,
      params: PageScriptWireParams[M],
      meta: WireMeta,
    ): Promise<PageScriptReply<M>> {
      return invokeSessionMethod(host, method, params || {}, meta || {});
    }
    makeRenderPort() {
      return host.makeRenderPort();
    }
    async close() {
      // Let the load drain settle before the parent proceeds to kill this isolate.
      closeSession();
      try {
        await state.loadCompletion;
      } catch {}
    }
    [Symbol.dispose]() {
      closeSession();
    }
  }
  return new PageScriptSessionTarget();
}

function installPageBinding(raw: string): void {
  const name = typeof raw === "string" && raw ? raw : null;
  if (!name) return;
  const bindingCallback = function (payload: unknown): void {
    if (typeof payload !== "string") return;
    sendUpstreamEvent({ event: "kitesurf.bindingCalled", params: { name, payload } });
  };
  try {
    globalThis[name] = bindingCallback;
  } catch {}
}

function frameBitmapFromParams(params: FrameBitmapParams): FrameBitmapParams | null {
  if (!isObjectRecord(params)) return null;
  if (!isFrameBitmapDimensions(params)) return null;
  if (!(params.rgba instanceof Uint8Array)) return null;
  return {
    ownerBackendNodeId: params.ownerBackendNodeId,
    width: params.width,
    height: params.height,
    rgba: params.rgba,
  };
}

function isFrameBitmapDimensions(params: FrameBitmapParams): boolean {
  return (
    typeof params.ownerBackendNodeId === "number" &&
    typeof params.width === "number" &&
    typeof params.height === "number"
  );
}

function applyFrameBitmap(bitmap: FrameBitmapParams): FrameBitmapReply {
  const dom = state.dom;
  if (!dom) return { ok: false, rc: -1, error: "dom missing" };
  return setFrameBitmapOnDom(dom, bitmap);
}

function setFrameBitmapOnDom(dom: DomHandle, bitmap: FrameBitmapParams): FrameBitmapReply {
  if (typeof dom.setIframeImage !== "function") {
    return { ok: false, rc: -1, error: "dom missing" };
  }
  try {
    const resultCode = dom.setIframeImage(
      bitmap.ownerBackendNodeId,
      bitmap.width,
      bitmap.height,
      bitmap.rgba,
    );
    if (resultCode === 0) recordFrameBitmapDamage(bitmap.ownerBackendNodeId);
    return { ok: resultCode >= 0, rc: resultCode };
  } catch (error) {
    return {
      ok: false,
      rc: -1,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function recordFrameBitmapDamage(ownerBackendNodeId: number): void {
  try {
    getInternalState().damageNodes.add(ownerBackendNodeId | 0);
  } catch {}
}

function parseMessageData(dataJson: DeliverMessageParams["dataJson"]): unknown {
  try {
    return JSON.parse(String(dataJson ?? "null"));
  } catch {
    return null;
  }
}

interface MessageDeliveryContext {
  pageGlobal: any;
  win: any;
  data: unknown;
  origin: string;
  source: unknown;
}

function prepareMessageDelivery(params: DeliverMessageParams): MessageDeliveryContext {
  const { dataJson, origin, sourceFrameOwnerId, fromParent } = params ?? {};
  const pageGlobal: any = globalThis;
  const win = pageGlobal.window ?? pageGlobal;
  return {
    pageGlobal,
    win,
    data: parseMessageData(dataJson),
    origin: String(origin ?? ""),
    source: resolveMessageSource(pageGlobal, win, sourceFrameOwnerId, fromParent),
  };
}

function dispatchMessageDelivery(context: MessageDeliveryContext): { ok: boolean; error?: string } {
  try {
    const MessageEventConstructor: any = context.pageGlobal.MessageEvent;
    const event = new MessageEventConstructor("message", {
      data: context.data,
      origin: context.origin,
      source: context.source,
    });
    context.win.dispatchEvent(event);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function resolveMessageSource(
  pageGlobal: any,
  win: any,
  sourceFrameOwnerId: unknown,
  fromParent: boolean | undefined,
): unknown {
  if (fromParent) return win.parent ?? null;
  return findSourceFrameWindow(pageGlobal, sourceFrameOwnerId);
}

function findSourceFrameWindow(pageGlobal: any, sourceFrameOwnerId: unknown): unknown {
  if (typeof sourceFrameOwnerId !== "number" || sourceFrameOwnerId <= 0) return null;
  try {
    return sourceFrameWindowFromDocument(pageGlobal, sourceFrameOwnerId);
  } catch {}
  return null;
}

function sourceFrameWindowFromDocument(pageGlobal: any, ownerNodeId: number): unknown {
  for (const iframeElement of sourceFrameElements(pageGlobal)) {
    if (isSourceFrameOwner(iframeElement, ownerNodeId)) {
      return sourceFrameWindow(iframeElement);
    }
  }
  return null;
}

function sourceFrameElements(pageGlobal: any): Iterable<unknown> {
  return pageGlobal.document?.querySelectorAll?.("iframe") ?? [];
}

function sourceFrameWindow(iframeElement: unknown): unknown {
  return (iframeElement as any).contentWindow ?? null;
}

function isSourceFrameOwner(iframeElement: unknown, ownerNodeId: number): boolean {
  return Boolean(iframeElement && (iframeElement as any)._id === ownerNodeId);
}

function installIframeContentInDocument(params: IframeContentParams): OkReply {
  const { ownerBackendNodeId, html, url, failed, frameId, mimeType, crossOrigin } = params ?? {};
  const iframeElement = state.resolveNodeId?.(ownerBackendNodeId);
  if (!isIframeContentTarget(iframeElement)) return { ok: true };
  return installIframeContentForTarget(
    iframeElement,
    html,
    url,
    failed,
    frameId,
    mimeType,
    crossOrigin,
  );
}

function installIframeContentForTarget(
  iframeElement: ShimElement,
  html: string,
  url: string,
  failed: boolean,
  frameId: string,
  mimeType: string | undefined,
  crossOrigin: boolean | undefined,
): OkReply {
  if (crossOrigin === true) return installCrossOriginIframeContent(iframeElement, url, frameId);
  if (shouldKeepInitialAboutBlank(iframeElement, url)) {
    (iframeElement as any).__ks_iframeFrameId = frameId;
    return { ok: true };
  }
  const contentDoc = parseIframeContentDocument(html, url, failed, mimeType);
  const contentWindow = createIframeContentWindow(iframeElement, contentDoc, url);
  connectIframeContentDocument(contentDoc, contentWindow);
  storeIframeContent(iframeElement, contentDoc, contentWindow, frameId);
  fireIframeLoad(iframeElement);
  return { ok: true };
}

function isIframeContentTarget(iframeElement: ShimElement | null): iframeElement is ShimElement {
  return Boolean(iframeElement && String(iframeElement.tagName || "").toLowerCase() === "iframe");
}

function installCrossOriginIframeContent(
  iframeElement: ShimElement,
  url: string,
  frameId: string,
): OkReply {
  const existingWindow = (iframeElement as any).__ks_iframeContentWindow;
  const win =
    existingWindow ??
    __makeCrossOriginContentWindow(iframeElement, typeof url === "string" ? url : "");
  try {
    win.document = null;
  } catch {}
  (iframeElement as any).__ks_iframeContentDocument = null;
  (iframeElement as any).__ks_iframeContentWindow = win;
  (iframeElement as any).__ks_iframeFrameId = frameId;
  fireIframeLoad(iframeElement);
  return { ok: true };
}

function shouldKeepInitialAboutBlank(iframeElement: ShimElement, url: string): boolean {
  if (url && url !== "about:blank") return false;
  if (iframeHasSourceAttribute(iframeElement)) return false;
  return Boolean((iframeElement as any).__ks_iframeContentDocument);
}

function iframeHasSourceAttribute(iframeElement: ShimElement): boolean {
  try {
    return (
      iframeElement.hasAttribute?.("src") === true ||
      iframeElement.hasAttribute?.("srcdoc") === true
    );
  } catch {
    return false;
  }
}

function parseIframeContentDocument(
  html: string,
  url: string,
  failed: boolean,
  mimeType: string | undefined,
): any {
  let contentDoc: any = null;
  try {
    const DOMParserConstructor = ksGlobal.DOMParser;
    if (DOMParserConstructor) {
      const parser = new DOMParserConstructor();
      contentDoc = parser.parseFromString(
        iframeContentSourceHtml(html, url, failed),
        pickDomParserMime(mimeType),
      );
      if (contentDoc) contentDoc._mutable = true;
      setFrameReferrer(contentDoc, iframeContentReferrer(url));
      setIframeDocumentBaseUrl(contentDoc, url);
    }
  } catch (error) {
    warnIframeParseFailure(url, error);
  }
  return contentDoc;
}

function iframeContentSourceHtml(html: string, url: string, failed: boolean): string {
  if (hasSuccessfulIframeHtml(html, failed)) return html;
  return emptyIframeSourceHtml(url);
}

function hasSuccessfulIframeHtml(html: string, failed: boolean): boolean {
  return !failed && typeof html === "string" && html.length > 0;
}

function emptyIframeSourceHtml(url: string): string {
  if (!url || url === "about:blank") return "<html><head></head><body></body></html>";
  return "<!doctype html><html><head></head><body></body></html>";
}

function iframeContentReferrer(url: string): string {
  return url && url !== "about:blank" ? frameNavigationReferrer(url) : state.pageUrl;
}

function setIframeDocumentBaseUrl(contentDoc: any, url: string): void {
  if (!contentDoc || !url) return;
  try {
    Object.defineProperty(contentDoc, "_baseUrl", {
      value: url,
      configurable: true,
      writable: true,
    });
  } catch {}
}

function warnIframeParseFailure(url: string, error: unknown): void {
  try {
    console.warn(
      "[kitesurf-iframe] parseFromString failed for " + url + ":",
      error instanceof Error ? error.message : String(error),
    );
  } catch {}
}

function createIframeContentWindow(
  iframeElement: ShimElement,
  contentDoc: any,
  url: string,
): Record<string, unknown> {
  const contentWindow: Record<string, unknown> = {
    document: contentDoc,
    parent: ksGlobal.window ?? globalThis,
    top: ksGlobal.window ?? globalThis,
    frames: [],
    name: iframeContentWindowName(iframeElement),
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
  };
  setIframeFacadeLocation(
    contentWindow,
    iframeElement,
    contentDoc ? url || "about:blank" : "about:blank",
  );
  contentWindow.self = contentWindow;
  contentWindow.window = contentWindow;
  contentWindow.frameElement = iframeElement;
  __decorateContentWindow(contentWindow);
  __wireContentWindowPostMessage(contentWindow, iframeElement);
  return contentWindow;
}

function iframeContentWindowName(iframeElement: ShimElement): string {
  try {
    return String(iframeElement.getAttribute?.("name") ?? "");
  } catch {
    return "";
  }
}

function connectIframeContentDocument(
  contentDoc: any,
  contentWindow: Record<string, unknown>,
): void {
  if (!contentDoc) return;
  try {
    Object.defineProperty(contentDoc, "defaultView", {
      value: contentWindow,
      configurable: true,
    });
  } catch {}
}

function storeIframeContent(
  iframeElement: ShimElement,
  contentDoc: any,
  contentWindow: Record<string, unknown>,
  frameId: string,
): void {
  (iframeElement as any).__ks_iframeContentDocument = contentDoc;
  (iframeElement as any).__ks_iframeContentWindow = contentWindow;
  (iframeElement as any).__ks_iframeFrameId = frameId;
}

interface CallFunctionSettings {
  returnByValue: boolean;
  awaitPromise: boolean;
  thisObjectId: string | null;
}

function callFunctionSettings(options: CallFunctionOnOptions): CallFunctionSettings {
  return {
    returnByValue: !!(options && options.returnByValue),
    awaitPromise: options === undefined ? true : options.awaitPromise !== false,
    thisObjectId: options && typeof options.thisObjectId === "string" ? options.thisObjectId : null,
  };
}

async function evaluateCallFunctionOn(
  functionDeclaration: string,
  argumentSpecs: ArgSpec[],
  settings: CallFunctionSettings,
): Promise<EvalResultBody> {
  try {
    const pageFunction = compileCallFunction(functionDeclaration);
    const argumentValues = callFunctionArgumentValues(argumentSpecs);
    const thisValue = callFunctionThisValue(settings.thisObjectId);
    let value = pageFunction.apply(thisValue, argumentValues);
    if (shouldAwaitCallFunctionValue(value, settings.awaitPromise)) value = await value;
    return packResult(value, settings.returnByValue);
  } catch (error) {
    return recoverCallFunctionEvaluation(error, functionDeclaration, argumentSpecs, settings);
  }
}

function shouldAwaitCallFunctionValue(value: unknown, awaitPromise: boolean): boolean {
  return awaitPromise && Boolean(value) && typeof Reflect.get(Object(value), "then") === "function";
}

function recoverCallFunctionEvaluation(
  error: unknown,
  functionDeclaration: string,
  argumentSpecs: ArgSpec[],
  settings: CallFunctionSettings,
): Promise<EvalResultBody> | EvalResultBody {
  if (shouldCallBoaFallback(error)) {
    return evaluateCallFunctionInBoa(functionDeclaration, argumentSpecs, settings);
  }
  return packException(error);
}

function compileCallFunction(functionDeclaration: string): Function {
  const functionSource =
    typeof functionDeclaration === "string" ? functionDeclaration : "undefined";
  const factory = new SyncFunction("return (" + functionSource + ");");
  const pageFunction = factory();
  if (typeof pageFunction !== "function") {
    throw new TypeError("functionDeclaration did not evaluate to a function");
  }
  return pageFunction;
}

function callFunctionArgumentValues(argumentSpecs: ArgSpec[]): unknown[] {
  const specs = Array.isArray(argumentSpecs) ? argumentSpecs : [];
  return specs.map(callFunctionArgumentValue);
}

function callFunctionArgumentValue(spec: ArgSpec): unknown {
  if (typeof spec === "string") return parseCallFunctionJson(spec);
  if (!spec || typeof spec !== "object") return undefined;
  return callFunctionObjectArgumentValue(spec);
}

function callFunctionObjectArgumentValue(spec: ArgSpec): unknown {
  if (typeof spec.objectId === "string") return lookupHandle(spec.objectId);
  return callFunctionJsonArgumentValue(spec.json);
}

function callFunctionJsonArgumentValue(value: unknown): unknown {
  return typeof value === "string" ? parseCallFunctionJson(value) : undefined;
}

function parseCallFunctionJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function callFunctionThisValue(thisObjectId: string | null): unknown {
  return thisObjectId !== null ? (lookupHandle(thisObjectId) ?? globalThis) : globalThis;
}

function shouldCallBoaFallback(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "EvalError" &&
    typeof error.message === "string" &&
    error.message.includes("Code generation from strings disallowed")
  );
}

async function evaluateCallFunctionInBoa(
  functionDeclaration: string,
  argumentSpecs: ArgSpec[],
  settings: CallFunctionSettings,
): Promise<EvalResultBody> {
  const functionSource =
    typeof functionDeclaration === "string" ? functionDeclaration : "undefined";
  const argumentValues = callFunctionArgumentValues(argumentSpecs);
  const thisValue = callFunctionThisValue(settings.thisObjectId);
  try {
    const boaResult = await ks_call_cdp(
      functionSource,
      thisValue,
      argumentValues,
      settings.awaitPromise,
      settings.returnByValue,
    );
    return packBoaResult(boaResult, settings.returnByValue);
  } catch (error) {
    return packException(error instanceof Error ? error : new Error(String(error)));
  }
}

function isPropertyInspectable(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function collectObjectProperties(objectValue: object, ownOnly: boolean): PropertyDescriptor[] {
  const result: PropertyDescriptor[] = [];
  const seen = new Set<string>();
  appendOwnPropertyDescriptors(objectValue, true, seen, result);
  if (!ownOnly) appendPrototypePropertyDescriptors(objectValue, seen, result);
  return result;
}

function appendOwnPropertyDescriptors(
  target: object,
  isOwn: boolean,
  seen: Set<string>,
  result: PropertyDescriptor[],
): void {
  for (const name of propertyNames(target)) {
    if (seen.has(name)) continue;
    seen.add(name);
    const entry = propertyDescriptorFor(target, name, isOwn);
    if (entry) result.push(entry);
  }
}

function propertyNames(target: object): string[] {
  try {
    return Object.getOwnPropertyNames(target);
  } catch {
    return [];
  }
}

function propertyDescriptorFor(
  target: object,
  name: string,
  isOwn: boolean,
): PropertyDescriptor | null {
  const descriptor = ownPropertyDescriptor(target, name);
  if (!descriptor) return null;
  const entry: PropertyDescriptor = {
    name,
    configurable: !!descriptor.configurable,
    enumerable: !!descriptor.enumerable,
    isOwn,
  };
  addPropertyDescriptorContents(entry, descriptor);
  return entry;
}

function ownPropertyDescriptor(
  target: object,
  name: string,
): ReturnType<typeof Object.getOwnPropertyDescriptor> {
  try {
    return Object.getOwnPropertyDescriptor(target, name);
  } catch {
    return undefined;
  }
}

function addPropertyDescriptorContents(
  entry: PropertyDescriptor,
  descriptor: NonNullable<ReturnType<typeof Object.getOwnPropertyDescriptor>>,
): void {
  if ("value" in descriptor) {
    entry.writable = !!descriptor.writable;
    safelyPackProperty(descriptor.value, (value) => {
      entry.value = value;
    });
    return;
  }
  addPropertyDescriptorAccessors(entry, descriptor);
}

function addPropertyDescriptorAccessors(
  entry: PropertyDescriptor,
  descriptor: NonNullable<ReturnType<typeof Object.getOwnPropertyDescriptor>>,
): void {
  if (typeof descriptor.get === "function") {
    safelyPackProperty(descriptor.get, (value) => {
      entry.get = value;
    });
  }
  if (typeof descriptor.set === "function") {
    safelyPackProperty(descriptor.set, (value) => {
      entry.set = value;
    });
  }
}

function safelyPackProperty(
  value: unknown,
  assign: (packed: ReturnType<typeof packResult>) => void,
): void {
  try {
    assign(packResult(value, false));
  } catch {}
}

function appendPrototypePropertyDescriptors(
  objectValue: object,
  seen: Set<string>,
  result: PropertyDescriptor[],
): void {
  const MAX_PROTOTYPE_DESCRIPTOR_CHAIN_DEPTH = 6;
  let prototype = objectPrototype(objectValue);
  let depth = 0;
  while (prototype && depth++ < MAX_PROTOTYPE_DESCRIPTOR_CHAIN_DEPTH) {
    appendOwnPropertyDescriptors(prototype, false, seen, result);
    prototype = objectPrototype(prototype);
  }
}

function objectPrototype(value: object): object | null {
  try {
    return Object.getPrototypeOf(value);
  } catch {
    return null;
  }
}

function requireQueryDomDocument(
  pageState: typeof state,
): asserts pageState is QueryDomActiveState {
  if (!pageState.dom) throw new Error("PageScript: no document loaded");
}

type QueryDomDocumentReadMethod = Extract<
  QueryDomMethod,
  "getDocument" | "nodeSubtree" | "getOuterHTMLAndSeq"
>;

function queryDomDocumentRead(
  pageState: QueryDomActiveState,
  method: QueryDomDocumentReadMethod,
  queryArgs: Record<string, unknown>,
): QueryDomResult<QueryDomDocumentReadMethod> {
  switch (method) {
    case "getDocument":
      return queryDomGetDocument(pageState, queryArgs);
    case "nodeSubtree":
      return queryDomNodeSubtree(pageState, queryArgs);
    case "getOuterHTMLAndSeq":
      return queryDomOuterHTMLAndSeq(pageState);
  }
}

function queryDomGetDocument(
  pageState: QueryDomActiveState,
  queryArgs: Record<string, unknown>,
): QueryDomResult<"getDocument"> {
  // Read stamps bracket the synchronous DOM read with the mutation sequence.
  const before = getInternalState().mutationSeq | 0;
  const root = sanitizeCdpNodeTree(pageState.dom.getDocument());
  return {
    root,
    ...(queryArgs.includeReadStamp === true
      ? {
          readStamp: {
            before,
            after: getInternalState().mutationSeq | 0,
            complete: true,
          },
        }
      : {}),
  } satisfies QueryDomResult<"getDocument">;
}

function queryDomNodeSubtree(
  pageState: QueryDomActiveState,
  queryArgs: Record<string, unknown>,
): QueryDomResult<"nodeSubtree"> {
  const id = numericNodeId(queryArgs);
  if (id === null) return { node: null } satisfies QueryDomResult<"nodeSubtree">;
  try {
    return {
      node: sanitizeCdpNodeTree(pageState.dom.nodeSubtree?.(id)) || null,
    } satisfies QueryDomResult<"nodeSubtree">;
  } catch {
    return { node: null } satisfies QueryDomResult<"nodeSubtree">;
  }
}

function queryDomOuterHTMLAndSeq(
  pageState: QueryDomActiveState,
): QueryDomResult<"getOuterHTMLAndSeq"> {
  let outerHTML = "";
  try {
    outerHTML = pageState.dom.outerHTML(0);
  } catch {}
  return {
    outerHTML,
    seq: getInternalState().mutationSeq | 0,
    scrollX: state.scrollX,
    scrollY: state.scrollY,
  } satisfies QueryDomResult<"getOuterHTMLAndSeq">;
}

function queryDomOuterHTML(
  pageState: QueryDomActiveState,
  queryArgs: Record<string, unknown>,
): QueryDomResult<"getOuterHTML"> {
  const id = numericNodeId(queryArgs) ?? 0;
  try {
    const rawOuterHTML = pageState.dom.outerHTML(id);
    return {
      outerHTML: rewriteOuterHTMLDoctype(id, queryArgs, rawOuterHTML),
    } satisfies QueryDomResult<"getOuterHTML">;
  } catch {
    return { outerHTML: "" } satisfies QueryDomResult<"getOuterHTML">;
  }
}

function rewriteOuterHTMLDoctype(
  id: number,
  queryArgs: Record<string, unknown>,
  rawOuterHTML: string,
): string {
  const markerMarkup = doctypeMarkerMarkup();
  const markerIndex = sourceDoctypeMarkerIndex(id, markerMarkup, rawOuterHTML);
  const withoutMarker = removeDoctypeMarker(rawOuterHTML, markerMarkup, markerIndex);
  const sourceDoctype = sourceDocumentDoctype();
  if (!shouldIncludeSourceDoctype(id, queryArgs, sourceDoctype, markerIndex, withoutMarker)) {
    return withoutMarker;
  }
  return insertSourceDoctype(withoutMarker, markerIndex, sourceDoctype.markup);
}

function doctypeMarkerMarkup(): string | null {
  return state.sourceDoctype ? `<!--${state.sourceDoctype.marker}-->` : null;
}

function sourceDoctypeMarkerIndex(id: number, marker: string | null, html: string): number {
  return id === 0 && marker ? html.indexOf(marker) : -1;
}

function removeDoctypeMarker(html: string, marker: string | null, index: number): string {
  if (index < 0 || marker === null) return html;
  return html.slice(0, index) + html.slice(index + marker.length);
}

function sourceDocumentDoctype(): typeof state.sourceDoctype {
  return state.document?.doctype?.parentNode === state.document ? state.sourceDoctype : null;
}

function shouldIncludeSourceDoctype(
  id: number,
  queryArgs: Record<string, unknown>,
  doctype: typeof state.sourceDoctype,
  markerIndex: number,
  outerHTML: string,
): doctype is NonNullable<typeof state.sourceDoctype> {
  return (
    id === 0 &&
    queryArgs.includeDoctype === true &&
    doctype !== null &&
    markerIndex >= 0 &&
    !/^(?:\s|<!--[\s\S]*?-->)*<!doctype\b/i.test(outerHTML)
  );
}

function insertSourceDoctype(html: string, index: number, markup: string): string {
  return html.slice(0, index) + markup + html.slice(index);
}

type QueryDomSelectorReadMethod = Extract<
  QueryDomMethod,
  "querySelector" | "querySelectorAll" | "matchSelectorList"
>;

function queryDomSelectorRead(
  pageState: QueryDomActiveState,
  method: QueryDomSelectorReadMethod,
  queryArgs: Record<string, unknown>,
): QueryDomResult<QueryDomSelectorReadMethod> {
  switch (method) {
    case "querySelector":
      return queryDomSelector(pageState, queryArgs);
    case "querySelectorAll":
      return queryDomSelectorAll(pageState, queryArgs);
    case "matchSelectorList":
      return queryDomMatchSelectorList(pageState, queryArgs);
  }
}

function queryDomSelector(
  pageState: QueryDomActiveState,
  queryArgs: Record<string, unknown>,
): QueryDomResult<"querySelector"> {
  const selector = String(queryArgs.selector || "");
  try {
    const id = pageState.dom.querySelector(selector);
    return { nodeId: id < 0 ? 0 : id } satisfies QueryDomResult<"querySelector">;
  } catch (err) {
    return { nodeId: 0, error: String(err) } satisfies QueryDomResult<"querySelector">;
  }
}

function queryDomSelectorAll(
  pageState: QueryDomActiveState,
  queryArgs: Record<string, unknown>,
): QueryDomResult<"querySelectorAll"> {
  const selector = String(queryArgs.selector || "");
  try {
    const ids = pageState.dom.querySelectorAll(selector);
    return {
      nodeIds: Array.from(ids).filter((n): n is number => typeof n === "number" && n >= 0),
    } satisfies QueryDomResult<"querySelectorAll">;
  } catch (err) {
    return { nodeIds: [], error: String(err) } satisfies QueryDomResult<"querySelectorAll">;
  }
}

function queryDomMatchSelectorList(
  pageState: QueryDomActiveState,
  queryArgs: Record<string, unknown>,
): QueryDomResult<"matchSelectorList"> {
  const nodeId = numericNodeId(queryArgs);
  if (nodeId === null) return { matches: [] } satisfies QueryDomResult<"matchSelectorList">;
  return {
    matches: matchingSelectorIndexes(pageState, nodeId, queryArgs),
  } satisfies QueryDomResult<"matchSelectorList">;
}

function matchingSelectorIndexes(
  pageState: QueryDomActiveState,
  nodeId: number,
  queryArgs: Record<string, unknown>,
): number[] {
  const selectors = splitSelectorList(String(queryArgs.selectorListText || ""));
  const matches: number[] = [];
  for (let i = 0; i < selectors.length; i++) {
    appendSelectorMatch(pageState, nodeId, selectors[i], i, matches);
  }
  return matches;
}

function appendSelectorMatch(
  pageState: QueryDomActiveState,
  nodeId: number,
  selector: string,
  index: number,
  matches: number[],
): void {
  const trimmedSelector = selector.trim();
  if (!trimmedSelector) return;
  try {
    if (pageState.dom.matchesInSubtree(nodeId, trimmedSelector)) matches.push(index);
  } catch {}
}

function queryDomAncestorElementIds(
  pageState: QueryDomActiveState,
  queryArgs: Record<string, unknown>,
): QueryDomResult<"getAncestorElementIds"> {
  const id = numericNodeId(queryArgs);
  if (id === null) return { ancestorIds: [] } satisfies QueryDomResult<"getAncestorElementIds">;
  return {
    ancestorIds: collectAncestorElementIds(pageState, id),
  } satisfies QueryDomResult<"getAncestorElementIds">;
}

function collectAncestorElementIds(pageState: QueryDomActiveState, id: number): number[] {
  const ancestorIds: number[] = [];
  let currentNodeId = id;
  for (let hops = 0; hops < MAX_ANCESTOR_STYLE_HOPS; hops++) {
    const parent = ancestorParentId(pageState, currentNodeId);
    if (parent === null) break;
    const info = ancestorNodeInfo(pageState, parent);
    if (!appendAncestorElementId(info, parent, ancestorIds)) break;
    currentNodeId = parent;
  }
  return ancestorIds;
}

function appendAncestorElementId(
  info: { nodeType?: number } | null,
  parent: number,
  ancestorIds: number[],
): boolean {
  if (!info) return false;
  if (info.nodeType === 1) ancestorIds.push(parent);
  else if (info.nodeType === 9) return false;
  return true;
}

function ancestorParentId(pageState: QueryDomActiveState, nodeId: number): number | null {
  try {
    const parent = pageState.dom.parentId(nodeId);
    return typeof parent === "number" && parent >= 0 ? parent : null;
  } catch {
    return null;
  }
}

function ancestorNodeInfo(
  pageState: QueryDomActiveState,
  nodeId: number,
): { nodeType?: number } | null {
  try {
    return pageState.dom.nodeInfo(nodeId);
  } catch {
    return null;
  }
}

function queryDomParseStylesheet(
  queryArgs: Record<string, unknown>,
): QueryDomResult<"parseStyleSheet"> {
  const text = String(queryArgs.text || "");
  try {
    const sheet = ks_parse_stylesheet_structured(text);
    return { sheet } satisfies QueryDomResult<"parseStyleSheet">;
  } catch (err) {
    return {
      sheet: { rules: [] },
      error: String(err),
    } satisfies QueryDomResult<"parseStyleSheet">;
  }
}

type QueryDomEnumeratedStyleSheets = NonNullable<QueryDomResult<"enumerateStyleSheets">["sheets"]>;

function queryDomEnumerateStyleSheets(
  pageState: QueryDomActiveState,
): QueryDomResult<"enumerateStyleSheets"> {
  try {
    const sheets: QueryDomEnumeratedStyleSheets = [];
    let uaText = ksGlobal.__ks_uaStylesheetText as string | undefined;
    if (typeof uaText !== "string") {
      try {
        uaText = ks_ua_stylesheet();
      } catch {
        uaText = "";
      }
      ksGlobal.__ks_uaStylesheetText = uaText;
    }
    if (uaText.length > 0) {
      sheets.push({
        ownerNodeId: -1,
        text: uaText,
        isInline: false,
        origin: "user-agent",
      });
    }
    appendInlineStyleSheets(pageState, sheets);
    appendLinkedStyleSheets(pageState, sheets);
    return { sheets } satisfies QueryDomResult<"enumerateStyleSheets">;
  } catch (err) {
    return {
      sheets: [],
      error: String(err),
    } satisfies QueryDomResult<"enumerateStyleSheets">;
  }
}

function appendInlineStyleSheets(
  pageState: QueryDomActiveState,
  sheets: QueryDomEnumeratedStyleSheets,
): void {
  const styleIds = pageState.dom.querySelectorAll("style");
  for (const id of Array.from(styleIds)) {
    appendInlineStyleSheet(pageState, sheets, id);
  }
}

function appendInlineStyleSheet(
  pageState: QueryDomActiveState,
  sheets: QueryDomEnumeratedStyleSheets,
  id: unknown,
): void {
  if (typeof id !== "number" || id < 0) return;
  let text = "";
  try {
    text = pageState.dom.textContent(id) || "";
  } catch {}
  sheets.push({ ownerNodeId: id, text, isInline: true });
}

function appendLinkedStyleSheets(
  pageState: QueryDomActiveState,
  sheets: QueryDomEnumeratedStyleSheets,
): void {
  const linkIds = pageState.dom.querySelectorAll("link[rel]");
  for (const id of Array.from(linkIds)) {
    const sheet = linkedStylesheetForNode(pageState, id);
    if (sheet) sheets.push(sheet);
  }
}

function linkedStylesheetForNode(
  pageState: QueryDomActiveState,
  id: unknown,
): QueryDomEnumeratedStyleSheets[number] | null {
  if (!isStylesheetNodeId(id)) return null;
  const attrs = stylesheetAttributesForNode(pageState, id);
  if (!attrs) return null;
  const href = stylesheetHref(attrs);
  const resolvedUrl = resolveStylesheetUrl(pageState, href);
  if (!resolvedUrl) return null;
  const cache = stylesheetCacheEntry(resolvedUrl);
  return {
    ownerNodeId: id,
    text: cache.text,
    sourceURL: resolvedUrl,
    isInline: false,
    cors: cache.cors,
  };
}

function stylesheetCacheEntry(
  url: string,
): Pick<QueryDomEnumeratedStyleSheets[number], "text" | "cors"> {
  return {
    text: resourceCacheStyles.get(url) ?? "",
    cors: stylesheetCors.get(url) ?? "pending",
  };
}

function stylesheetAttributesForNode(pageState: QueryDomActiveState, id: number): unknown[] | null {
  try {
    return attributesFromNodeInfo(pageState.dom.nodeInfo(id)) ?? null;
  } catch {
    return null;
  }
}

function isStylesheetNodeId(id: unknown): id is number {
  return typeof id === "number" && id >= 0;
}

function resolveStylesheetUrl(pageState: QueryDomActiveState, href: string | null): string | null {
  if (!href) return null;
  try {
    const base = pageState.dom.baseURL() || "about:blank";
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

function queryDomSceneStats(): QueryDomResult<"getSceneStats"> {
  const recordStartedAt = Date.now();
  const seqNow = getInternalState().mutationSeq | 0;
  const cascadeSeqNow = cascadeSeq();
  const { paint, fresh: isFreshPaint } = takePaintPrep();
  if (!paint) {
    return {
      seq: seqNow,
      error: "ensurePaintDom returned null",
    } satisfies QueryDomResult<"getSceneStats">;
  }
  prepareCachedPaint(paint, isFreshPaint, cascadeSeqNow);
  const prepFinishedAt = Date.now();
  let statsJson = "";
  try {
    statsJson = paint.renderSceneStats(state.scrollX, state.scrollY) || "";
  } catch (e) {
    invalidatePaintDom();
    return {
      seq: seqNow,
      error: errorMessage(e),
    } satisfies QueryDomResult<"getSceneStats">;
  }
  const recordFinishedAt = Date.now();
  if (!statsJson) {
    invalidatePaintDom();
    return {
      seq: seqNow,
      error: "renderSceneStats returned empty",
    } satisfies QueryDomResult<"getSceneStats">;
  }
  return {
    seq: getInternalState().mutationSeq | 0,
    scrollX: state.scrollX,
    scrollY: state.scrollY,
    prepMs: prepFinishedAt - recordStartedAt,
    recordMs: recordFinishedAt - prepFinishedAt,
    statsJson,
  } satisfies QueryDomResult<"getSceneStats">;
}

async function queryDomPumpTasks(
  queryArgs: Record<string, unknown>,
): Promise<QueryDomResult<"pumpTasks">> {
  const { frameIntervalMs }: { frameIntervalMs?: unknown } = queryArgs;
  const { pumped, nextRafDelayMs } = await pumpPageTasksAsDriver(frameIntervalMs);
  const seq = getInternalState().mutationSeq | 0;
  const animating = isAnimating();
  const { armWakeAfterSeq: wakeAfter }: { armWakeAfterSeq?: unknown } = queryArgs;
  if (typeof wakeAfter !== "number")
    return {
      seq,
      animating,
      pumped,
      idle: false,
      nextRafDelayMs,
    } satisfies QueryDomResult<"pumpTasks">;
  const idle = queryDomPumpTasksIdle(seq, wakeAfter, animating);
  armPaintWake(idle ? wakeAfter : null);
  return {
    seq,
    animating,
    pumped,
    idle,
    nextRafDelayMs,
  } satisfies QueryDomResult<"pumpTasks">;
}

function queryDomPumpTasksIdle(seq: number, wakeAfter: number, animating: boolean): boolean {
  return seq !== 0 && seq <= wakeAfter && !animating && !hasPendingAnimationFrames();
}

interface QueryDomRecordSceneWake {
  armWake: boolean;
  pumped: number;
  pumpMs: number;
  nextRafDelayMs: number | undefined;
  seqNow: number;
  sinceSeq: number | null;
}

interface QueryDomRecordSceneContext {
  pageState: QueryDomActiveState;
  queryArgs: Record<string, unknown>;
  wake: QueryDomRecordSceneWake;
  internalState: ReturnType<typeof getInternalState>;
  epochDamageSize: number;
  epochLayoutDirty: boolean;
  rawImages: boolean;
  omitBg: boolean;
  clientWire: boolean;
  allowPartial: boolean;
  baseSeq: number;
  paint: DomHandle;
  clip: ReturnType<typeof readSceneClip>;
  hasClip: boolean;
  scrollDx: number;
  scrollDy: number;
  scrolled: boolean;
  allowScrollShift: boolean;
  partialPlan: ReturnType<typeof planPartialScene>;
}

type QueryDomRecordScenePreparation =
  | { kind: "response"; response: QueryDomResult<"recordScene"> }
  | { kind: "ready"; context: QueryDomRecordSceneContext };

type QueryDomRecordSceneRender =
  | { kind: "response"; response: QueryDomResult<"recordScene"> }
  | {
      kind: "rendered";
      scene: Uint8Array;
      emittedPartial: boolean;
      partialClip: ReturnType<typeof planPartialScene>["partialClip"];
      extraPatches: ScenePatch[];
    };

function armRecordSceneIdleWake(armWake: boolean, seq: number): boolean {
  if (!armWake) return false;
  const idle =
    !isAnimating() &&
    !hasPendingAnimationFrames() &&
    getInternalState().pendingCanvasPushes.size === 0;
  armPaintWake(idle ? seq : null, "scene");
  return idle;
}

function isRecordSceneUnchanged(wake: QueryDomRecordSceneWake): boolean {
  return (
    hasRecordSceneSequence(wake) &&
    hasRecordSceneScrollPosition() &&
    hasRecordSceneViewport() &&
    !isAnimating()
  );
}

function hasRecordSceneSequence(wake: QueryDomRecordSceneWake): boolean {
  return wake.sinceSeq !== null && wake.seqNow <= wake.sinceSeq && wake.seqNow !== 0;
}

function hasRecordSceneScrollPosition(): boolean {
  return state.scrollX === state.lastRecordScrollX && state.scrollY === state.lastRecordScrollY;
}

function hasRecordSceneViewport(): boolean {
  return (
    state.paintViewportW === state.lastRecordViewportW &&
    state.paintViewportH === state.lastRecordViewportH
  );
}

async function queryDomRecordScene(
  pageState: QueryDomActiveState,
  queryArgs: Record<string, unknown>,
): Promise<QueryDomResult<"recordScene">> {
  const wake = await prepareQueryDomRecordSceneWake(queryArgs);
  if (isRecordSceneUnchanged(wake)) {
    return unchangedQueryDomRecordScene(wake);
  }
  const preparation = prepareQueryDomRecordScene(pageState, queryArgs, wake);
  if (preparation.kind === "response") return preparation.response;
  const rendered = renderQueryDomScene(preparation.context);
  if (rendered.kind === "response") return rendered.response;
  return finishQueryDomRecordScene(preparation.context, rendered);
}

async function prepareQueryDomRecordSceneWake(
  queryArgs: Record<string, unknown>,
): Promise<QueryDomRecordSceneWake> {
  // Scene-stream and screencast wake thresholds are tracked independently.
  const armWake = queryArgs.armWake === true;
  if (typeof queryArgs.armWake === "boolean") armPaintWake(null, "scene");
  const pump = await pumpQueryDomRecordSceneTasks(queryArgs);
  for (const push of [...getInternalState().pendingCanvasPushes]) push();
  const seqNow = getInternalState().mutationSeq | 0;
  const sinceSeq = typeof queryArgs.sinceSeq === "number" ? queryArgs.sinceSeq | 0 : null;
  return { armWake, ...pump, seqNow, sinceSeq };
}

async function pumpQueryDomRecordSceneTasks(
  queryArgs: Record<string, unknown>,
): Promise<Pick<QueryDomRecordSceneWake, "pumped" | "pumpMs" | "nextRafDelayMs">> {
  if (queryArgs.pumpRaf !== true) {
    return { pumped: -1, pumpMs: 0, nextRafDelayMs: undefined };
  }
  const { frameIntervalMs }: { frameIntervalMs?: unknown } = queryArgs;
  const result = await pumpPageTasksAsDriver(frameIntervalMs);
  return {
    pumped: result.pumped,
    pumpMs: result.pumpMs,
    nextRafDelayMs: result.nextRafDelayMs,
  };
}

function unchangedQueryDomRecordScene(
  wake: QueryDomRecordSceneWake,
): QueryDomResult<"recordScene"> {
  return {
    unchanged: true,
    seq: wake.seqNow,
    idle: armRecordSceneIdleWake(wake.armWake, wake.seqNow),
    pumped: wake.pumped,
    pumpMs: wake.pumpMs,
    nextRafDelayMs: wake.nextRafDelayMs,
    scrollX: state.scrollX,
    scrollY: state.scrollY,
  } satisfies QueryDomResult<"recordScene">;
}

interface QueryDomRecordSceneSettings {
  internalState: ReturnType<typeof getInternalState>;
  epochDamage: Set<number>;
  epochDamageSize: number;
  epochLayoutDirty: boolean;
  epochBase: number;
  rawImages: boolean;
  omitBg: boolean;
  clientWire: boolean;
  allowPartial: boolean;
  baseSeq: number;
  allowScrollShift: boolean;
}

function queryDomRecordSceneSettings(
  queryArgs: Record<string, unknown>,
  internalState: ReturnType<typeof getInternalState>,
): QueryDomRecordSceneSettings {
  const epochDamage = internalState.damageNodes;
  return {
    internalState,
    epochDamage,
    epochDamageSize: epochDamage.size,
    epochLayoutDirty: !!internalState.layoutDirtySinceRecord,
    epochBase: internalState.lastRecordSeq | 0,
    rawImages: queryArgs.images === "raw",
    omitBg: queryArgs.omitBackground === true,
    clientWire: queryArgs.producer === "client",
    allowPartial: queryArgs.allowPartial === true,
    baseSeq: typeof queryArgs.baseSeq === "number" ? queryArgs.baseSeq | 0 : -1,
    allowScrollShift: queryArgs.allowScrollShift === true,
  };
}

function prepareQueryDomRecordScene(
  pageState: QueryDomActiveState,
  queryArgs: Record<string, unknown>,
  wake: QueryDomRecordSceneWake,
): QueryDomRecordScenePreparation {
  const cascadeSeqNow = cascadeSeq();
  const internalState = getInternalState();
  const settings = queryDomRecordSceneSettings(queryArgs, internalState);
  const { paint, fresh: isFreshPaint } = takePaintPrep();
  if (!paint) return failedQueryDomRecordScenePreparation(pageState, wake);
  prepareCachedPaint(paint, isFreshPaint, cascadeSeqNow);
  const context = createQueryDomRecordSceneContext(pageState, queryArgs, wake, settings, paint);
  const skip = queryDomRecordSceneSkipResult(context);
  if (skip) return { kind: "response", response: skip };
  return { kind: "ready", context };
}

function failedQueryDomRecordScenePreparation(
  pageState: QueryDomActiveState,
  wake: QueryDomRecordSceneWake,
): QueryDomRecordScenePreparation {
  let fallbackHtml = "";
  try {
    fallbackHtml = pageState.dom.outerHTML(0) || "";
  } catch {}
  return {
    kind: "response",
    response: {
      scene: new Uint8Array(0),
      seq: wake.seqNow,
      error: "ensurePaintDom returned null (serialize/parse failed)",
      fallbackHtml,
      scrollX: state.scrollX,
      scrollY: state.scrollY,
    } satisfies QueryDomResult<"recordScene">,
  };
}

function createQueryDomRecordSceneContext(
  pageState: QueryDomActiveState,
  queryArgs: Record<string, unknown>,
  wake: QueryDomRecordSceneWake,
  settings: QueryDomRecordSceneSettings,
  paint: DomHandle,
): QueryDomRecordSceneContext {
  const clip = readSceneClip(queryArgs.clip);
  const hasClip = clip !== null;
  const scrollDx = state.scrollX - state.lastRecordScrollX;
  const scrollDy = state.scrollY - state.lastRecordScrollY;
  const scrolled = scrollDx !== 0 || scrollDy !== 0;
  const partialPlan = queryDomRecordScenePartialPlan(
    settings,
    wake,
    paint,
    scrolled,
    scrollDx,
    scrollDy,
    hasClip,
  );
  return {
    pageState,
    queryArgs,
    wake,
    internalState: settings.internalState,
    epochDamageSize: settings.epochDamageSize,
    epochLayoutDirty: settings.epochLayoutDirty,
    rawImages: settings.rawImages,
    omitBg: settings.omitBg,
    clientWire: settings.clientWire,
    allowPartial: settings.allowPartial,
    baseSeq: settings.baseSeq,
    paint,
    clip,
    hasClip,
    scrollDx,
    scrollDy,
    scrolled,
    allowScrollShift: settings.allowScrollShift,
    partialPlan,
  };
}

function queryDomRecordScenePartialPlan(
  settings: QueryDomRecordSceneSettings,
  wake: QueryDomRecordSceneWake,
  paint: DomHandle,
  scrolled: boolean,
  scrollDx: number,
  scrollDy: number,
  hasClip: boolean,
): ReturnType<typeof planPartialScene> {
  return planPartialScene({
    paint,
    allowPartial: settings.allowPartial,
    clientWire: settings.clientWire,
    epochLayoutDirty: settings.epochLayoutDirty,
    baseSeq: settings.baseSeq,
    epochBase: settings.epochBase,
    scrolled,
    allowScrollShift: settings.allowScrollShift,
    scrollDeltaX: scrollDx,
    scrollDeltaY: scrollDy,
    sinceSeq: wake.sinceSeq,
    hasClip,
    epochDamage: settings.epochDamage,
    viewportWidth: state.paintViewportW || 0,
    viewportHeight: state.paintViewportH || 0,
  });
}

function queryDomRecordSceneSkipResult(
  context: QueryDomRecordSceneContext,
): QueryDomResult<"recordScene"> | null {
  if (context.partialPlan.unchangedReason === "noDamage") {
    return {
      unchanged: true,
      seq: context.wake.seqNow,
      idle: armRecordSceneIdleWake(context.wake.armWake, context.wake.seqNow),
      pumped: context.wake.pumped,
      pumpMs: context.wake.pumpMs,
      nextRafDelayMs: context.wake.nextRafDelayMs,
      scrollX: state.scrollX,
      scrollY: state.scrollY,
    } satisfies QueryDomResult<"recordScene">;
  }
  if (context.partialPlan.unchangedReason === "offscreen") {
    return {
      unchanged: true,
      seq: context.wake.seqNow,
      pumped: context.wake.pumped,
      pumpMs: context.wake.pumpMs,
      nextRafDelayMs: context.wake.nextRafDelayMs,
      scrollX: state.scrollX,
      scrollY: state.scrollY,
    } satisfies QueryDomResult<"recordScene">;
  }
  return null;
}

function renderQueryDomScene(context: QueryDomRecordSceneContext): QueryDomRecordSceneRender {
  try {
    const rendered = renderPlannedQueryDomScene(context);
    if (!rendered.scene || rendered.scene.length === 0) {
      const error = new Error("renderScene returned empty");
      return failedQueryDomScene(context, error, "renderScene returned empty");
    }
    return { kind: "rendered", ...rendered, scene: rendered.scene };
  } catch (e) {
    return failedQueryDomScene(context, e, "renderScene threw");
  }
}

interface QueryDomPlannedScene {
  scene: Uint8Array | null;
  emittedPartial: boolean;
  partialClip: ReturnType<typeof planPartialScene>["partialClip"];
  extraPatches: ScenePatch[];
}

function renderPlannedQueryDomScene(context: QueryDomRecordSceneContext): QueryDomPlannedScene {
  const renderers = queryDomSceneRenderers(context);
  if (shouldRenderQueryDomScrollPatches(context)) {
    return renderQueryDomScrollPatches(context, renderers);
  }
  const partialClip = context.partialPlan.partialClip;
  if (partialClip && !context.hasClip) {
    return renderQueryDomPartialClip(context, renderers, partialClip);
  }
  return renderQueryDomCompleteScene(context, renderers);
}

function queryDomSceneRenderers(context: QueryDomRecordSceneContext) {
  const { paint, rawImages } = context;
  const memory = coreWasmMemory;
  const renderScene = rawImages
    ? (...args: Parameters<typeof paint.renderSceneRaw>) =>
        renderSceneRawPooled(paint, memory, ...args)
    : paint.renderScene.bind(paint);
  const renderClip = (rawImages ? paint.renderSceneClipRaw : paint.renderSceneClip).bind(paint);
  return { renderScene, renderClip };
}

function shouldRenderQueryDomScrollPatches(context: QueryDomRecordSceneContext): boolean {
  return context.partialPlan.scrollClips.length > 0 && !context.hasClip;
}

function renderQueryDomScrollPatches(
  context: QueryDomRecordSceneContext,
  renderers: ReturnType<typeof queryDomSceneRenderers>,
): QueryDomPlannedScene {
  const result = renderScrollScenePatches(
    renderers.renderClip,
    context.partialPlan.scrollClips,
    state.scrollX,
    state.scrollY,
    context.clientWire,
  );
  return {
    scene: result.scene,
    emittedPartial: true,
    partialClip: result.partialClip,
    extraPatches: result.patches,
  };
}

function renderQueryDomPartialClip(
  context: QueryDomRecordSceneContext,
  renderers: ReturnType<typeof queryDomSceneRenderers>,
  partialClip: NonNullable<ReturnType<typeof planPartialScene>["partialClip"]>,
): QueryDomPlannedScene {
  return {
    scene: renderers.renderClip(
      partialClip.x,
      partialClip.y,
      Math.min(MAX_SCENE_CLIP_DIMENSION_PX, partialClip.w),
      Math.min(MAX_SCENE_CLIP_DIMENSION_PX, partialClip.h),
      false,
      context.clientWire,
    ),
    emittedPartial: true,
    partialClip,
    extraPatches: [],
  };
}

function renderQueryDomCompleteScene(
  context: QueryDomRecordSceneContext,
  renderers: ReturnType<typeof queryDomSceneRenderers>,
): QueryDomPlannedScene {
  const scene = context.clip
    ? renderQueryDomClip(context, renderers)
    : renderers.renderScene(state.scrollX, state.scrollY, 0, 0, context.omitBg, context.clientWire);
  return {
    scene,
    emittedPartial: false,
    partialClip: context.partialPlan.partialClip,
    extraPatches: [],
  };
}

function renderQueryDomClip(
  context: QueryDomRecordSceneContext,
  renderers: ReturnType<typeof queryDomSceneRenderers>,
): Uint8Array | null {
  const clip = context.clip;
  if (!clip) return null;
  return renderers.renderClip(
    Math.floor(clip.x),
    Math.floor(clip.y),
    Math.min(MAX_SCENE_CLIP_DIMENSION_PX, Math.ceil(clip.width)),
    Math.min(MAX_SCENE_CLIP_DIMENSION_PX, Math.ceil(clip.height)),
    context.omitBg,
    context.clientWire,
  );
}

function failedQueryDomScene(
  context: QueryDomRecordSceneContext,
  error: unknown,
  reportMessage: string,
): QueryDomRecordSceneRender {
  invalidatePaintDom();
  reportEngineError("wasm", error, reportMessage);
  let fallbackHtml = "";
  try {
    fallbackHtml = context.pageState.dom.outerHTML(0) || "";
  } catch {}
  return {
    kind: "response",
    response: {
      scene: new Uint8Array(0),
      seq: getInternalState().mutationSeq | 0,
      error: errorMessage(error),
      fallbackHtml,
      scrollX: state.scrollX,
      scrollY: state.scrollY,
    } satisfies QueryDomResult<"recordScene">,
  };
}

function finishQueryDomRecordScene(
  context: QueryDomRecordSceneContext,
  rendered: Extract<QueryDomRecordSceneRender, { kind: "rendered" }>,
): QueryDomResult<"recordScene"> {
  const { internalState, paint } = context;
  const { scene } = rendered;
  const outSeq = getInternalState().mutationSeq | 0;
  commitRecordSceneSequence(internalState, outSeq);
  refreshRecordSceneInkRects(paint, context.partialPlan.inkIds, context.partialPlan.inkNow);
  pinnedAtRecord = recordScenePinnedRects(context, paint);
  saveRecordSceneViewport();
  recheckIntersectionObservers("layout");
  const resourceBatch = inlineQueryDomSceneResources(context, scene);
  return queryDomRecordSceneResponse(context, rendered, outSeq, resourceBatch);
}

function commitRecordSceneSequence(
  internalState: ReturnType<typeof getInternalState>,
  sequence: number,
): void {
  internalState.damageNodes.clear();
  internalState.layoutDirtySinceRecord = false;
  internalState.lastRecordSeq = sequence;
}

function refreshRecordSceneInkRects(
  paint: DomHandle,
  inkIds: number[],
  inkNow: ReturnType<typeof planPartialScene>["inkNow"],
): void {
  ensureRecordSceneInkEntries(inkIds);
  refreshTrackedRecordSceneInkRects(paint, inkNow);
}

function ensureRecordSceneInkEntries(inkIds: number[]): void {
  for (const id of inkIds) {
    if (inkRects.size >= MAX_TRACKED_INK_RECTS) break;
    if (!inkRects.has(id)) inkRects.set(id, []);
  }
}

function refreshTrackedRecordSceneInkRects(
  paint: DomHandle,
  inkNow: ReturnType<typeof planPartialScene>["inkNow"],
): void {
  for (const id of inkRects.keys()) {
    const rect = inkNow.get(id) ?? readInkRect(paint, id);
    if (rect) inkRects.set(id, rect);
    else inkRects.delete(id);
  }
}

function recordScenePinnedRects(
  context: QueryDomRecordSceneContext,
  paint: DomHandle,
): ReturnType<typeof planPartialScene>["pinnedNow"] {
  const { allowPartial, allowScrollShift, scrolled, partialPlan } = context;
  if (!allowPartial || !allowScrollShift || !scrolled) return undefined;
  return partialPlan.pinnedNow ?? readPinnedRects(paint);
}

function saveRecordSceneViewport(): void {
  state.lastRecordScrollX = state.scrollX;
  state.lastRecordScrollY = state.scrollY;
  state.lastRecordViewportW = state.paintViewportW;
  state.lastRecordViewportH = state.paintViewportH;
}

function inlineQueryDomSceneResources(
  context: QueryDomRecordSceneContext,
  scene: Uint8Array,
): Uint8Array | null {
  const { queryArgs, paint } = context;
  if (
    queryArgs.inlineResources !== true ||
    typeof paint.renderSceneInlineResources !== "function"
  ) {
    return null;
  }
  return renderInlineSceneResources(paint, queryArgs, scene);
}

function renderInlineSceneResources(
  paint: DomHandle,
  queryArgs: Record<string, unknown>,
  scene: Uint8Array,
): Uint8Array | null {
  const renderInlineResources = paint.renderSceneInlineResources;
  if (typeof renderInlineResources !== "function") return null;
  try {
    const inlineResourceBatch = renderInlineResources.call(
      paint,
      scene,
      resourceHashes(queryArgs.haveImages),
      resourceHashes(queryArgs.haveFonts),
    );
    return hasInlineResourcePayload(inlineResourceBatch) ? inlineResourceBatch : null;
  } catch {
    return null;
  }
}

function hasInlineResourcePayload(batch: Uint8Array | null): batch is Uint8Array {
  const INLINE_RESOURCE_CAP = 4 * 1024 * 1024;
  return batch !== null && batch.length > 0 && batch.length <= INLINE_RESOURCE_CAP;
}

function queryDomRecordSceneResponse(
  context: QueryDomRecordSceneContext,
  rendered: Extract<QueryDomRecordSceneRender, { kind: "rendered" }>,
  seq: number,
  resourceBatch: Uint8Array | null,
): QueryDomResult<"recordScene"> {
  const { wake, epochDamageSize, epochLayoutDirty, scrolled, scrollDx, scrollDy, baseSeq } =
    context;
  const { scene, emittedPartial, partialClip, extraPatches } = rendered;
  const { skipReason } = context.partialPlan;
  return {
    scene,
    resourceBatch: resourceBatch ?? undefined,
    seq,
    idle: armRecordSceneIdleWake(wake.armWake, seq),
    pumped: wake.pumped,
    pumpMs: wake.pumpMs,
    nextRafDelayMs: wake.nextRafDelayMs,
    partial: emittedPartial,
    clip: recordSceneClip(emittedPartial, partialClip),
    shift: recordSceneShift(emittedPartial, scrolled, scrollDx, scrollDy),
    patches: recordScenePatches(extraPatches),
    baseSeq: recordSceneBaseSeq(emittedPartial, baseSeq),
    scrollX: state.scrollX,
    scrollY: state.scrollY,
    damageCount: epochDamageSize,
    layoutDirty: epochLayoutDirty,
    skipReason: recordSceneSkipReason(emittedPartial, skipReason),
  } satisfies QueryDomResult<"recordScene">;
}

function recordSceneClip(
  emittedPartial: boolean,
  partialClip: ReturnType<typeof planPartialScene>["partialClip"],
): ReturnType<typeof planPartialScene>["partialClip"] | null {
  return emittedPartial ? partialClip : null;
}

function recordSceneShift(
  emittedPartial: boolean,
  scrolled: boolean,
  scrollDx: number,
  scrollDy: number,
): { x: number; y: number } | undefined {
  return emittedPartial && scrolled ? { x: -scrollDx, y: -scrollDy } : undefined;
}

function recordScenePatches(patches: ScenePatch[]): ScenePatch[] | undefined {
  return patches.length > 0 ? patches : undefined;
}

function recordSceneBaseSeq(emittedPartial: boolean, baseSeq: number): number {
  return emittedPartial ? baseSeq : -1;
}

function recordSceneSkipReason(emittedPartial: boolean, skipReason: string): string {
  return emittedPartial ? "" : skipReason;
}

async function queryDomGetFontUrlData(
  queryArgs: Record<string, unknown>,
): Promise<QueryDomResult<"getFontUrlData">> {
  const url = String(queryArgs.url || "") || fontUrlForKey(String(queryArgs.key || ""));
  if (!url) return { bytes: null, error: "no url" } satisfies QueryDomResult<"getFontUrlData">;
  return resolveQueryDomFontUrlData(url);
}

async function resolveQueryDomFontUrlData(url: string): Promise<QueryDomResult<"getFontUrlData">> {
  try {
    const bytes = await resolveFontUrlData(url);
    return (
      bytes && bytes.length > 0 ? { bytes } : { bytes: null, error: "unresolvable" }
    ) satisfies QueryDomResult<"getFontUrlData">;
  } catch (e) {
    return {
      bytes: null,
      error: errorMessage(e),
    } satisfies QueryDomResult<"getFontUrlData">;
  }
}

function queryDomGetPaintResources(
  pageState: QueryDomActiveState,
  queryArgs: Record<string, unknown>,
): QueryDomResult<"getPaintResources"> {
  const toU8 = (v: unknown) =>
    v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(0);
  const imageHashes = toU8(queryArgs.imageHashes);
  const fontDataHashes = toU8(queryArgs.fontDataHashes);
  let batch: Uint8Array = new Uint8Array(0);
  try {
    batch = pageState.dom.renderRbiResources(
      new Uint8Array(0),
      new Uint8Array(0),
      imageHashes,
      fontDataHashes,
    );
  } catch (e) {
    return {
      batch,
      error: errorMessage(e),
    } satisfies QueryDomResult<"getPaintResources">;
  }
  return { batch } satisfies QueryDomResult<"getPaintResources">;
}

function queryDomHasPendingCriticalResources(
  pageState: QueryDomActiveState,
): QueryDomResult<"hasPendingCriticalResources"> {
  try {
    return {
      pending: !!pageState.dom.hasPendingCriticalResources(),
    } satisfies QueryDomResult<"hasPendingCriticalResources">;
  } catch {
    return {
      pending: false,
      error: "unavailable",
    } satisfies QueryDomResult<"hasPendingCriticalResources">;
  }
}

function queryDomRecordPdfScenes(
  queryArgs: Record<string, unknown>,
): QueryDomResult<"recordPdfScenes"> {
  const { width, height } = pdfPaperDimensions(queryArgs);
  const { paint, fresh: isFreshPaint } = takePaintPrep();
  if (!paint) return pdfSceneFailure("ensurePaintDom returned null");
  prepareCachedPaint(paint, isFreshPaint, cascadeSeq, cascadeSeq);
  return renderPdfSceneEnvelope(paint, queryArgs, width, height);
}

const DEFAULT_PDF_PAPER_WIDTH_CSS_PX = 816;
const DEFAULT_PDF_PAPER_HEIGHT_CSS_PX = 1056;

function pdfPaperDimensions(queryArgs: Record<string, unknown>): { width: number; height: number } {
  return {
    width: pdfPaperDimension(queryArgs.width, DEFAULT_PDF_PAPER_WIDTH_CSS_PX),
    height: pdfPaperDimension(queryArgs.height, DEFAULT_PDF_PAPER_HEIGHT_CSS_PX),
  };
}

function pdfPaperDimension(value: unknown, fallback: number): number {
  return typeof value === "number" && value > 0 ? value | 0 : fallback;
}

function pdfMarginPixels(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function renderPdfSceneEnvelope(
  paint: DomHandle,
  queryArgs: Record<string, unknown>,
  width: number,
  height: number,
): QueryDomResult<"recordPdfScenes"> {
  try {
    const recordPdfScenes = paint.recordPdfScenes;
    if (typeof recordPdfScenes !== "function")
      return pdfSceneFailure("recordPdfScenes not exported");
    const envelope = recordPdfScenes.call(
      paint,
      width,
      height,
      pdfMarginPixels(queryArgs.marginTop),
      pdfMarginPixels(queryArgs.marginRight),
      pdfMarginPixels(queryArgs.marginBottom),
      pdfMarginPixels(queryArgs.marginLeft),
    );
    if (!envelope || envelope.length === 0) return pdfSceneFailure("empty pdf scene envelope");
    return { envelope } satisfies QueryDomResult<"recordPdfScenes">;
  } catch (e) {
    invalidatePaintDom();
    return pdfSceneFailure(errorMessage(e));
  }
}

function pdfSceneFailure(error: string): QueryDomResult<"recordPdfScenes"> {
  return { envelope: new Uint8Array(0), error } satisfies QueryDomResult<"recordPdfScenes">;
}

type QueryDomPaintGeometryMethod = Extract<
  QueryDomMethod,
  "getComputedStyle" | "getRect" | "elementFromPoint"
>;

function queryDomPaintGeometry(
  method: QueryDomPaintGeometryMethod,
  queryArgs: Record<string, unknown>,
): QueryDomResult<QueryDomPaintGeometryMethod> {
  switch (method) {
    case "getComputedStyle":
      return queryDomComputedStyle(queryArgs);
    case "getRect":
      return queryDomRect(queryArgs);
    case "elementFromPoint":
      return queryDomElementFromPoint(queryArgs);
  }
}

function queryDomComputedStyle(
  queryArgs: Record<string, unknown>,
): QueryDomResult<"getComputedStyle"> {
  const id = numericNodeId(queryArgs);
  if (id === null) return { computedStyle: [] } satisfies QueryDomResult<"getComputedStyle">;
  const props = computedStyleForAuthId(id);
  return {
    computedStyle: (props ?? []).map(({ name, value }) => ({ name, value })),
  } satisfies QueryDomResult<"getComputedStyle">;
}

function queryDomRect(queryArgs: Record<string, unknown>): QueryDomResult<"getRect"> {
  const id = numericNodeId(queryArgs);
  if (id === null) return { rect: null } satisfies QueryDomResult<"getRect">;
  const paint = ensurePaintDom();
  if (!paint) return { rect: null } satisfies QueryDomResult<"getRect">;
  try {
    const range: unknown = paint.getBoundingClientRect(id);
    return { rect: rectWithScrollOffsetFromWasm(range) } satisfies QueryDomResult<"getRect">;
  } catch {
    invalidatePaintDom();
    return { rect: null } satisfies QueryDomResult<"getRect">;
  }
}

function rectWithScrollOffsetFromWasm(range: unknown): QueryDomResult<"getRect">["rect"] {
  if (!isWasmBoundingRect(range)) return null;
  return {
    ...range,
    x: (Number(range.x) || 0) - state.scrollX,
    y: (Number(range.y) || 0) - state.scrollY,
  };
}

function queryDomElementFromPoint(
  queryArgs: Record<string, unknown>,
): QueryDomResult<"elementFromPoint"> {
  const clientX = queryCoordinate(queryArgs.x);
  const clientY = queryCoordinate(queryArgs.y);
  const paint = ensurePaintDom();
  if (!paint) return { nodeId: -1 } satisfies QueryDomResult<"elementFromPoint">;
  try {
    const id = paint.elementFromPoint(clientX + state.scrollX, clientY + state.scrollY);
    return { nodeId: paintNodeId(id) } satisfies QueryDomResult<"elementFromPoint">;
  } catch {
    invalidatePaintDom();
    return { nodeId: -1 } satisfies QueryDomResult<"elementFromPoint">;
  }
}

function queryCoordinate(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function paintNodeId(id: unknown): number {
  return typeof id === "number" && id >= 0 ? id : -1;
}

async function queryDomNotRenderedNodeIds(
  queryArgs: Record<string, unknown>,
): Promise<QueryDomResult<"notRenderedNodeIds">> {
  await awaitDeferredFonts();
  const paint = ensurePaintDom();
  if (!paint)
    return { displayNone: [], invisible: [] } satisfies QueryDomResult<"notRenderedNodeIds">;
  return readNotRenderedNodeIds(paint, queryArgs);
}

function readNotRenderedNodeIds(
  paint: DomHandle,
  queryArgs: Record<string, unknown>,
): QueryDomResult<"notRenderedNodeIds"> {
  try {
    const before = getInternalState().mutationSeq | 0;
    // Call through DomHandle rather than asserting a local method shape.
    const renderStatus: unknown = paint.notRenderedNodeIds();
    return {
      displayNone: Array.from(notRenderedNodeIdsFromStatus(renderStatus, "displayNone")),
      invisible: Array.from(notRenderedNodeIdsFromStatus(renderStatus, "invisible")),
      ...(queryArgs.includeReadStamp === true
        ? {
            readStamp: {
              before,
              after: getInternalState().mutationSeq | 0,
              complete: true,
            },
          }
        : {}),
    } satisfies QueryDomResult<"notRenderedNodeIds">;
  } catch {
    invalidatePaintDom();
    return { displayNone: [], invisible: [] } satisfies QueryDomResult<"notRenderedNodeIds">;
  }
}

function notRenderedNodeIdsFromStatus(value: unknown, key: string): number[] {
  const ids = isObjectRecord(value) ? value[key] : undefined;
  return isNumberArray(ids) ? ids : [];
}

function queryDomSetViewport(
  pageState: QueryDomActiveState,
  queryArgs: Record<string, unknown>,
): QueryDomResult<"setViewport"> {
  const viewportWidth = viewportDimension(queryArgs.width, DEFAULT_VIEWPORT_WIDTH_PX);
  const viewportHeight = viewportDimension(queryArgs.height, DEFAULT_VIEWPORT_HEIGHT_PX);
  updateViewportDimensions(viewportWidth, viewportHeight);
  writeViewportToInternalState(viewportWidth, viewportHeight);
  return applyDomViewport(pageState, viewportWidth, viewportHeight);
}

function viewportDimension(value: unknown, fallback: number): number {
  return typeof value === "number" ? Math.max(1, Math.floor(value)) : fallback;
}

function updateViewportDimensions(width: number, height: number): void {
  const dimsChanged = state.paintViewportW !== width || state.paintViewportH !== height;
  state.paintViewportW = width;
  state.paintViewportH = height;
  if (dimsChanged) {
    incrementViewportMutationSequence();
  }
}

function incrementViewportMutationSequence(): void {
  try {
    const internalState = getInternalState();
    internalState.mutationSeq = (internalState.mutationSeq | 0) + 1;
  } catch {}
}

function writeViewportToInternalState(width: number, height: number): void {
  try {
    const internalState = getInternalState();
    internalState.viewportW = width;
    internalState.viewportH = height;
  } catch {}
}

function applyDomViewport(
  pageState: QueryDomActiveState,
  width: number,
  height: number,
): QueryDomResult<"setViewport"> {
  try {
    pageState.dom.setViewport(width, height);
    setScrollOffset(state.scrollX, state.scrollY);
    return {
      ok: true,
      width,
      height,
      scrollX: state.scrollX,
      scrollY: state.scrollY,
    } satisfies QueryDomResult<"setViewport">;
  } catch (e) {
    return {
      ok: false,
      error: String((e && (e as Error).message) || e),
    } satisfies QueryDomResult<"setViewport">;
  }
}

function queryDomSetMediaType(
  pageState: QueryDomActiveState,
  queryArgs: Record<string, unknown>,
): QueryDomResult<"setMediaType"> {
  const mediaType = queryDomMediaType(queryArgs);
  const normalised = normalizeMediaType(mediaType);
  const changed = state.currentMediaType !== normalised;
  const quiet = Boolean(queryArgs.quiet);
  try {
    applyQueryDomMediaType(pageState, mediaType, normalised, changed, quiet);
    return {
      ok: true,
      media: state.currentMediaType,
      changed,
    } satisfies QueryDomResult<"setMediaType">;
  } catch (e) {
    return {
      ok: false,
      error: String((e && (e as Error).message) || e),
    } satisfies QueryDomResult<"setMediaType">;
  }
}

function queryDomMediaType(queryArgs: Record<string, unknown>): string {
  return typeof queryArgs.media === "string" ? queryArgs.media : "";
}

function normalizeMediaType(mediaType: string): "print" | "screen" {
  return mediaType === "print" ? "print" : "screen";
}

function applyQueryDomMediaType(
  pageState: QueryDomActiveState,
  mediaType: string,
  normalised: "print" | "screen",
  changed: boolean,
  quiet: boolean,
): void {
  pageState.dom.setMediaType(mediaType);
  updatePaintCacheMediaType(mediaType);
  state.currentMediaType = normalised;
  recordMediaTypeMutation(changed, quiet);
}

function updatePaintCacheMediaType(mediaType: string): void {
  if (!state.paintCacheHandle) return;
  try {
    state.paintCacheHandle.setMediaType(mediaType);
  } catch {}
}

function recordMediaTypeMutation(changed: boolean, quiet: boolean): void {
  if (!changed || quiet) return;
  try {
    const internalState = getInternalState();
    internalState.mutationSeq = (internalState.mutationSeq | 0) + 1;
  } catch {}
}

function queryDomSetSuppressBackgrounds(
  queryArgs: Record<string, unknown>,
): QueryDomResult<"setSuppressBackgrounds"> {
  const enabled = !!(queryArgs && queryArgs.enabled);
  try {
    const doc = state.document as any;
    if (!doc)
      return { ok: false, error: "no document" } satisfies QueryDomResult<"setSuppressBackgrounds">;
    const existing = existingBackgroundStyle(doc);
    return enabled
      ? enableBackgroundSuppression(doc, existing)
      : disableBackgroundSuppression(existing);
  } catch (e) {
    return suppressBackgroundFailure(e);
  }
}

const SUPPRESS_BACKGROUND_STYLE_ID = "__ks_no_bg";

function existingBackgroundStyle(doc: any): any {
  return typeof doc.getElementById === "function"
    ? doc.getElementById(SUPPRESS_BACKGROUND_STYLE_ID)
    : null;
}

function enableBackgroundSuppression(
  doc: any,
  existing: any,
): QueryDomResult<"setSuppressBackgrounds"> {
  if (existing)
    return { ok: true, changed: false } satisfies QueryDomResult<"setSuppressBackgrounds">;
  const style = doc.createElement("style");
  style.id = SUPPRESS_BACKGROUND_STYLE_ID;
  style.textContent =
    "*,*::before,*::after{" +
    "background-color:transparent !important;" +
    "background-image:none !important;" +
    "}";
  const head = suppressionStyleHead(doc);
  if (!head)
    return { ok: false, error: "no <head>" } satisfies QueryDomResult<"setSuppressBackgrounds">;
  head.appendChild(style);
  return { ok: true, changed: true } satisfies QueryDomResult<"setSuppressBackgrounds">;
}

function suppressionStyleHead(doc: any): any {
  return doc.head || doc.getElementsByTagName?.("head")?.[0];
}

function disableBackgroundSuppression(existing: any): QueryDomResult<"setSuppressBackgrounds"> {
  if (!existing)
    return { ok: true, changed: false } satisfies QueryDomResult<"setSuppressBackgrounds">;
  try {
    existing.parentNode?.removeChild(existing);
    return { ok: true, changed: true } satisfies QueryDomResult<"setSuppressBackgrounds">;
  } catch (error) {
    return suppressBackgroundFailure(error);
  }
}

function suppressBackgroundFailure(error: unknown): QueryDomResult<"setSuppressBackgrounds"> {
  return {
    ok: false,
    error: String((error as any)?.message || error),
  } satisfies QueryDomResult<"setSuppressBackgrounds">;
}

async function queryDomAwaitPendingResources(
  pageState: QueryDomActiveState,
  queryArgs: Record<string, unknown>,
): Promise<QueryDomResult<"awaitPendingResources">> {
  const timeoutMs = pendingResourceTimeout(queryArgs.timeoutMs);
  const drainStartedAt = Date.now();
  const deadline = drainStartedAt + timeoutMs;
  requestPendingFontUpgrade(queryArgs.upgradeFonts);
  if (pageState.dom) demandFacesForScriptText(pageState.dom);
  const fonts = createPendingFontDrain(timeoutMs);
  await waitForPendingFonts(fonts);
  const fontsMs = Date.now() - drainStartedAt;
  const captureRect = captureRectFromPendingScope(pendingResourceScope(queryArgs.scope));
  const images = await drainPendingImages(pageState, captureRect, deadline, drainStartedAt);
  logPendingFontDrain(fonts, fontsMs);
  return pendingResourceDrainReply(images, fonts, fontsMs);
}

const DEFAULT_PENDING_RESOURCE_TIMEOUT_MS = 15000;

function pendingResourceTimeout(value: unknown): number {
  return typeof value === "number" && value > 0 ? value : DEFAULT_PENDING_RESOURCE_TIMEOUT_MS;
}

function requestPendingFontUpgrade(value: unknown): void {
  if (value !== true) return;
  try {
    upgradeToFullFonts();
  } catch {}
}

interface PendingFontDrainState {
  emoji: ReturnType<typeof emojiPendingPromise>;
  cjk: ReturnType<typeof cjkPendingPromise>;
  upgrade: ReturnType<typeof upgradePendingPromise>;
  promises: Promise<void>[];
  timedOut: { value: boolean };
  done: Promise<void>;
}

function createPendingFontDrain(timeoutMs: number): PendingFontDrainState {
  const emoji = emojiPendingPromise();
  const cjk = cjkPendingPromise();
  const upgrade = upgradePendingPromise();
  const promises = pendingFontPromises(emoji, cjk, upgrade);
  const timedOut = { value: false };
  return {
    emoji,
    cjk,
    upgrade,
    promises,
    timedOut,
    done: pendingFontDrainPromise(promises, timeoutMs, timedOut),
  };
}

function pendingFontPromises(
  emoji: ReturnType<typeof emojiPendingPromise>,
  cjk: ReturnType<typeof cjkPendingPromise>,
  upgrade: ReturnType<typeof upgradePendingPromise>,
): Promise<void>[] {
  const promises: Promise<void>[] = [];
  appendPendingFontPromise(promises, emoji);
  appendPendingFontPromise(promises, cjk);
  for (const promise of scriptPendingPromises()) promises.push(promise.catch(() => {}));
  appendPendingFontPromise(promises, upgrade);
  return promises;
}

function appendPendingFontPromise(promises: Promise<void>[], promise: Promise<void> | null): void {
  if (promise) promises.push(promise.catch(() => {}));
}

function pendingFontDrainPromise(
  promises: Promise<void>[],
  timeoutMs: number,
  timedOut: { value: boolean },
): Promise<void> {
  if (promises.length === 0) return NativePromise.resolve();
  return NativePromise.race([
    NativePromise.all(promises).then(() => {}),
    nativeSleep(timeoutMs).then(() => {
      timedOut.value = true;
    }),
  ]);
}

async function waitForPendingFonts(fonts: PendingFontDrainState): Promise<void> {
  if (fonts.promises.length > 0) await fonts.done;
}

type PendingResourceScope =
  | { mode: "viewport" }
  | { mode: "rect"; x: unknown; y: unknown; w: unknown; h: unknown };

function pendingResourceScope(value: unknown): PendingResourceScope | null {
  if (!isObjectRecord(value)) return null;
  if (value.mode === "viewport") return { mode: "viewport" };
  if (value.mode !== "rect") return null;
  return { mode: "rect", x: value.x, y: value.y, w: value.w, h: value.h };
}

function captureRectFromPendingScope(
  scope: PendingResourceScope | null,
): PendingImageCaptureRect | null {
  if (!scope) return null;
  return scope.mode === "viewport"
    ? viewportPendingCaptureRect()
    : explicitPendingCaptureRect(scope);
}

function viewportPendingCaptureRect(): PendingImageCaptureRect {
  return {
    x: state.scrollX,
    y: state.scrollY,
    w: state.paintViewportW,
    h: state.paintViewportH,
  };
}

function explicitPendingCaptureRect(
  scope: Extract<PendingResourceScope, { mode: "rect" }>,
): PendingImageCaptureRect {
  return {
    x: numberOrZero(scope.x),
    y: numberOrZero(scope.y),
    w: numberOrZero(scope.w),
    h: numberOrZero(scope.h),
  };
}

function numberOrZero(value: unknown): number {
  return Number(value) || 0;
}

function logPendingFontDrain(fonts: PendingFontDrainState, fontsMs: number): void {
  if (fonts.promises.length === 0) return;
  console.log(
    `[kitesurf-fonts] pre-render font drain settled in ` +
      `${fontsMs}ms (emoji=${!!fonts.emoji} cjk=${!!fonts.cjk} ` +
      `upgrade=${!!fonts.upgrade} timedOut=${fonts.timedOut.value})`,
  );
}

function pendingResourceDrainReply(
  images: PendingImageDrain,
  fonts: PendingFontDrainState,
  fontsMs: number,
): QueryDomResult<"awaitPendingResources"> {
  return {
    ok: true,
    waited: images.waited === true || fonts.promises.length > 0,
    timedOut: images.timedOut === true || fonts.timedOut.value,
    fontsMs,
    fontsTimedOut: fonts.timedOut.value,
    fonts: { emoji: !!fonts.emoji, cjk: !!fonts.cjk, upgrade: !!fonts.upgrade },
    images,
  } satisfies QueryDomResult<"awaitPendingResources">;
}

interface PendingImageCaptureRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PendingImageDom {
  discoverPendingImages?: () => number;
  pendingImagesCount?: () => number;
  pendingImageNodes?: (url: string) => ArrayLike<number>;
  getBoundingClientRect?: (
    id: number,
  ) => { x?: number; y?: number; width?: number; height?: number } | null;
}

interface PendingImageScope {
  dom: PendingImageDom & { discoverPendingImages: () => number };
  captureRect: PendingImageCaptureRect | null;
  rectVerdicts: Map<string, boolean>;
  rectVerdictSeq: number;
}

function hasPendingImageDiscovery(
  dom: PendingImageDom | null,
): dom is PendingImageDom & { discoverPendingImages: () => number } {
  return dom !== null && typeof dom.discoverPendingImages === "function";
}

async function drainPendingImages(
  pageState: QueryDomActiveState,
  captureRect: PendingImageCaptureRect | null,
  deadline: number,
  drainStartedAt: number,
): Promise<PendingImageDrain> {
  const dom = pageState.dom as PendingImageDom | null;
  if (!hasPendingImageDiscovery(dom)) {
    return { waited: false, timedOut: false };
  }
  const scope: PendingImageScope = {
    dom,
    captureRect,
    rectVerdicts: new Map<string, boolean>(),
    rectVerdictSeq: -1,
  };
  preparePendingImagePaint();
  const progress = createPendingImageDrainProgress();
  while (true) {
    samplePendingImageDrain(progress, drainStartedAt);
    progress.pending = updatePendingImageCount(dom, progress, deadline);
    if (pendingImageDrainIsComplete(scope, progress.pending)) break;
    if (Date.now() >= deadline) {
      return reportPendingImageDrainTimeout({
        drainStartedAt,
        waited: progress.waited,
        pending: progress.pending,
        resolves: progress.resolves,
        iterations: progress.iterations,
        iterTimes: progress.iterTimes,
      });
    }
    progress.waited = true;
    await nativeSleep(IMAGE_DRAIN_POLL_INTERVAL_MS);
  }
  return completedPendingImageDrain(progress, drainStartedAt);
}

const MIN_RESOLVE_GAP_MS = 250;
const MAX_IMAGE_DRAIN_ITERATION_SAMPLES = 40;
const IMAGE_DRAIN_POLL_INTERVAL_MS = 25;

interface PendingImageDrainProgress {
  waited: boolean;
  pending: number;
  resolves: number;
  iterations: number;
  lastResolveSheetSeq: number;
  lastResolveAt: number;
  iterTimes: number[];
}

function createPendingImageDrainProgress(): PendingImageDrainProgress {
  return {
    waited: false,
    pending: 0,
    resolves: 0,
    iterations: 0,
    lastResolveSheetSeq: -1,
    lastResolveAt: 0,
    iterTimes: [],
  };
}

function preparePendingImagePaint(): void {
  try {
    ensurePaintDom();
  } catch {}
}

function samplePendingImageDrain(
  progress: PendingImageDrainProgress,
  drainStartedAt: number,
): void {
  progress.iterations++;
  if (progress.iterTimes.length < MAX_IMAGE_DRAIN_ITERATION_SAMPLES) {
    progress.iterTimes.push(Date.now() - drainStartedAt);
  }
}

function updatePendingImageCount(
  dom: PendingImageScope["dom"],
  progress: PendingImageDrainProgress,
  deadline: number,
): number {
  const sheetSeq = getStylesheetDeliverySeq();
  if (shouldRediscoverPendingImages(progress, sheetSeq, deadline)) {
    progress.lastResolveSheetSeq = sheetSeq;
    progress.lastResolveAt = Date.now();
    progress.resolves++;
    return discoverPendingImageCount(dom);
  }
  return readPendingImageCount(dom);
}

function shouldRediscoverPendingImages(
  progress: PendingImageDrainProgress,
  sheetSeq: number,
  deadline: number,
): boolean {
  const resolveDue =
    progress.resolves === 0 ||
    (sheetSeq !== progress.lastResolveSheetSeq &&
      Date.now() - progress.lastResolveAt >= MIN_RESOLVE_GAP_MS);
  return resolveDue && (progress.resolves === 0 || Date.now() < deadline);
}

function discoverPendingImageCount(dom: PendingImageScope["dom"]): number {
  try {
    return dom.discoverPendingImages() | 0;
  } catch {
    return 0;
  }
}

function pendingImageDrainIsComplete(scope: PendingImageScope, pending: number): boolean {
  if (scope.captureRect) return countRelevantInflightImages(scope) === 0;
  return pending === 0 && resourceInflight.size === 0;
}

function completedPendingImageDrain(
  progress: PendingImageDrainProgress,
  drainStartedAt: number,
): PendingImageDrain {
  return {
    waited: progress.waited,
    timedOut: false,
    ms: Date.now() - drainStartedAt,
    pending: 0,
    inflight: 0,
    resolves: progress.resolves,
    iterations: progress.iterations,
    fetchStats: snapshotFetchStats(),
  };
}

function readPendingImageCount(dom: PendingImageDom): number {
  try {
    if (typeof dom.pendingImagesCount === "function") {
      return dom.pendingImagesCount() | 0;
    }
  } catch {}
  return 0;
}

function countRelevantInflightImages(scope: PendingImageScope): number {
  const relevantCount = countNonImageInflightResources();
  if (relevantCount > 0 || !scope.captureRect) return relevantCount;
  resetImageRelevanceCacheForCascade(scope);
  return relevantCount + countRelevantImageResources(scope);
}

function countNonImageInflightResources(): number {
  let count = 0;
  for (const url of resourceInflight) {
    if (!isImageInflight(url)) count++;
  }
  return count;
}

function resetImageRelevanceCacheForCascade(scope: PendingImageScope): void {
  const seqNow = cascadeSeq() | 0;
  if (seqNow !== scope.rectVerdictSeq) {
    scope.rectVerdicts.clear();
    scope.rectVerdictSeq = seqNow;
  }
}

function countRelevantImageResources(scope: PendingImageScope): number {
  let count = 0;
  for (const url of imageInflightUrls()) {
    if (isRelevantImageResource(scope, url)) count++;
  }
  return count;
}

function isRelevantImageResource(scope: PendingImageScope, url: string): boolean {
  const cached = scope.rectVerdicts.get(url);
  if (cached !== undefined) return cached;
  const captureRect = scope.captureRect;
  if (!captureRect) return true;
  const { known, hits } = imageUrlCaptureRelevance(scope.dom, url, captureRect);
  const relevant = hits || !known;
  scope.rectVerdicts.set(url, relevant);
  return relevant;
}

function imageUrlCaptureRelevance(
  dom: PendingImageDom,
  url: string,
  captureRect: PendingImageCaptureRect,
): { known: boolean; hits: boolean } {
  let known = false;
  let hits = false;
  try {
    const ids = pendingImageNodeIds(dom, url);
    for (const id of ids) {
      const result = inspectPendingImageNode(dom, id, captureRect);
      if (result.known) known = true;
      if (result.hits) {
        hits = true;
        break;
      }
    }
  } catch {
    invalidatePaintDom();
    known = false;
  }
  return { known, hits };
}

function pendingImageNodeIds(dom: PendingImageDom, url: string): number[] {
  return dom.pendingImageNodes ? Array.from(dom.pendingImageNodes(url)) : [];
}

function inspectPendingImageNode(
  dom: PendingImageDom,
  id: number,
  captureRect: PendingImageCaptureRect,
): { known: boolean; hits: boolean } {
  const range = dom.getBoundingClientRect ? dom.getBoundingClientRect(id) : null;
  if (!range) return { known: false, hits: false };
  return { known: true, hits: pendingImageRectOverlapsCapture(range, captureRect) };
}

function pendingImageRectOverlapsCapture(
  range: NonNullable<ReturnType<NonNullable<PendingImageDom["getBoundingClientRect"]>>>,
  captureRect: PendingImageCaptureRect,
): boolean {
  const rectX = numberOrZero(range.x);
  const rectY = numberOrZero(range.y);
  const width = numberOrZero(range.width);
  const height = numberOrZero(range.height);
  return (
    rectX < captureRect.x + captureRect.w &&
    rectX + width > captureRect.x &&
    rectY < captureRect.y + captureRect.h &&
    rectY + height > captureRect.y
  );
}

function reportPendingImageDrainTimeout(options: {
  drainStartedAt: number;
  waited: boolean;
  pending: number;
  resolves: number;
  iterations: number;
  iterTimes: number[];
}): PendingImageDrain {
  const currentTime = Date.now();
  const stuck: string[] = [];
  const MAX_STUCK_RESOURCE_URLS_LOGGED = 4;
  for (const url of resourceInflight) {
    const started = inflightStartedAt.get(url);
    stuck.push(`${url}@${started ? currentTime - started : "?"}ms`);
    if (stuck.length >= MAX_STUCK_RESOURCE_URLS_LOGGED) break;
  }
  console.warn(
    `[ks-images] image drain timed out after ${currentTime - options.drainStartedAt}ms: ` +
      `pending=${options.pending} inflight=${resourceInflight.size} ` +
      `resolves=${options.resolves} iterations=${options.iterations}` +
      ` iterTimes=[${options.iterTimes.join(",")}]` +
      (stuck.length ? ` stuck: ${stuck.join(", ")}` : ""),
  );
  return {
    waited: options.waited,
    timedOut: true,
    ms: currentTime - options.drainStartedAt,
    pending: options.pending,
    inflight: resourceInflight.size,
    resolves: options.resolves,
    iterations: options.iterations,
    iterTimes: options.iterTimes,
    fetchStats: snapshotFetchStats(),
  };
}

type QueryDomLayoutSettingsMethod = Extract<
  QueryDomMethod,
  "pageBoxJson" | "setLayoutMode" | "getLayoutMode" | "setCdpDomActive"
>;

function queryDomLayoutSettings(
  pageState: QueryDomActiveState,
  method: QueryDomLayoutSettingsMethod,
  queryArgs: Record<string, unknown>,
): QueryDomResult<QueryDomLayoutSettingsMethod> {
  switch (method) {
    case "pageBoxJson":
      return queryDomPageBoxJson(pageState);
    case "setLayoutMode":
      return queryDomSetLayoutMode(pageState, queryArgs);
    case "getLayoutMode":
      return queryDomGetLayoutMode(pageState);
    case "setCdpDomActive":
      return queryDomSetCdpDomActive(queryArgs);
  }
}

function queryDomPageBoxJson(pageState: QueryDomActiveState): QueryDomResult<"pageBoxJson"> {
  try {
    return { ok: true, json: pageState.dom.pageBoxJson() } satisfies QueryDomResult<"pageBoxJson">;
  } catch (error) {
    return {
      ok: false,
      error: String((error && (error as Error).message) || error),
    } satisfies QueryDomResult<"pageBoxJson">;
  }
}

function queryDomSetLayoutMode(
  pageState: QueryDomActiveState,
  queryArgs: Record<string, unknown>,
): QueryDomResult<"setLayoutMode"> {
  const mode = typeof queryArgs.mode === "string" ? queryArgs.mode : "full";
  return applyQueryDomLayoutMode(pageState, mode);
}

function applyQueryDomLayoutMode(
  pageState: QueryDomActiveState,
  mode: string,
): QueryDomResult<"setLayoutMode"> {
  if (typeof pageState.dom.setLayoutMode !== "function") {
    return {
      ok: false,
      error: "setLayoutMode unsupported in this wasm build",
    } satisfies QueryDomResult<"setLayoutMode">;
  }
  try {
    pageState.dom.setLayoutMode(mode);
    return {
      ok: true,
      mode: queryDomLayoutModeOr(pageState, mode),
    } satisfies QueryDomResult<"setLayoutMode">;
  } catch (error) {
    return {
      ok: false,
      error: String((error && (error as Error).message) || error),
    } satisfies QueryDomResult<"setLayoutMode">;
  }
}

function queryDomLayoutModeOr(pageState: QueryDomActiveState, fallback: string): string {
  return pageState.dom.layoutMode ? pageState.dom.layoutMode() : fallback;
}

function queryDomGetLayoutMode(pageState: QueryDomActiveState): QueryDomResult<"getLayoutMode"> {
  try {
    return {
      mode: pageState.dom.layoutMode ? pageState.dom.layoutMode() : "full",
    } satisfies QueryDomResult<"getLayoutMode">;
  } catch {
    return { mode: "full" } satisfies QueryDomResult<"getLayoutMode">;
  }
}

function queryDomSetCdpDomActive(
  queryArgs: Record<string, unknown>,
): QueryDomResult<"setCdpDomActive"> {
  try {
    ksGlobal.__ks_cdpDomActive = Boolean(queryArgs.active);
  } catch {}
  return { ok: true } satisfies QueryDomResult<"setCdpDomActive">;
}

type QueryDomNodeHandleMethod = Extract<
  QueryDomMethod,
  "describeNode" | "resolveNode" | "getAttributes" | "focus"
>;

function queryDomNodeHandle(
  pageState: QueryDomActiveState,
  method: QueryDomNodeHandleMethod,
  queryArgs: Record<string, unknown>,
): QueryDomResult<QueryDomNodeHandleMethod> {
  switch (method) {
    case "describeNode":
      return queryDomDescribeNode(pageState, queryArgs);
    case "resolveNode":
      return queryDomResolveNode(queryArgs);
    case "getAttributes":
      return queryDomGetAttributes(pageState, queryArgs);
    case "focus":
      return queryDomFocusNode(queryArgs);
  }
}

function queryDomDescribeNode(
  pageState: QueryDomActiveState,
  queryArgs: Record<string, unknown>,
): QueryDomResult<"describeNode"> {
  const id = numericNodeId(queryArgs);
  if (id === null) return emptyDescribedNode();
  try {
    const info = pageState.dom.nodeInfo(id);
    if (info && typeof info === "object") delete info.attributeNamespaces;
    return { node: { ...info, backendNodeId: id } } satisfies QueryDomResult<"describeNode">;
  } catch {
    return emptyDescribedNode();
  }
}

function emptyDescribedNode(): QueryDomResult<"describeNode"> {
  return {
    node: {
      nodeId: 0,
      backendNodeId: 0,
      nodeType: 1,
      nodeName: "",
      localName: "",
      nodeValue: "",
    },
  } satisfies QueryDomResult<"describeNode">;
}

function queryDomResolveNode(queryArgs: Record<string, unknown>): QueryDomResult<"resolveNode"> {
  const id = numericNodeId(queryArgs);
  if (id === null) return {} satisfies QueryDomResult<"resolveNode">;
  const element = state.resolveNodeId(id);
  if (!element) return {} satisfies QueryDomResult<"resolveNode">;
  return {
    object: {
      type: "object",
      subtype: "node",
      className: "Element",
      description: "Element",
      objectId: mintHandle(element),
    },
  } satisfies QueryDomResult<"resolveNode">;
}

function queryDomGetAttributes(
  pageState: QueryDomActiveState,
  queryArgs: Record<string, unknown>,
): QueryDomResult<"getAttributes"> {
  const id = numericNodeId(queryArgs);
  if (id === null) return { attributes: [] } satisfies QueryDomResult<"getAttributes">;
  try {
    const info: unknown = pageState.dom.nodeInfo(id);
    return { attributes: nodeAttributes(info) } satisfies QueryDomResult<"getAttributes">;
  } catch {
    return { attributes: [] } satisfies QueryDomResult<"getAttributes">;
  }
}

function nodeAttributes(info: unknown): string[] {
  const attributes = isObjectRecord(info) ? info.attributes : undefined;
  return isStringArray(attributes) ? attributes : [];
}

function queryDomFocusNode(queryArgs: Record<string, unknown>): QueryDomResult<"focus"> {
  const id = numericNodeId(queryArgs);
  if (id !== null) focusResolvedNode(state.resolveNodeId(id));
  return {} satisfies QueryDomResult<"focus">;
}

function focusResolvedNode(element: ShimElement | null): void {
  if (!element || typeof element.focus !== "function") return;
  try {
    element.focus();
  } catch {}
}

function queryDomPageState(): QueryDomResult<"getPageState"> {
  return {
    seq: getInternalState().mutationSeq | 0,
    scrollX: state.scrollX,
    scrollY: state.scrollY,
    href: readPageStateString(() => ksGlobal.location?.href),
    title: readPageStateString(() => ksGlobal.document?.title),
  } satisfies QueryDomResult<"getPageState">;
}

function readPageStateString(read: () => unknown): string {
  try {
    return String(read() ?? "");
  } catch {
    return "";
  }
}

type QueryDomFormStateMethod = Extract<
  QueryDomMethod,
  "formStateSnapshot" | "setControlValueAsUser"
>;

function queryDomFormState(
  pageState: QueryDomActiveState,
  method: QueryDomFormStateMethod,
  queryArgs: Record<string, unknown>,
): QueryDomResult<QueryDomFormStateMethod> {
  switch (method) {
    case "formStateSnapshot":
      return queryDomFormStateSnapshot(pageState, queryArgs);
    case "setControlValueAsUser":
      return queryDomSetControlValueAsUser(queryArgs);
  }
}

interface FormStateSnapshotValues {
  complete: boolean;
  values: Array<[number, string]>;
  checked: Array<[number, boolean]>;
  selected: Array<[number, boolean]>;
}

function queryDomFormStateSnapshot(
  pageState: QueryDomActiveState,
  queryArgs: Record<string, unknown>,
): QueryDomResult<"formStateSnapshot"> {
  const before = getInternalState().mutationSeq | 0;
  const snapshot: FormStateSnapshotValues = {
    complete: true,
    values: [],
    checked: [],
    selected: [],
  };
  collectFormStateValues(pageState, snapshot);
  return formStateSnapshotReply(queryArgs, before, snapshot);
}

function collectFormStateValues(
  pageState: QueryDomActiveState,
  snapshot: FormStateSnapshotValues,
): void {
  const ids = formStateNodeIds(pageState);
  if (ids === null) snapshot.complete = false;
  for (const id of ids ?? []) {
    snapshot.complete =
      collectFormControlState(id, snapshot.values, snapshot.checked, snapshot.selected) &&
      snapshot.complete;
  }
}

function formStateNodeIds(pageState: QueryDomActiveState): number[] | null {
  try {
    return Array.from(pageState.dom.querySelectorAll("input,textarea,select")).filter(
      (node): node is number => typeof node === "number" && node >= 0,
    );
  } catch {
    return null;
  }
}

function formStateSnapshotReply(
  queryArgs: Record<string, unknown>,
  before: number,
  snapshot: FormStateSnapshotValues,
): QueryDomResult<"formStateSnapshot"> {
  return {
    values: snapshot.values,
    checked: snapshot.checked,
    selected: snapshot.selected,
    ...(queryArgs.includeReadStamp === true
      ? {
          readStamp: {
            before,
            after: getInternalState().mutationSeq | 0,
            complete: snapshot.complete,
          },
        }
      : {}),
  } satisfies QueryDomResult<"formStateSnapshot">;
}

function queryDomSetControlValueAsUser(
  queryArgs: Record<string, unknown>,
): QueryDomResult<"setControlValueAsUser"> {
  const id = numericNodeId(queryArgs);
  if (id === null)
    return {
      changed: false,
      error: "bad nodeId",
    } satisfies QueryDomResult<"setControlValueAsUser">;
  const element = state.resolveNodeId(id);
  if (!element)
    return {
      changed: false,
      error: "no such node",
    } satisfies QueryDomResult<"setControlValueAsUser">;
  const result = setControlValueAsUser(element, Reflect.get(Object(queryArgs), "value"));
  return {
    ...result,
    value: formControlValue(element),
  } satisfies QueryDomResult<"setControlValueAsUser">;
}

function formControlValue(element: ShimElement): string {
  try {
    return String(element.value ?? "");
  } catch {
    return "";
  }
}

type QueryDomPaintDamageMethod = Extract<QueryDomMethod, "markPaintDamage" | "paintDamageSince">;

function queryDomPaintDamage(
  method: QueryDomPaintDamageMethod,
  queryArgs: Record<string, unknown>,
): QueryDomResult<QueryDomPaintDamageMethod> {
  // Accessibility text can miss restyles such as class-only selection;
  // paint damage records that change.
  const paint = ensurePaintDom();
  if (!paint) return {};
  try {
    return method === "markPaintDamage"
      ? markQueryDomPaintDamage(paint)
      : readQueryDomPaintDamage(paint, queryArgs);
  } catch {
    invalidatePaintDom();
    return {};
  }
}

function markQueryDomPaintDamage(paint: DomHandle): QueryDomResult<"markPaintDamage"> {
  paint.paintDamageMark?.();
  return {};
}

function readQueryDomPaintDamage(
  paint: DomHandle,
  queryArgs: Record<string, unknown>,
): QueryDomResult<"paintDamageSince"> {
  const raw = String(paint.paintDamageSince?.(numericNodeId(queryArgs) ?? 0) ?? "");
  return raw ? JSON.parse(raw) : {};
}

function queryDomMemoryStats(): QueryDomResult<"getMemoryStats"> {
  const bytes = getCoreWasmMemoryBytes();
  const initialBytes = getCoreWasmMemoryInitialBytes();
  return {
    bytes,
    initialBytes,
    deltaBytes: Math.max(0, bytes - initialBytes),
    bridge: readBridgeMemoryStats(),
    domFastpath: readDomFastpathMemoryStats(),
    domNodes: readDomNodeMemoryCount(),
    wrappers: detachedWrapperStats(),
    paint: paintPrepStats(),
    intersectionObserver: intersectionObserverStats(),
    timerWheel: { ...timerWheelStats(), shim: deferShimStats() },
  } satisfies QueryDomResult<"getMemoryStats">;
}

type BridgeMemoryStats = NonNullable<QueryDomResult<"getMemoryStats">["bridge"]>;
type BridgePinStats = Pick<
  BridgeMemoryStats,
  | "v8Pins"
  | "boaPins"
  | "wrappers"
  | "weakBoa"
  | "releasedV8"
  | "releasedBoa"
  | "boaHeapBytes"
  | "boaGcThreshold"
  | "internerLen"
  | "internerReclaims"
  | "internerPendingMods"
  | "internerQueueIdle"
  | "ctxReentryDepth"
  | "ctxReentryMax"
  | "ctxUnchaperoned"
  | "pumpPromiseJobs"
  | "pumpFutures"
  | "pumpDrainBusy"
  | "pumpTicketWaiters"
  | "bgTicks"
  | "bgProgress"
  | "bgLastTickMs"
  | "healedAtEntry"
>;
type CycleCollectorStats = Pick<
  BridgeMemoryStats,
  | "ccRuns"
  | "ccGrayPins"
  | "ccWeakV8"
  | "ccDeadV8"
  | "ccWeakened"
  | "ccRevoked"
  | "ccDeadReads"
  | "ccLastMs"
  | "ccSkipped"
>;

// Rust emits these fixed, disjoint field sets from the two wasm stats exports.
function readBridgeMemoryStats(): BridgeMemoryStats | null {
  try {
    const bridgePins: BridgePinStats = JSON.parse(ks_bridge_pins());
    const cycleStats: CycleCollectorStats = JSON.parse(ks_cycle_stats());
    return { ...bridgePins, ...cycleStats };
  } catch {
    return null;
  }
}

function readDomFastpathMemoryStats(): QueryDomResult<"getMemoryStats">["domFastpath"] {
  try {
    return JSON.parse(state.dom?.fastpathStats?.() ?? "null");
  } catch {
    return null;
  }
}

function readDomNodeMemoryCount(): number | null {
  try {
    return state.dom?.nodeCount?.() ?? null;
  } catch {
    return null;
  }
}

type QueryDomDiagnosticsMethod = Extract<
  QueryDomMethod,
  "boaForceCollect" | "getFontFaces" | "getMemprofDump" | "resetMemprof"
>;

function queryDomDiagnostics(
  method: QueryDomDiagnosticsMethod,
): QueryDomResult<QueryDomDiagnosticsMethod> {
  switch (method) {
    case "boaForceCollect":
      return queryDomForceCollect();
    case "getFontFaces":
      return queryDomFontFaces();
    case "getMemprofDump":
      return queryDomMemprofDump();
    case "resetMemprof":
      return queryDomResetMemprof();
  }
}

function queryDomForceCollect(): QueryDomResult<"boaForceCollect"> {
  try {
    const collected = JSON.parse(ks_boa_force_collect());
    ks_cycle_collect(false);
    return collected satisfies QueryDomResult<"boaForceCollect">;
  } catch (error) {
    return { error: diagnosticErrorMessage(error) } satisfies QueryDomResult<"boaForceCollect">;
  }
}

function queryDomFontFaces(): QueryDomResult<"getFontFaces"> {
  try {
    return { json: font_families_json() } satisfies QueryDomResult<"getFontFaces">;
  } catch (error) {
    return { error: diagnosticErrorMessage(error) } satisfies QueryDomResult<"getFontFaces">;
  }
}

function queryDomMemprofDump(): QueryDomResult<"getMemprofDump"> {
  const dump = ksGlobal.__memprof_dump;
  if (typeof dump !== "function") return missingMemprofRecorder();
  try {
    return { json: dump() } satisfies QueryDomResult<"getMemprofDump">;
  } catch (error) {
    return { error: diagnosticErrorMessage(error) } satisfies QueryDomResult<"getMemprofDump">;
  }
}

function queryDomResetMemprof(): QueryDomResult<"resetMemprof"> {
  const reset = ksGlobal.__memprof_reset;
  if (typeof reset !== "function") return missingMemprofRecorder();
  try {
    reset();
    return { ok: true } satisfies QueryDomResult<"resetMemprof">;
  } catch (error) {
    return { error: diagnosticErrorMessage(error) } satisfies QueryDomResult<"resetMemprof">;
  }
}

function missingMemprofRecorder(): { error: string } {
  return { error: "memprof recorder not installed (build with KITESURF_MEMPROF=1)" };
}

function diagnosticErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type QueryDomWebMcpReadMethod = Extract<
  QueryDomMethod,
  "webmcpGetTools" | "webmcpStopWatchingTools" | "webmcpCancelTool"
>;

function queryDomWebMcpRead(
  method: QueryDomWebMcpReadMethod,
  queryArgs: Record<string, unknown>,
): QueryDomResult<QueryDomWebMcpReadMethod> {
  switch (method) {
    case "webmcpGetTools": {
      try {
        return {
          tools: listModelContextTools(queryArgs.watchRevision),
        } satisfies QueryDomResult<"webmcpGetTools">;
      } catch (err) {
        return {
          tools: [],
          error: err instanceof Error ? err.message : String(err),
        } satisfies QueryDomResult<"webmcpGetTools">;
      }
    }
    case "webmcpStopWatchingTools": {
      stopModelContextToolWatch(queryArgs.watchRevision);
      return {} satisfies QueryDomResult<"webmcpStopWatchingTools">;
    }
    case "webmcpCancelTool": {
      return {
        aborted: cancelModelContextTool(queryArgs.invocationId),
      } satisfies QueryDomResult<"webmcpCancelTool">;
    }
  }
}

async function queryDomWebMcpCall(
  queryArgs: Record<string, unknown>,
): Promise<QueryDomResult<"webmcpCallTool">> {
  const result = await callModelContextTool(
    String(queryArgs.name ?? ""),
    queryArgs.args,
    queryArgs.invocationId,
  );
  for (let i = 0; i < 3; i++) {
    await yieldToPageTasks();
  }
  return result satisfies QueryDomResult<"webmcpCallTool">;
}

function hasControlChar(text: string): boolean {
  const ASCII_CONTROL_RANGE_END_EXCLUSIVE = 0x20;
  const ASCII_DELETE_CODE_POINT = 0x7f;
  for (let i = 0; i < text.length; i++) {
    const codeUnit = text.charCodeAt(i);
    if (codeUnit < ASCII_CONTROL_RANGE_END_EXCLUSIVE || codeUnit === ASCII_DELETE_CODE_POINT)
      return true;
  }
  return false;
}

function sourceDoctypeOf(html: string): { markup: string; end: number } | null {
  const match = html.match(/^((?:\s|<!--[\s\S]*?-->)*)(<!doctype\b[^>]*>)/i);
  const raw = match?.[2];
  if (!raw) return null;
  const prefix = match?.[1] ?? "";
  const end = prefix.length + raw.length;
  return { markup: normalizeDoctypeMarkup(raw), end };
}

function normalizeDoctypeMarkup(raw: string): string {
  const parsed = raw
    .slice("<!doctype".length, -1)
    .trim()
    .match(
      /^([^\s>]+)(?:\s+(PUBLIC|SYSTEM)\s+(?:"([^"]*)"|'([^']*)')(?:\s+(?:"([^"]*)"|'([^']*)'))?)?$/i,
    );
  if (!parsed) return raw;
  return formatDoctypeMarkup(doctypePartsFromMatch(parsed));
}

function doctypePartsFromMatch(parsed: RegExpMatchArray): DoctypeParts {
  return {
    name: doctypeName(parsed[1]),
    keyword: uppercaseDoctypeKeyword(parsed[2]),
    firstId: firstDoctypeId(parsed[3], parsed[4]),
    secondId: firstDoctypeId(parsed[5], parsed[6]),
  };
}

function doctypeName(value: string | undefined): string {
  return value ? value.toLowerCase() : "html";
}

function uppercaseDoctypeKeyword(value: string | undefined): string | undefined {
  return value ? value.toUpperCase() : undefined;
}

function firstDoctypeId(first: string | undefined, second: string | undefined): string | undefined {
  return first ?? second;
}

interface DoctypeParts {
  name: string;
  keyword: string | undefined;
  firstId: string | undefined;
  secondId: string | undefined;
}

function formatDoctypeMarkup(parts: DoctypeParts): string {
  const publicMarkup = publicDoctypeMarkup(parts);
  if (publicMarkup) return publicMarkup;
  const systemMarkup = systemDoctypeMarkup(parts);
  if (systemMarkup) return systemMarkup;
  return `<!DOCTYPE ${parts.name}>`;
}

function publicDoctypeMarkup(parts: DoctypeParts): string | null {
  if (parts.keyword !== "PUBLIC" || parts.firstId === undefined) return null;
  const system = parts.secondId === undefined ? "" : ` ${quoteDoctypeId(parts.secondId)}`;
  return `<!DOCTYPE ${parts.name} PUBLIC ${quoteDoctypeId(parts.firstId)}${system}>`;
}

function systemDoctypeMarkup(parts: DoctypeParts): string | null {
  if (parts.keyword !== "SYSTEM" || parts.firstId === undefined) return null;
  return `<!DOCTYPE ${parts.name} SYSTEM ${quoteDoctypeId(parts.firstId)}>`;
}

function quoteDoctypeId(value: string): string {
  return value.includes('"') ? `'${value}'` : `"${value}"`;
}

function numericNodeId(params: Record<string, unknown>): number | null {
  const directNodeId = directNumericNodeId(params);
  if (directNodeId !== null) return directNodeId;
  return numericNodeIdFromHandle(params.objectId);
}

function directNumericNodeId(params: Record<string, unknown>): number | null {
  if (typeof params.nodeId === "number") return params.nodeId;
  if (typeof params.backendNodeId === "number") return params.backendNodeId;
  return null;
}

function numericNodeIdFromHandle(objectId: unknown): number | null {
  if (typeof objectId !== "string") return null;
  if (objectId.startsWith("node:")) return parseNodeHandleId(objectId);
  if (!objectId.startsWith("ps:")) return null;
  return nodeIdFromPageScriptHandle(objectId);
}

function parseNodeHandleId(objectId: string): number | null {
  const nodeId = Number(objectId.slice(5));
  return Number.isFinite(nodeId) ? nodeId : null;
}

function nodeIdFromPageScriptHandle(objectId: string): number | null {
  const nodeObject: unknown = lookupHandle(objectId);
  if (nodeObject === null || (typeof nodeObject !== "object" && typeof nodeObject !== "function")) {
    return null;
  }
  const nodeId: unknown = Reflect.get(nodeObject, "_id");
  if (typeof nodeId === "number") return nodeId;
  return null;
}

export default {
  fetch(): Response {
    return new Response("PageScript", { status: 404 });
  },
};
