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

function afterFontUpgrade(): void {
  try {
    state.dom?.fontsUpgraded?.();
  } catch {}
  try {
    const internalState = getInternalState();
    internalState.mutationSeq = (internalState.mutationSeq | 0) + 1;
    internalState.lastMutationAt = Date.now();
  } catch {}
  try {
    invalidatePaintDom();
  } catch {}
}
setFontUpgradeCallback(afterFontUpgrade);

setAuthorFontUpgradeHook(async () => {
  const MAX_FONT_UPGRADE_ERROR_URL_CHARS = 80;
  const dom = state.dom;
  if (!dom || typeof dom.pendingAuthorFontUpgrades !== "function") return;
  let urls: string[] = [];
  try {
    urls = dom.pendingAuthorFontUpgrades() ?? [];
  } catch {}
  const fetched = await Promise.all(
    urls.map(async (url) => {
      try {
        return [url, await resolveFontUrlData(url)] as const;
      } catch (e) {
        console.warn(
          `[kitesurf-fonts] author upgrade fetch ${url.slice(0, MAX_FONT_UPGRADE_ERROR_URL_CHARS)} failed:`,
          String(e),
        );
        return [url, null] as const;
      }
    }),
  );
  for (const [url, bytes] of fetched) {
    if (!bytes || bytes.length === 0) continue;
    try {
      upgradeAuthorFontFace(url, bytes);
    } catch (e) {
      console.warn(
        `[kitesurf-fonts] author upgrade swap ${url.slice(0, MAX_FONT_UPGRADE_ERROR_URL_CHARS)} failed:`,
        String(e),
      );
    }
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
import type { ShimElement } from "./types.ts";
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
import type { BuildDocumentResult } from "./dom-shim.js";

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

function scrollToFragment(url: string): void {
  try {
    const hashIdx = String(url || "").indexOf("#");
    if (hashIdx < 0) return;
    let frag = url.slice(hashIdx + 1);
    try {
      frag = decodeURIComponent(frag);
    } catch {}
    if (!frag) {
      setScrollOffset(state.scrollX, 0);
      return;
    }
    const doc = state.document as FragmentLookupDoc | null;
    if (!doc) return;
    const element = ((doc.getElementById && doc.getElementById(frag)) ||
      (doc.getElementsByName && doc.getElementsByName(frag)[0]) ||
      null) as { scrollIntoView?: () => void } | null;
    if (element && typeof element.scrollIntoView === "function") {
      element.scrollIntoView();
      return;
    }
    if (frag === "top") setScrollOffset(state.scrollX, 0);
  } catch (e) {
    console.error("[kitesurf] scrollToFragment failed:", e);
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
  const dragOrigin = __ksCaretDragOrigin;
  if (eventType !== "mousemove" || !dragOrigin) return left + CARET_CELL_EDGE_INSET_PX;
  const forward = clientY > dragOrigin.y || (clientY === dragOrigin.y && clientX >= dragOrigin.x);
  return forward ? left + cellWidth - CARET_CELL_EDGE_INSET_PX : left + CARET_CELL_EDGE_INSET_PX;
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

function getValueRawOnControl(el: any): string {
  let proto = Object.getPrototypeOf(el);
  while (proto) {
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && typeof desc.get === "function") {
      const value = desc.get.call(el);
      return typeof value === "string" ? value : String(value ?? "");
    }
    proto = Object.getPrototypeOf(proto);
  }
  const value = el.value;
  return typeof value === "string" ? value : String(value ?? "");
}

function isKeyboardActivatable(element: ShimElement): boolean {
  try {
    const tagName = String(element.tagName || "").toUpperCase();
    if (tagName === "BUTTON" || tagName === "SUMMARY") return true;
    if (tagName === "A") return element.getAttribute?.("href") != null;
    if (tagName !== "INPUT") return false;
    const type = String(element.getAttribute?.("type") || "").toLowerCase();
    return (
      type === "button" ||
      type === "submit" ||
      type === "reset" ||
      type === "checkbox" ||
      type === "radio" ||
      type === "image"
    );
  } catch {
    return false;
  }
}

function moveTabFocus(reverse: boolean): void {
  const documentNode = state.document;
  if (!documentNode) return;
  const focusableElements: { element: ShimElement; tabIndex: number; domOrder: number }[] = [];
  const focusableCandidates = documentNode.querySelectorAll(
    "a[href], area[href], button, input, select, textarea, summary, [tabindex], [contenteditable]",
  );
  for (const element of Array.from(focusableCandidates)) {
    const tagName = element.tagName;
    const isFormControl =
      tagName === "BUTTON" || tagName === "INPUT" || tagName === "SELECT" || tagName === "TEXTAREA";
    if (
      isFormControl &&
      (element.hasAttribute?.("disabled") || element.closest?.("fieldset[disabled]"))
    )
      continue;
    if (tagName === "INPUT" && element.type === "hidden") continue;
    if (element.closest?.("[inert]")) continue;

    const rawTabIndex = element.getAttribute?.("tabindex") ?? null;
    const editable = element.getAttribute?.("contenteditable") ?? null;
    const naturallyFocusable =
      isFormControl ||
      tagName === "SUMMARY" ||
      ((tagName === "A" || tagName === "AREA") && element.hasAttribute?.("href")) ||
      (editable !== null && editable.toLowerCase() !== "false");
    const parsedTabIndex =
      rawTabIndex !== null && /^[+-]?\d+$/.test(rawTabIndex.trim())
        ? Number(rawTabIndex.trim())
        : NaN;
    if (!naturallyFocusable && !Number.isFinite(parsedTabIndex)) continue;
    const tabIndex = Number.isFinite(parsedTabIndex) ? parsedTabIndex : 0;
    if (tabIndex < 0) continue;
    if (!element.getClientRects?.()?.length) continue;
    const visibility = state.window?.getComputedStyle?.(element).visibility;
    if (visibility === "hidden" || visibility === "collapse") continue;
    focusableElements.push({ element, tabIndex, domOrder: focusableElements.length });
  }
  if (!focusableElements.length) return;
  focusableElements.sort((first, second) => {
    if (first.tabIndex === 0) {
      return second.tabIndex === 0 ? first.domOrder - second.domOrder : 1;
    }
    if (second.tabIndex === 0) return -1;
    return first.tabIndex - second.tabIndex || first.domOrder - second.domOrder;
  });
  const activeElement = state.getActiveElement();
  const currentIndex = focusableElements.findIndex(({ element }) => element === activeElement);
  const nextIndex =
    currentIndex < 0
      ? reverse
        ? focusableElements.length - 1
        : 0
      : (currentIndex + (reverse ? focusableElements.length - 1 : 1)) % focusableElements.length;
  const nextElement = focusableElements[nextIndex].element;
  nextElement.focus?.();
  if (state.getActiveElement() === nextElement) {
    nextElement.scrollIntoView?.({ block: "nearest", inline: "nearest" });
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

function scrollForKey(key: string, init: KeyScrollInit | undefined): void {
  if (!state.document || init?.altKey || init?.metaKey) return;
  const focused = state.getActiveElement();
  for (
    let element: ShimElement | null | undefined = focused, depth = 0;
    element && depth < MAX_SCROLLABLE_ANCESTOR_DEPTH;
    element = element.parentElement, depth++
  ) {
    if (
      element.tagName === "INPUT" ||
      element.tagName === "TEXTAREA" ||
      element.tagName === "SELECT"
    )
      return;
    const editable = element.getAttribute?.("contenteditable");
    if (editable !== null && editable !== undefined) {
      if (editable.toLowerCase() !== "false") return;
      break;
    }
  }

  const ttyKeyboard = init?.ttyKeyboard === true;
  const cellHeight = Number(ksGlobal.__ks_tty_cell_h) || 0;
  const cellWidth = Number(ksGlobal.__ks_tty_cell_w) || 0;
  const lineHeight = cellHeight || DEFAULT_KEY_SCROLL_STEP_PX;
  const lineWidth = cellWidth || DEFAULT_KEY_SCROLL_STEP_PX;
  const pageHeight = Math.max(lineHeight, state.paintViewportH - lineHeight);
  let scrollDeltaX = 0;
  let scrollDeltaY = 0;
  if (init?.ctrlKey) {
    if (!ttyKeyboard) return;
    const halfPage = Math.max(
      lineHeight,
      Math.floor(state.paintViewportH / (2 * lineHeight)) * lineHeight,
    );
    if (key === "f") scrollDeltaY = pageHeight;
    else if (key === "b") scrollDeltaY = -pageHeight;
    else if (key === "d") scrollDeltaY = halfPage;
    else if (key === "u") scrollDeltaY = -halfPage;
  } else {
    const isSpace = key === " " || key === "Spacebar";
    if (isSpace && (focused?.tagName === "BUTTON" || focused?.tagName === "SUMMARY")) return;
    if (key === "ArrowDown" || (ttyKeyboard && !init?.shiftKey && key === "j")) {
      scrollDeltaY = lineHeight;
    } else if (key === "ArrowUp" || (ttyKeyboard && !init?.shiftKey && key === "k")) {
      scrollDeltaY = -lineHeight;
    } else if (key === "ArrowRight" || (ttyKeyboard && !init?.shiftKey && key === "l")) {
      scrollDeltaX = lineWidth;
    } else if (key === "ArrowLeft" || (ttyKeyboard && !init?.shiftKey && key === "h")) {
      scrollDeltaX = -lineWidth;
    } else if (key === "PageDown" || (isSpace && !init?.shiftKey)) {
      scrollDeltaY = pageHeight;
    } else if (key === "PageUp" || (isSpace && init?.shiftKey)) {
      scrollDeltaY = -pageHeight;
    }
  }
  if (!scrollDeltaX && !scrollDeltaY) return;
  const scrollTarget = focused || state.document.body;
  const scrollByWheel: unknown = ksGlobal.__ks_scrollByWheel;
  if (typeof scrollByWheel === "function" && typeof scrollTarget?._id === "number") {
    try {
      if (scrollByWheel(scrollTarget._id, scrollDeltaX, scrollDeltaY)) return;
    } catch (error) {
      console.warn("[kitesurf-tty] scrollByWheel failed:", String(error));
    }
  }
  scrollBy(scrollDeltaX, scrollDeltaY);
}

const MAX_ANCESTOR_CHAIN_NODES = 512;

function __ksAncestorChain(node: any): any[] {
  const chain: any[] = [];
  let currentNode = node;
  for (let depth = 0; currentNode && depth < MAX_ANCESTOR_CHAIN_NODES; depth++) {
    chain.push(currentNode);
    let next: any = null;
    try {
      next = currentNode.parentNode || null;
    } catch {
      next = null;
    }
    if (next === currentNode) break;
    currentNode = next;
  }
  return chain;
}

function __ksCommonAncestor(firstNode: any, secondNode: any): any {
  if (!firstNode || !secondNode) return null;
  if (firstNode === secondNode) return firstNode;
  const secondAncestorChain = __ksAncestorChain(secondNode);
  for (const node of __ksAncestorChain(firstNode)) {
    if (secondAncestorChain.indexOf(node) !== -1) return node;
  }
  return null;
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
      new EventConstructor(type, {
        ...init,
        ...(pointer ? { pointerId: 1, pointerType: "mouse", isPrimary: true } : {}),
        bubbles,
        cancelable: bubbles,
        composed: bubbles,
        button: 0,
        detail: 0,
        relatedTarget: related || null,
      }),
    );
  } catch {}
}

function __ksDispatchBoundaryEvents(from: any, to: any, init: any): void {
  const common = __ksCommonAncestor(from, to);
  const fire = (node: any, type: string, related: any, bubbles: boolean) =>
    __ksFireBoundaryEvent(node, type, related, bubbles, init);
  const isElement = (node: any) => {
    try {
      return node && node.nodeType === 1;
    } catch {
      return false;
    }
  };
  for (const kind of ["pointer", "mouse"]) {
    if (from) {
      fire(from, `${kind}out`, to, true);
      for (const node of __ksAncestorChain(from)) {
        if (node === common) break;
        if (isElement(node)) fire(node, `${kind}leave`, to, false);
      }
    }
    if (to) {
      fire(to, `${kind}over`, from, true);
      const entered: any[] = [];
      for (const node of __ksAncestorChain(to)) {
        if (node === common) break;
        if (isElement(node)) entered.push(node);
      }
      for (let i = entered.length - 1; i >= 0; i--) {
        fire(entered[i], `${kind}enter`, from, false);
      }
    }
  }
}

function __wireContentWindowPostMessage(contentWindow: any, iframeElement: any) {
  contentWindow.postMessage = function (...args: any[]) {
    if (args.length === 0) {
      throw new TypeError(
        "Failed to execute 'postMessage' on 'Window': 1 argument required, but only 0 present.",
      );
    }
    const message = args[0];
    let targetOrigin: any = args[1];
    let rawTransfer: any = args.length >= 3 ? args[2] : undefined;
    if (
      args.length < 3 &&
      targetOrigin !== undefined &&
      (targetOrigin === null || typeof targetOrigin === "object")
    ) {
      rawTransfer = targetOrigin === null ? undefined : targetOrigin.transfer;
      targetOrigin = targetOrigin === null ? undefined : targetOrigin.targetOrigin;
    }
    const transfer: any[] = [];
    if (rawTransfer !== undefined) {
      if (
        rawTransfer === null ||
        typeof rawTransfer !== "object" ||
        typeof rawTransfer[Symbol.iterator] !== "function"
      ) {
        throw new TypeError(
          "Failed to execute 'postMessage' on 'Window': The provided value cannot be converted to a sequence.",
        );
      }
      for (const transferable of rawTransfer) {
        if (
          transferable === null ||
          (typeof transferable !== "object" && typeof transferable !== "function")
        ) {
          throw new TypeError(
            "Failed to execute 'postMessage' on 'Window': Transferable entry is not an object.",
          );
        }
        transfer.push(transferable);
      }
    }
    let dataJson: string;
    try {
      dataJson = JSON.stringify(message === undefined ? null : message) ?? "null";
    } catch {
      const DOMExceptionConstructor: any = ksGlobal.DOMException;
      throw DOMExceptionConstructor
        ? new DOMExceptionConstructor("The object could not be cloned.", "DataCloneError")
        : new Error("DataCloneError: the object could not be cloned.");
    }
    const targetOriginValue = targetOrigin === undefined ? "/" : String(targetOrigin);
    if (targetOriginValue !== "*" && targetOriginValue !== "/") {
      try {
        new URL(targetOriginValue);
      } catch {
        const DOMExceptionConstructor: any = ksGlobal.DOMException;
        const message = `Failed to execute 'postMessage' on 'Window': Invalid target origin '${targetOriginValue}'.`;
        throw DOMExceptionConstructor
          ? new DOMExceptionConstructor(message, "SyntaxError")
          : new Error(message);
      }
    }
    const MessagePortConstructor: any = ksGlobal.MessagePort;
    const dataCloneError = (message: string) => {
      const DOMExceptionConstructor: any = ksGlobal.DOMException;
      return typeof DOMExceptionConstructor === "function"
        ? new DOMExceptionConstructor(message, "DataCloneError")
        : Object.assign(new Error(message), { name: "DataCloneError" });
    };
    const seen = new Set();
    for (const transferable of transfer) {
      if (seen.has(transferable)) {
        throw dataCloneError("Duplicate transferable in transfer list.");
      }
      seen.add(transferable);
      if (
        typeof MessagePortConstructor === "function" &&
        transferable instanceof MessagePortConstructor
      ) {
        if (transferable._closed || transferable._detached) {
          throw dataCloneError("MessagePort is already detached.");
        }
      } else if (transferable instanceof ArrayBuffer) {
        if (transferable.detached === true) {
          throw dataCloneError("ArrayBuffer is already detached.");
        }
      } else {
        throw dataCloneError("Value is not transferable.");
      }
    }
    for (const transferable of transfer) {
      if (
        typeof MessagePortConstructor === "function" &&
        transferable instanceof MessagePortConstructor
      ) {
        if (typeof transferable.__ksTransfer === "function") transferable.__ksTransfer();
      } else if (typeof transferable.transfer === "function") {
        transferable.transfer();
      }
    }
    let sourceOrigin = "";
    try {
      sourceOrigin = new URL(state.pageUrl || "").origin;
    } catch {}
    sendUpstreamEvent({
      event: "kitesurf.postMessage",
      params: {
        toFrameOwnerId: typeof iframeElement?._id === "number" ? iframeElement._id : -1,
        dataJson,
        targetOrigin: targetOriginValue,
        sourceOrigin,
      },
    });
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

function __makeFacadeLocation(iframeEl: object, url: string, contentWindow: object) {
  let current = url;
  const loc: FacadeLocation = {
    get href() {
      return current;
    },
    set href(v: string) {
      const href = locationInputString(v);
      let resolved = "";
      try {
        resolved = new URL(href, state.document?.baseURI || state.pageUrl || undefined).toString();
      } catch {
        const error = new DOMException("Invalid URL", "SyntaxError");
        const frameWindow: unknown = Reflect.get(iframeEl, "__ks_iframeContentWindow", iframeEl);
        const FrameDOMException: unknown =
          Reflect.get(contentWindow, "DOMException", contentWindow) ??
          (isObjectRecord(frameWindow)
            ? Reflect.get(frameWindow, "DOMException", frameWindow)
            : undefined);
        if (typeof FrameDOMException === "function") {
          Object.defineProperty(error, "constructor", { value: FrameDOMException });
        }
        throw error;
      }
      current = resolved;
      try {
        handleIframeSrcChange(iframeEl, resolved);
      } catch (error) {
        warnIframeFailure(error, { operation: "navigate location", url: resolved });
      }
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

function preinstallStaticIframes() {
  const document = ksGlobal.document;
  if (!document || typeof document.querySelectorAll !== "function") return;
  const DOMParserConstructor = ksGlobal.DOMParser;
  if (!DOMParserConstructor) return;
  let iframeElements: any;
  try {
    iframeElements = document.querySelectorAll("iframe");
  } catch {
    return;
  }
  const win = ksGlobal.window ?? globalThis;
  for (const iframeElement of iframeElements as any) {
    if (!iframeElement) continue;
    if ((iframeElement as any).__ks_iframeContentWindow) continue;
    let src = "";
    try {
      src = String(iframeElement.getAttribute?.("src") ?? "");
    } catch {}
    let resolvedUrl = "about:blank";
    if (src && src !== "about:blank") {
      try {
        resolvedUrl = parseUrlForNode(iframeElement, src, state.pageUrl || undefined).toString();
      } catch {
        resolvedUrl = "about:blank";
      }
    }
    installPlaceholderContentDocument(iframeElement, resolvedUrl, win, DOMParserConstructor);
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

function handleDynamicIframeInsert(iframeEl: any) {
  if (!iframeEl) return;
  if (iframeEl.__ks_iframeContentWindow) {
    handleIframeSrcChange(iframeEl);
    return;
  }
  const win = ksGlobal.window ?? globalThis;
  const DOMParserConstructor = ksGlobal.DOMParser;
  if (!DOMParserConstructor) return;
  const srcdoc = readSrcdoc(iframeEl);
  let src = "";
  try {
    src = String(iframeEl.getAttribute?.("src") ?? "");
  } catch {}
  let resolvedUrl = "about:blank";
  if (srcdoc !== null) {
    resolvedUrl = SRCDOC_URL;
  } else if (src && src !== "about:blank") {
    try {
      resolvedUrl = parseUrlForNode(iframeEl, src, state.pageUrl || undefined).toString();
    } catch {
      resolvedUrl = "about:blank";
    }
  }
  installPlaceholderContentDocument(
    iframeEl,
    resolvedUrl,
    win,
    DOMParserConstructor,
    "about:blank",
  );

  const frameId = mintDynamicFrameId();
  (iframeEl as any).__ks_iframeFrameId = frameId;
  const ownerBackendNodeId = (iframeEl as any)._id ?? -1;
  sendUpstreamEvent({
    event: "kitesurf.frameAttached",
    params: {
      frameId,
      ownerBackendNodeId,
      url: resolvedUrl,
    },
  });

  if (srcdoc !== null) {
    queueSrcdocLoad(iframeEl, srcdoc, win, DOMParserConstructor);
    return;
  }
  if (isAboutBlankUrl(resolvedUrl) || !src) {
    emitFrameLifecycle(frameId, "about:blank");
    fireIframeLoad(iframeEl);
    return;
  }
  let pageOrigin = "";
  try {
    pageOrigin = new URL(state.pageUrl).origin;
  } catch {}
  let frameOrigin = "";
  try {
    frameOrigin = new URL(resolvedUrl).origin;
  } catch {}
  if (pageOrigin && frameOrigin && pageOrigin !== frameOrigin) {
    Promise.resolve().then(() => {
      const contentWindow =
        iframeEl.__ks_iframeContentWindow ?? __makeCrossOriginContentWindow(iframeEl, resolvedUrl);
      try {
        contentWindow.document = null;
      } catch {}
      setIframeFacadeLocation(contentWindow, iframeEl, resolvedUrl);
      iframeEl.__ks_iframeContentDocument = null;
      iframeEl.__ks_iframeContentWindow = contentWindow;
      emitFrameLifecycle(frameId, resolvedUrl);
      fireIframeLoad(iframeEl);
    });
    return;
  }
  loadDynamicIframe(iframeEl, resolvedUrl, win, DOMParserConstructor);
}

function handleIframeSrcChange(iframeEl: any, urlOverride?: string, post?: IframePost) {
  if (!iframeEl) return;
  if (!iframeEl.__ks_iframeContentWindow) return;
  pendingDocumentLoads.delete(iframeEl);
  const win = ksGlobal.window ?? globalThis;
  const DOMParserConstructor = ksGlobal.DOMParser;
  if (!DOMParserConstructor) return;
  const isLocationNavigation = typeof urlOverride === "string" && urlOverride.length > 0;
  const srcdoc = isLocationNavigation ? null : readSrcdoc(iframeEl);
  if (srcdoc !== null) {
    queueSrcdocLoad(iframeEl, srcdoc, win, DOMParserConstructor);
    return;
  }
  let src = "";
  let resolvedUrl = "about:blank";
  if (typeof urlOverride === "string" && urlOverride.length > 0) {
    src = urlOverride;
    resolvedUrl = urlOverride;
  } else {
    try {
      src = String(iframeEl.getAttribute?.("src") ?? "");
    } catch {}
    if (src && src !== "about:blank") {
      try {
        resolvedUrl = parseUrlForNode(iframeEl, src, state.pageUrl || undefined).toString();
      } catch {
        resolvedUrl = "about:blank";
      }
    }
  }
  const frameId = (iframeEl as any).__ks_iframeFrameId;
  let pageOrigin = "";
  try {
    pageOrigin = new URL(state.pageUrl).origin;
  } catch {}
  let frameOrigin = "";
  try {
    frameOrigin = new URL(resolvedUrl).origin;
  } catch {}
  const isCrossOriginNav =
    !!(pageOrigin && frameOrigin && pageOrigin !== frameOrigin) &&
    !isAboutBlankUrl(resolvedUrl) &&
    !!src;
  if (isCrossOriginNav) {
    const contentWindow =
      iframeEl.__ks_iframeContentWindow ?? __makeCrossOriginContentWindow(iframeEl, resolvedUrl);
    try {
      contentWindow.document = null;
    } catch {}
    setIframeFacadeLocation(contentWindow, iframeEl, resolvedUrl);
    iframeEl.__ks_iframeContentDocument = null;
    iframeEl.__ks_iframeContentWindow = contentWindow;
    Promise.resolve().then(() => {
      emitFrameLifecycle(frameId, resolvedUrl);
      fireIframeLoad(iframeEl);
    });
    return;
  }
  if (isAboutBlankUrl(resolvedUrl) || !src) {
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
    return;
  }
  loadDynamicIframe(iframeEl, resolvedUrl, win, DOMParserConstructor, undefined, post);
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
  let contentDoc: any = null;
  const documentUrl = docUrl ?? url;
  try {
    const parser = new DOMParserConstructor();
    // No doctype: an about:blank document is in quirks mode.
    contentDoc = parser.parseFromString("<html><head></head><body></body></html>", "text/html");
    if (contentDoc) (contentDoc as any)._mutable = true;
    setFrameReferrer(contentDoc, referrer ?? state.pageUrl);
    if (contentDoc && documentUrl) {
      try {
        Object.defineProperty(contentDoc, "_baseUrl", {
          value: documentUrl,
          configurable: true,
          writable: true,
        });
      } catch {}
    }
  } catch {}
  const contentWindow: any = {
    document: contentDoc,
    parent: win,
    top: win,
    frames: [],
    name: (() => {
      try {
        return String(iframeEl.getAttribute?.("name") ?? "");
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
  setIframeFacadeLocation(contentWindow, iframeEl, url);
  contentWindow.self = contentWindow;
  contentWindow.window = contentWindow;
  contentWindow.frameElement = iframeEl;
  __decorateContentWindow(contentWindow);
  __wireContentWindowPostMessage(contentWindow, iframeEl);
  if (contentDoc) {
    try {
      Object.defineProperty(contentDoc, "defaultView", {
        value: contentWindow,
        configurable: true,
      });
    } catch {}
  }
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

async function loadDynamicIframe(
  iframeEl: any,
  url: string,
  win: any,
  DOMParserConstructor: any,
  srcdoc?: string,
  post?: IframePost,
) {
  let html = "";
  let characterSet = "UTF-8";
  let decodedResponse = false;
  let finalUrl = url;
  let contentType: string | null = null;
  try {
    let bytes: Uint8Array | null = null;
    if (srcdoc !== undefined) {
      html = srcdoc;
      decodedResponse = true;
      contentType = "text/html";
    } else {
      const blob = state.blobUrls.get(url);
      if (blob) {
        contentType = blob.type || null;
        bytes = new Uint8Array(await blob.arrayBuffer());
      } else {
        const response = await fetchDynamicIframeDocument(url, post);
        finalUrl = response && response.url ? response.url : url;
        contentType = responseHeaderGet(response, "content-type");
        if (response && response.ok && response.status !== 204 && response.status !== 205) {
          bytes = new Uint8Array(await response.arrayBuffer());
        } else if (response && !response.ok) {
          warnDynamicIframeStatus(response, url);
        }
      }
    }
    if (bytes !== null) {
      const decoded = decodeHtmlBytes(bytes, contentType ?? "");
      html = decoded.html;
      characterSet = ks_encoding_name(decoded.charset) ?? "UTF-8";
      decodedResponse = true;
    }
  } catch (err) {
    try {
      console.warn(
        "[kitesurf-iframe] dynamic iframe fetch failed for " + url + ":",
        err instanceof Error ? err.message : String(err),
      );
    } catch {}
  }
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  let newDoc: Record<string, unknown> | null = null;
  if (decodedResponse) {
    try {
      const parser = new DOMParserConstructor();
      const parserMime = pickDomParserMime(contentType);
      const parsedDocument: unknown = parser.parseFromString(html, parserMime);
      if (isObjectRecord(parsedDocument)) {
        parsedDocument._mutable = true;
        parsedDocument._characterSet = characterSet;
        newDoc = parsedDocument;
      }
    } catch (err) {
      try {
        console.warn(
          "[kitesurf-iframe] dynamic iframe parse failed for " + url + ":",
          err instanceof Error ? err.message : String(err),
        );
      } catch {}
    }
  }
  if (newDoc) {
    try {
      Object.defineProperty(newDoc, "_baseUrl", {
        value:
          srcdoc !== undefined ? state.document?.baseURI || state.pageUrl || finalUrl : finalUrl,
        configurable: true,
        writable: true,
      });
    } catch {}
    setFrameReferrer(newDoc, frameNavigationReferrer(finalUrl));
    const existingWin = iframeEl.__ks_iframeContentWindow;
    if (existingWin) {
      existingWin.document = newDoc;
      setIframeFacadeLocation(existingWin, iframeEl, finalUrl);
      try {
        Object.defineProperty(newDoc, "defaultView", {
          value: existingWin,
          configurable: true,
        });
      } catch {}
    }
    iframeEl.__ks_iframeContentDocument = newDoc;
  } else {
    const placeholderDoc: unknown = iframeEl.__ks_iframeContentDocument;
    if (isObjectRecord(placeholderDoc)) {
      try {
        if (!Reflect.set(placeholderDoc, "_characterSet", characterSet, placeholderDoc)) {
          throw new TypeError("Failed to set iframe placeholder character set");
        }
      } catch (error) {
        console.warn("[kitesurf-iframe] failed to set placeholder character set", {
          frameId: iframeEl.__ks_iframeFrameId,
          error,
        });
      }
      try {
        Object.defineProperty(placeholderDoc, "_baseUrl", {
          value: finalUrl,
          configurable: true,
          writable: true,
        });
      } catch {}
      setFrameReferrer(placeholderDoc, frameNavigationReferrer(finalUrl));
      const parserMime = pickDomParserMime(contentType);
      if (parserMime !== "text/html") {
        try {
          Reflect.set(placeholderDoc, "_contentType", parserMime, placeholderDoc);
        } catch {}
        try {
          Reflect.set(placeholderDoc, "_isXml", true, placeholderDoc);
        } catch {}
      }
    }
    const existingWin = iframeEl.__ks_iframeContentWindow;
    if (existingWin) {
      setIframeFacadeLocation(existingWin, iframeEl, finalUrl);
    }
  }
  const frameId = (iframeEl as any).__ks_iframeFrameId;
  emitFrameLifecycle(frameId, finalUrl);
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
    if (typeof element?.[handlerName] === "function") return;
    const handlerSource = element?.getAttribute?.(handlerName);
    if (typeof handlerSource !== "string" || handlerSource.length === 0) return;
    let eventHandler: Function;
    try {
      eventHandler = new Function("event", handlerSource);
    } catch {
      return;
    }
    try {
      element[handlerName] = eventHandler;
    } catch {}
  } catch {}
}

function pickDomParserMime(contentType: string | null | undefined): string {
  if (typeof contentType !== "string" || contentType.length === 0) {
    return "text/html";
  }
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  if (mediaType === "text/html") return "text/html";
  if (mediaType === "application/xhtml+xml") return "application/xhtml+xml";
  if (mediaType === "image/svg+xml") return "image/svg+xml";
  if (mediaType === "application/xml" || mediaType === "text/xml") return "application/xml";
  return "text/html";
}

// Transform-only (ink) damage clips each node's ink rect at the last record and now, so the old
// position is cleared. A node with no recorded rect forces one full frame.
const inkRects = new Map<number, number[]>();
const MAX_TRACKED_INK_RECTS = 64;
const MAX_PARTIAL_DAMAGE_CANDIDATES = 256;
const MAX_PARTIAL_DAMAGE_COVERAGE = 0.6;
const MAX_SCENE_CLIP_DIMENSION_PX = 2_560;

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
  if (Math.abs(scrollDeltaX) >= viewportWidth || Math.abs(scrollDeltaY) >= viewportHeight)
    return "scrollFar";
  if (!pinnedRects || !pinnedAtRecord || pinnedRects.size !== pinnedAtRecord.size) {
    return "scrollPinned";
  }
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
  if (scrollDeltaY !== 0) {
    addRect(
      0,
      scrollDeltaY > 0 ? viewportHeight - scrollDeltaY : 0,
      viewportWidth,
      Math.abs(scrollDeltaY),
      0,
    );
  }
  if (scrollDeltaX !== 0) {
    addRect(
      scrollDeltaX > 0 ? viewportWidth - scrollDeltaX : 0,
      0,
      Math.abs(scrollDeltaX),
      viewportHeight,
      0,
    );
  }
  for (const [id, [x, y, width, height]] of pinnedRects) {
    const previousRect = pinnedAtRecord.get(id);
    if (!previousRect) return "scrollPinned";
    addRect(x, y, width, height, DAMAGE_INK_PADDING_PX);
    addRect(
      previousRect[0] - scrollDeltaX,
      previousRect[1] - scrollDeltaY,
      previousRect[2],
      previousRect[3],
      DAMAGE_INK_PADDING_PX,
    );
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

function readSceneClip(value: unknown): SceneClipInput | null {
  if (!isObjectRecord(value)) return null;
  const { x, y, width, height } = value;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    !(width > 0) ||
    !(height > 0)
  ) {
    return null;
  }
  return { x, y, width, height };
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

function readPartialDamageSummary(paint: DomHandle, epochDamage: Set<number>): PartialDamageRead {
  try {
    if (typeof paint.takeDamageSummary !== "function") return partialDamageFailure("noWasmEntry");
    try {
      if (typeof paint.resolveLayout === "function") paint.resolveLayout();
    } catch {}
    const raw = paint.takeDamageSummary() || "";
    const summaryValue: unknown = raw ? JSON.parse(raw) : null;
    if (!summaryValue) return partialDamageFailure("noSummary");
    if (!isObjectRecord(summaryValue)) return partialDamageFailure("layoutDamage:");
    if (summaryValue.layoutOverflow || summaryValue.paintOverflow) {
      return partialDamageFailure("overflow");
    }
    const layout = summaryValue.layout;
    if (!isUnknownArray(layout) || layout.length > 0) {
      const names: unknown = layout || [];
      if (!isUnknownArray(names)) return partialDamageFailure("summaryThrew");
      const MAX_LAYOUT_DAMAGE_NAMES_LOGGED = 6;
      return partialDamageFailure(
        "layoutDamage:" + names.slice(0, MAX_LAYOUT_DAMAGE_NAMES_LOGGED).join(","),
      );
    }
    const paintNodes = summaryValue.paint;
    if (!isUnknownArray(paintNodes)) {
      return { skipReason: "", candidates: null, inkIds: [] };
    }
    const candidates = new Set<number>();
    for (const id of paintNodes) candidates.add(Number(id) | 0);
    for (const id of epochDamage) candidates.add(id | 0);
    const inkIds: number[] = [];
    if (isUnknownArray(summaryValue.ink)) {
      for (const id of summaryValue.ink) inkIds.push(Number(id) | 0);
    }
    return { skipReason: "", candidates, inkIds };
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
  if (!value || !isObjectRecord(value)) return null;
  const width = Number(value.width);
  const height = Number(value.height);
  if (!(width > 0) || !(height > 0)) return null;
  return { x: Number(value.x) || 0, y: Number(value.y) || 0, width, height };
}

function partialDamageClip(options: PartialDamageRectOptions): PartialDamageRectResult {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let ok = true;
  const addRect = (x: number, y: number, width: number, height: number): void => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + width > maxX) maxX = x + width;
    if (y + height > maxY) maxY = y + height;
  };
  for (const id of options.candidates) {
    let rawRect: unknown;
    try {
      rawRect = options.paint.getBoundingClientRect(id);
    } catch {
      ok = false;
      break;
    }
    const rect = readPartialDamageRect(rawRect);
    if (!rect) {
      ok = false;
      break;
    }
    addRect(rect.x, rect.y, rect.width, rect.height);
  }
  let skipReason = "";
  for (const id of ok ? options.inkIds : []) {
    const previousInkRect = inkRects.get(id);
    const currentInkRect = readInkRect(options.paint, id);
    if (currentInkRect) options.inkNow.set(id, currentInkRect);
    if (!previousInkRect) skipReason = "inkFirst";
    if (!previousInkRect || !currentInkRect) {
      ok = false;
      break;
    }
    addRect(previousInkRect[0], previousInkRect[1], previousInkRect[2], previousInkRect[3]);
    addRect(currentInkRect[0], currentInkRect[1], currentInkRect[2], currentInkRect[3]);
  }
  if (!ok || maxX <= minX || maxY <= minY) {
    return { clip: null, offscreen: false, skipReason: skipReason || "rectFail" };
  }
  const clipX = Math.max(0, Math.floor(minX - DAMAGE_INK_PADDING_PX));
  const clipY = Math.max(0, Math.floor(minY - DAMAGE_INK_PADDING_PX));
  const clipWidth = Math.ceil(maxX + DAMAGE_INK_PADDING_PX) - clipX;
  const clipHeight = Math.ceil(maxY + DAMAGE_INK_PADDING_PX) - clipY;
  if (
    options.sinceSeq !== null &&
    !options.hasClip &&
    options.viewportWidth > 0 &&
    options.viewportHeight > 0 &&
    (clipX >= state.scrollX + options.viewportWidth ||
      clipY >= state.scrollY + options.viewportHeight ||
      clipX + clipWidth <= state.scrollX ||
      clipY + clipHeight <= state.scrollY)
  ) {
    return { clip: null, offscreen: true, skipReason: "" };
  }
  const coverage =
    options.viewportWidth > 0 && options.viewportHeight > 0
      ? (clipWidth * clipHeight) / (options.viewportWidth * options.viewportHeight)
      : 1;
  if (clipWidth > 0 && clipHeight > 0 && coverage <= MAX_PARTIAL_DAMAGE_COVERAGE) {
    return {
      clip: { x: clipX, y: clipY, w: clipWidth, h: clipHeight },
      offscreen: false,
      skipReason: "",
    };
  }
  return { clip: null, offscreen: false, skipReason: "cutoff" };
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

// A partial composites onto the client's retained frame, so it needs the client's painted base to
// be this epoch's base, with no unshiftable scroll or resize since. The client checks the base too.
function planPartialScene(options: PartialSceneOptions): PartialScenePlan {
  let skipReason = "";
  if (!options.allowPartial) skipReason = "off";
  else if (options.clientWire) skipReason = "clientWire";
  else if (options.epochLayoutDirty) skipReason = "opaquePaint";
  else if (options.baseSeq < 0 || options.baseSeq !== options.epochBase) skipReason = "base";
  else if (options.scrolled && !options.allowScrollShift) skipReason = "scroll";
  else if (
    state.paintViewportW !== state.lastRecordViewportW ||
    state.paintViewportH !== state.lastRecordViewportH
  ) {
    skipReason = "resize";
  }
  let scrollClips: number[][] = [];
  let pinnedNow: Map<number, number[]> | undefined;
  let inkIds: number[] = [];
  const inkNow = new Map<number, number[]>();
  let partialClip: SceneClip | null = null;
  let unchangedReason: PartialScenePlan["unchangedReason"] = null;
  const plan = (): PartialScenePlan => ({
    skipReason,
    scrollClips,
    pinnedNow,
    inkIds,
    inkNow,
    partialClip,
    unchangedReason,
  });
  if (skipReason !== "") return plan();

  const damage = readPartialDamageSummary(options.paint, options.epochDamage);
  skipReason = damage.skipReason;
  inkIds = damage.inkIds;
  if (skipReason !== "") return plan();
  let candidates = damage.candidates;
  if (options.scrolled && candidates) {
    if (candidates.size > 0 || inkIds.length > 0) {
      skipReason = "scrollDamage";
    } else {
      pinnedNow = readPinnedRects(options.paint);
      const patchResult = scrollPatches(
        options.scrollDeltaX,
        options.scrollDeltaY,
        options.viewportWidth,
        options.viewportHeight,
        pinnedNow,
      );
      if (typeof patchResult === "string") skipReason = patchResult;
      else scrollClips = patchResult;
    }
    candidates = null;
  }
  if (
    options.sinceSeq !== null &&
    candidates &&
    candidates.size === 0 &&
    inkIds.length === 0 &&
    !isAnimating()
  ) {
    unchangedReason = "noDamage";
    return plan();
  }
  const damageCount = candidates ? candidates.size + inkIds.length : 0;
  if (candidates && damageCount === 0) skipReason = "noCandidates";
  if (damageCount > MAX_PARTIAL_DAMAGE_CANDIDATES) skipReason = "tooMany";
  if (candidates && damageCount > 0 && damageCount <= MAX_PARTIAL_DAMAGE_CANDIDATES) {
    const rectPlan = partialDamageClip({
      paint: options.paint,
      candidates,
      inkIds,
      inkNow,
      viewportWidth: options.viewportWidth,
      viewportHeight: options.viewportHeight,
      sinceSeq: options.sinceSeq,
      hasClip: options.hasClip,
    });
    if (rectPlan.offscreen) unchangedReason = "offscreen";
    else if (rectPlan.clip) partialClip = rectPlan.clip;
    else if (skipReason === "") skipReason = rectPlan.skipReason;
  }
  return plan();
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

function fireIframeLoad(iframeElement: any) {
  try {
    const EventConstructor = ksEventCtors.Event || ksGlobal.CsEvent;
    if (!EventConstructor) return;
    compileEventAttribute(iframeElement, "onload");
    const event = new EventConstructor("load", { bubbles: false, cancelable: false });

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

function armSpanSink(self: any, traced: boolean): void {
  const sink = self?.env?.KS_SPAN_SINK;
  if (!traced || !sink) {
    if (__ksSpanHookArmed) {
      try {
        ks_set_emit_hook(null);
      } catch {}
      __ksSpanHookArmed = false;
    }
    return;
  }
  __ksSpanTotal = 0;
  __ksSpanCapped = false;
  if (__ksSpanHookArmed) return;
  __ksSpanHookArmed = true;
  const flush = () => {
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
  };
  const schedule = () => {
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
  };
  try {
    ks_set_emit_hook((rec: string) => {
      if (__ksSpanTotal >= __KS_SPAN_BUDGET) {
        if (!__ksSpanCapped) {
          __ksSpanCapped = true;
          __ksSpanBuf.push(
            `{"name":"child.spans.capped","attributes":[{"key":"budget","value":{"intValue":"${__KS_SPAN_BUDGET}"}}]}`,
          );
          schedule();
        }
        return;
      }
      __ksSpanTotal++;
      __ksSpanBuf.push(rec);
      schedule();
    });
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
    try {
      if (typeof paint.resolveLayout === "function") paint.resolveLayout();
    } catch {}
    if (seqNow > state.lastForceRestyleSeq) {
      try {
        if (typeof paint.forceFullRestyle === "function") paint.forceFullRestyle();
      } catch {}
      state.lastForceRestyleSeq = seqNow;
    }
    let paintHitId: unknown;
    try {
      paintHitId = paint.elementFromPoint(clientX + state.scrollX, clientY + state.scrollY);
    } catch {
      invalidatePaintDom();
      paintHitId = -1;
    }
    if (typeof paintHitId === "number" && paintHitId >= 0) {
      targetEl = state.resolveNodeId(paintHitId);
    }
    if (
      targetEl &&
      eventType !== "mousemove" &&
      eventType !== "wheel" &&
      typeof paint.pseudoKindAtPoint === "function" &&
      typeof targetEl.pseudo === "function"
    ) {
      try {
        const kind = paint.pseudoKindAtPoint(clientX + state.scrollX, clientY + state.scrollY);
        if (kind === 1 || kind === 2) {
          event.pseudoTarget = targetEl.pseudo(kind === 1 ? "::before" : "::after");
        }
      } catch {}
    }
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
    const valueLength = String(caretNode.value || "").length;
    const safeOffset = Math.max(0, Math.min(Number(offset) || 0, valueLength));
    const start =
      typeof caretNode.selectionStart === "number" ? caretNode.selectionStart : safeOffset;
    const end = typeof caretNode.selectionEnd === "number" ? caretNode.selectionEnd : start;
    if (eventType === "mousemove") {
      const anchor = __ksControlCaretAnchor;
      if (anchor?.el === caretNode) {
        const direction = safeOffset < anchor.offset ? "backward" : "forward";
        caretNode.setSelectionRange(
          Math.min(anchor.offset, safeOffset),
          Math.max(anchor.offset, safeOffset),
          direction,
        );
      }
      return;
    }
    if (event.shiftKey) {
      const anchor = caretNode.selectionDirection === "backward" ? end : start;
      caretNode.setSelectionRange(
        Math.min(anchor, safeOffset),
        Math.max(anchor, safeOffset),
        safeOffset < anchor ? "backward" : "forward",
      );
      __ksControlCaretAnchor = { el: caretNode, offset: anchor };
    } else if (typeof caretNode.__ksCollapseSelectionTo === "function") {
      caretNode.__ksCollapseSelectionTo(safeOffset);
      __ksControlCaretAnchor = { el: caretNode, offset: safeOffset };
    } else {
      caretNode.setSelectionRange(safeOffset, safeOffset);
      __ksControlCaretAnchor = { el: caretNode, offset: safeOffset };
    }
    if (event.button === 0) {
      __ksCaretDragActive = true;
      __ksCaretDragOrigin = { x: clientX, y: clientY };
    }
    return;
  }

  const documentNode = state.document;
  const selection =
    documentNode && typeof documentNode.getSelection === "function"
      ? documentNode.getSelection()
      : null;
  if (!caretNode || !selection) return;
  if (eventType === "mousemove") {
    if (selection.rangeCount > 0) selection.extend(caretNode, offset);
    return;
  }
  if (event.shiftKey && !findAnchorAncestor(targetEl)) {
    if (selection.rangeCount > 0) selection.extend(caretNode, offset);
    else selection.collapse(caretNode, offset);
    return;
  }
  selection.collapse(caretNode, offset);
  if (event.button === 0 && !event.shiftKey) {
    __ksCaretDragActive = true;
    __ksCaretDragOrigin = { x: clientX, y: clientY };
  }
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

function isButtonActivationAncestor(element: MouseTarget): boolean {
  const tagName = (element.tagName || "").toUpperCase();
  return (
    tagName === "BUTTON" ||
    tagName === "INPUT" ||
    tagName === "A" ||
    tagName === "SUMMARY" ||
    tagName === "LABEL"
  );
}

function buttonActivationNavigation(targetEl: MouseTarget): string | null {
  let activator: MouseTarget | null | undefined = targetEl;
  while (activator && activator !== state.document && !isButtonActivationAncestor(activator)) {
    activator = activator.parentNode;
  }
  if (!activator || activator === state.document) activator = targetEl;
  const tagName = (activator.tagName || "").toUpperCase();
  const typeAttr = ((activator.getAttribute && activator.getAttribute("type")) || "").toLowerCase();
  const isSubmit =
    (tagName === "BUTTON" && (typeAttr === "" || typeAttr === "submit")) ||
    (tagName === "INPUT" && (typeAttr === "submit" || typeAttr === "image"));
  const isReset = (tagName === "BUTTON" || tagName === "INPUT") && typeAttr === "reset";
  if (!(isSubmit || isReset) || activator.disabled) return null;
  const form = activator.form;
  if (!form) return null;
  if (isSubmit && typeof form.__ksRequestSubmit === "function") {
    const navUrl = form.__ksRequestSubmit(activator);
    return typeof navUrl === "string" && navUrl.length > 0 ? navUrl : null;
  }
  if (isReset && typeof form.reset === "function") form.reset();
  return null;
}

function toggleDetailsFromSummary(targetEl: MouseTarget): void {
  let summary: MouseTarget | null | undefined = targetEl;
  while (
    summary &&
    summary !== state.document &&
    (summary.tagName || "").toUpperCase() !== "SUMMARY"
  ) {
    summary = summary.parentNode;
  }
  if (!summary || (summary.tagName || "").toUpperCase() !== "SUMMARY") return;
  const details = summary.parentNode;
  if (
    !details ||
    (details.tagName || "").toUpperCase() !== "DETAILS" ||
    !hasAttributeMethods(details)
  ) {
    return;
  }
  let firstSummary: MouseTarget | null = null;
  const kids = details.childNodes || [];
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i];
    if (child && (child.tagName || "").toUpperCase() === "SUMMARY") {
      firstSummary = child;
      break;
    }
  }
  if (firstSummary !== summary) return;
  if (details.hasAttribute("open")) details.removeAttribute("open");
  else details.setAttribute("open", "");
  try {
    __ks_dispatchTrusted(
      details,
      new ksEventCtors.Event("toggle", { bubbles: false, cancelable: false }),
    );
  } catch {}
}

type AnchorNavigation = { kind: "hash" | "navigate"; url: string };

function activateAnchorNavigation(
  targetEl: MouseTarget,
  clientX: number,
  clientY: number,
): AnchorNavigation | null {
  const anchor =
    findAnchorAncestor(targetEl) || findAnchorViaSingleChild(targetEl, clientX, clientY);
  if (!anchor) return null;
  const rawHref = anchorHrefAttribute(anchor);
  if (typeof rawHref !== "string" || rawHref.length === 0) return null;
  try {
    const resolved = parseUrlForNode(
      anchor,
      rawHref,
      state.pageUrl || "https://kitesurf.local/",
    ).toString();
    const isHashOnly =
      resolved.includes("#") && resolved.split("#")[0] === state.pageUrl.split("#")[0];
    if (!isHashOnly) return { kind: "navigate", url: resolved };
    const previous = state.pageUrl;
    state.pageUrl = resolved;
    const win = state.window;
    if (win) {
      const stateForPopstate = win.history?.state ?? null;
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
    scrollToFragment(resolved);
    return { kind: "hash", url: resolved };
  } catch {
    return null;
  }
}

function notifyControlValueMutation(
  control: ShimElement,
  cursor: number,
  keyboardEventConstructor: BuildDocumentResult["Event"] | BuildDocumentResult["KeyboardEvent"],
): void {
  try {
    if (typeof control.__ksMarkUserEdited === "function") control.__ksMarkUserEdited();
  } catch {}
  try {
    if (typeof control.__ksCollapseSelectionTo === "function") {
      control.__ksCollapseSelectionTo(cursor);
    } else if (typeof control.setSelectionRange === "function") {
      control.setSelectionRange(cursor, cursor);
    }
  } catch {}
  try {
    const inputEvent = new (ksEventCtors.Event || keyboardEventConstructor)("input", {
      bubbles: true,
      cancelable: false,
    });
    __ks_dispatchTrusted(control, inputEvent);
  } catch {}
}

function findDefaultSubmitButton(form: NonNullable<ShimElement["form"]>): ShimElement | null {
  let defaultButton: ShimElement | null = null;
  const elements = form.elements;
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    const type = ((element.getAttribute && element.getAttribute("type")) || "").toLowerCase();
    if (element.tagName === "BUTTON" && (type === "" || type === "submit")) {
      defaultButton = element;
      break;
    }
    if (element.tagName === "INPUT" && (type === "submit" || type === "image")) {
      defaultButton = element;
      break;
    }
  }
  return defaultButton;
}

function submitFormOnEnter(focused: ShimElement): string | null {
  try {
    const typeAttr = ((focused.getAttribute && focused.getAttribute("type")) || "").toLowerCase();
    const skipImplicit =
      typeAttr === "button" ||
      typeAttr === "submit" ||
      typeAttr === "reset" ||
      typeAttr === "checkbox" ||
      typeAttr === "radio" ||
      typeAttr === "file" ||
      typeAttr === "image";
    if (skipImplicit) return null;
    const form = focused.form;
    if (!form || typeof form.__ksRequestSubmit !== "function") return null;
    const navUrl = form.__ksRequestSubmit(findDefaultSubmitButton(form));
    return typeof navUrl === "string" && navUrl.length > 0 ? navUrl : null;
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

function collectFormControlState(
  id: number,
  values: Array<[number, string]>,
  checked: Array<[number, boolean]>,
  selected: Array<[number, boolean]>,
): boolean {
  let element: ShimElement | null = null;
  try {
    element = state.resolveNodeId ? state.resolveNodeId(id) : null;
  } catch {
    return false;
  }
  if (!element) return false;
  const tagName = String(Reflect.get(element, "localName") || "").toLowerCase();
  if (tagName === "input") {
    const inputType = String(readFormControlAttribute(element, "type") || "text").toLowerCase();
    if (inputType === "checkbox" || inputType === "radio") {
      try {
        checked.push([id, !!Reflect.get(element, "checked")]);
      } catch {
        return false;
      }
      return true;
    }
  }
  let complete = true;
  if (tagName === "select") {
    try {
      const options: unknown = Reflect.get(element, "options");
      if (!isObjectRecord(options)) throw new TypeError("Select options are unavailable");
      const length: unknown = Reflect.get(options, "length");
      for (let index = 0; index < Number(length); index++) {
        const option: unknown = Reflect.get(options, String(index));
        if (!isObjectRecord(option) || typeof option._id !== "number") continue;
        selected.push([option._id, !!option.selected]);
      }
    } catch {
      complete = false;
    }
  }
  try {
    values.push([id, String(Reflect.get(element, "value") ?? "")]);
  } catch {
    complete = false;
  }
  return complete;
}

function stylesheetHref(attributes: unknown[]): string | null {
  let rel = "";
  let href = "";
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    const name = String(attributes[index] ?? "").toLowerCase();
    const value = String(attributes[index + 1] ?? "");
    if (name === "rel") rel = value;
    else if (name === "href") href = value;
  }
  const tokens = rel.split(/\s+/).map((token) => token.toLowerCase());
  if (!tokens.includes("stylesheet") || tokens.includes("alternate") || !href) return null;
  return href;
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

function prepareCachedPaint(
  paint: DomHandle,
  fresh: boolean,
  sequence: PaintSequence,
  sequenceAfterRestyle: PaintSequence = sequence,
): void {
  if (fresh) return;
  try {
    if (typeof paint.resolveLayout === "function") paint.resolveLayout();
  } catch {}
  if (readPaintSequence(sequence) <= state.lastForceRestyleSeq) return;
  try {
    if (typeof paint.forceFullRestyle === "function") paint.forceFullRestyle();
  } catch {}
  state.lastForceRestyleSeq = readPaintSequence(sequenceAfterRestyle);
}

async function runClassicRegularBucket(
  bundleExec: string[],
  scriptStartedAt: number,
  nowMs: () => number,
) {
  try {
    const mod = await import("./__ks_user_classic_regular.js");
    bundleExec.push(
      "classic:imported(keys=" +
        JSON.stringify(Object.keys(mod || {})) +
        ",defaultKeys=" +
        JSON.stringify(Object.keys((mod && mod.default) || {})) +
        ")",
    );
    const run = (mod && mod.default && mod.default.run) || mod.run;
    if (typeof run !== "function") {
      bundleExec.push("classic:no-run-export");
      console.error("[kitesurf] classic regular bucket: no run() export", Object.keys(mod || {}));
      return;
    }
    if (startupCdpDebug) {
      const CLASSIC_RUN_SOURCE_PREVIEW_CHARS = 80;
      bundleExec.push(
        "classic:run-fn(toString=" +
          JSON.stringify(
            String(run).slice(0, CLASSIC_RUN_SOURCE_PREVIEW_CHARS).replace(/\n/g, "\\n"),
          ) +
          ")",
      );
    }
    bundleExec.push("classic:run-call");
    await run();
    if (!startupCdpDebug) {
      bundleExec.push("classic:run-ok(ms=" + Math.round(nowMs() - scriptStartedAt) + ")");
      return;
    }
    const diag: Partial<BundleDiag> = getInternalState().bundleDiag || {};
    const entered = !!diag.entered;
    const exited = !!diag.exited;
    const bodyChars = diag.bodyChars;
    bundleExec.push(
      "classic:run-ok(ms=" +
        Math.round(nowMs() - scriptStartedAt) +
        ",entered=" +
        entered +
        ",exited=" +
        exited +
        ",bodyChars=" +
        bodyChars +
        ")",
    );
    try {
      const entryDom = diag.entryDom;
      const exitDom = diag.exitDom;
      bundleExec.push("classic:entryDom(" + JSON.stringify(entryDom) + ")");
      bundleExec.push("classic:exitDom(" + JSON.stringify(exitDom) + ")");
    } catch (error) {
      bundleExec.push("classic:dom-snap-err(" + String(error) + ")");
    }
  } catch (error) {
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
    const safeUrl = typeof url === "string" ? url : "about:blank";
    const safeHtml =
      typeof html === "string" && html.length > 0
        ? html
        : "<html><head></head><body></body></html>";
    if (startupCdpDebug) {
      const NAVIGATE_HTML_PREVIEW_CHARS = 200;
      try {
        console.log(
          "[kitesurf-debug] PageScript.navigate() called",
          JSON.stringify({
            url: safeUrl,
            htmlLength: safeHtml.length,
            htmlPreview: safeHtml.slice(0, NAVIGATE_HTML_PREVIEW_CHARS),
            startupScriptCount: startupInputSnapshot?.scriptDescriptorCount,
            startupSample: startupInputSnapshot?.scriptDescriptorSample,
            startupHasClassicRegular: startupHasClassicRegular,
          }),
        );
      } catch {}
    }
    const initialCookies =
      navigateOptions && typeof navigateOptions.cookies === "string" ? navigateOptions.cookies : "";
    if (navigateOptions && typeof navigateOptions.connectionId === "string") {
      state.connectionId = navigateOptions.connectionId;
    }
    if (navigateOptions && typeof navigateOptions.mainFrameId === "string") {
      state.mainFrameId = navigateOptions.mainFrameId;
    }
    if (navigateOptions && typeof navigateOptions.cookieKey === "string") {
      state.cookieKey = navigateOptions.cookieKey;
    }

    if (navigateOptions && Array.isArray(navigateOptions.bindingNames)) {
      this.installBindings(navigateOptions.bindingNames);
    }

    const nowMs =
      typeof performance !== "undefined" && performance.now
        ? () => performance.now()
        : () => Date.now();
    const phases = {};

    const isTraced = !!(navigateOptions && navigateOptions.traced === true);
    awaitingIframeInstalls =
      (navigateOptions as { expectIframeInstalls?: boolean } | undefined)?.expectIframeInstalls ===
      true;
    try {
      set_ks_tracing(isTraced);
    } catch {}
    try {
      armKsOtel(isTraced);
    } catch {}
    try {
      armSpanSink(this, isTraced);
    } catch {}
    const emitNavigateDiagnostic = (event, operation, extra?) => {
      if (!isTraced) return;
      try {
        sendUpstreamEvent({
          event: "kitesurf.diag",
          params: {
            ev: event,
            op: operation,
            t: nowMs(),
            ...(extra || {}),
          },
        });
      } catch {}
    };

    const bundleExec: string[] = [];
    let phaseStartedAt = nowMs();
    const markPhase = (name) => {
      const phaseEndedAt = nowMs();
      phases[name] = +(phaseEndedAt - phaseStartedAt).toFixed(3);
      phaseStartedAt = phaseEndedAt;
    };

    emitNavigateDiagnostic("start", "teardown");

    dispatchWindowUnload();

    if (state.dom) {
      try {
        state.dom.free();
      } catch {}
    }
    state.pageUrl = safeUrl;
    state.lastForceRestyleSeq = -1;
    state.currentMediaType = "screen";

    emitNavigateDiagnostic("end", "teardown");
    markPhase("teardownMs");

    try {
      setDimsOnlyImages(true);
    } catch {}
    if (navigateOptions && typeof navigateOptions.darkColorScheme === "boolean") {
      try {
        setDarkColorScheme(navigateOptions.darkColorScheme);
      } catch {}
      ksGlobal.__ks_dark_scheme = navigateOptions.darkColorScheme;
    }
    if (
      navigateOptions &&
      typeof navigateOptions.ttyUaCss === "number" &&
      navigateOptions.ttyUaCss > 0
    ) {
      forceMonoFace();
    }
    if (startupPixelFree) {
      try {
        setPixelFreeSession(true);
      } catch {}
    }
    emitNavigateDiagnostic("start", "fonts");
    if (fontDeferActive()) {
      startFontPrefetch(safeHtml);
    } else {
      await ensureFontsRegistered(safeHtml);
    }
    emitNavigateDiagnostic("end", "fonts");
    markPhase("fontsMs");

    if (
      navigateOptions &&
      typeof navigateOptions.ttyUaCss === "number" &&
      navigateOptions.ttyUaCss > 0 &&
      typeof navigateOptions.ttyCss === "string" &&
      navigateOptions.ttyCss.length > 0
    ) {
      try {
        const DEFAULT_TTY_CELL_WIDTH_PX = 8;
        const DEFAULT_TTY_CELL_HEIGHT_PX = 17;
        const cellWidth =
          typeof navigateOptions.ttyCellW === "number" && navigateOptions.ttyCellW > 0
            ? navigateOptions.ttyCellW
            : DEFAULT_TTY_CELL_WIDTH_PX;
        const cellHeight =
          typeof navigateOptions.ttyCellH === "number" && navigateOptions.ttyCellH > 0
            ? navigateOptions.ttyCellH
            : DEFAULT_TTY_CELL_HEIGHT_PX;
        ksGlobal.__ks_tty_cell_w = cellWidth;
        ksGlobal.__ks_tty_cell_h = cellHeight;
        const ratio = monoAdvancePerEm();
        if (ratio > 0) {
          const fontPx = cellWidth / ratio;
          setTtyUaCss(navigateOptions.ttyCss.replace(/\{\{FONT_PX\}\}/g, String(fontPx)));
          setTtyCellGrid(cellWidth, cellHeight);
          console.log(
            `[kitesurf-tty] sheet installed: cell=${cellWidth}x${cellHeight} ` +
              `advance/em=${ratio.toFixed(4)} font-size=${fontPx.toFixed(3)}px`,
          );
        } else {
          setTtyCellGrid(0, 0);
          console.warn("[kitesurf-tty] no mono face registered; sheet NOT installed");
        }
      } catch (e) {
        console.warn("[kitesurf-tty] sheet install failed:", String(e));
      }
    } else if (
      navigateOptions &&
      typeof navigateOptions.ttyCss === "string" &&
      navigateOptions.ttyCss.length > 0
    ) {
      setTtyUaCss(navigateOptions.ttyCss);
    }
    emitNavigateDiagnostic("start", "parse");

    const sourceDoctype = sourceDoctypeOf(safeHtml);
    const marker = sourceDoctype
      ? `__kitesurf_doctype_${Math.random().toString(36).slice(2)}__`
      : null;
    const parsedHtml =
      sourceDoctype && marker
        ? safeHtml.slice(0, sourceDoctype.end) +
          `<!--${marker}-->` +
          safeHtml.slice(sourceDoctype.end)
        : safeHtml;
    const navigateDom = new DomHandle(parsedHtml, safeUrl);
    state.dom = navigateDom;
    noteNavigateText(navigateDom);
    state.sourceDoctype = sourceDoctype && marker ? { markup: sourceDoctype.markup, marker } : null;
    if (
      navigateOptions &&
      typeof navigateOptions.viewportWidth === "number" &&
      typeof navigateOptions.viewportHeight === "number"
    ) {
      const viewportWidth = Math.max(1, Math.floor(navigateOptions.viewportWidth));
      const viewportHeight = Math.max(1, Math.floor(navigateOptions.viewportHeight));
      state.paintViewportW = viewportWidth;
      state.paintViewportH = viewportHeight;
      try {
        const internalState = getInternalState();
        internalState.viewportW = viewportWidth;
        internalState.viewportH = viewportHeight;
      } catch {}
      try {
        state.dom.setViewport(viewportWidth, viewportHeight);
      } catch {}
    }
    try {
      ksGlobal.__ks_dom_debug = state.dom;
    } catch {}
    state.scrollX = 0;
    state.scrollY = 0;
    invalidatePaintDom();
    emitNavigateDiagnostic("end", "parse");
    markPhase("parseMs");
    emitNavigateDiagnostic("start", "shim");

    installNativeToString();
    const built = ksSpan("dom.build_document", null, () =>
      buildDocument(navigateDom, {
        pageUrl: safeUrl,
        initialCookieString: initialCookies,
        doctypeMarker: marker,
        userAgent: startupUserAgent,
        referrer: startupReferrer,
        canonicalizeInlineStyle: (css: string) => {
          try {
            return ks_parse_inline_style(css);
          } catch {
            return [];
          }
        },
        parseTypedStyleValue: (property: string, cssText: string) => {
          try {
            return ks_parse_typed_style_value(property, cssText);
          } catch {
            return null;
          }
        },
        parseTypedNumericValue: (cssText: string) => {
          try {
            return ks_parse_typed_numeric_value(cssText);
          } catch {
            return null;
          }
        },
        parseCounterStyleRule: (css: string, field: string, value: string) => {
          try {
            return ks_counter_style_rule(css, field, value);
          } catch {
            return null;
          }
        },
        serializeInlineStyle: (css: string) => {
          try {
            return ks_serialize_inline_style(css);
          } catch {
            return "";
          }
        },
        getInlinePropertyValue: (css: string, property: string) => {
          try {
            return ks_get_property_value(css, property);
          } catch {
            return "";
          }
        },
        createRuleStyleDeclaration: (context, css, baseUrl) =>
          new RuleStyleDeclarationStore(context, css, baseUrl),
        canonicalizePageSelectors: (prelude: string) => {
          try {
            return ks_canonicalize_page_selectors(prelude);
          } catch {
            return undefined;
          }
        },
        characterSet: documentCharacterSet(navigateOptions?.charset),
        encodingName: (label: string) => {
          try {
            return ks_encoding_name(label);
          } catch {
            return undefined;
          }
        },
        percentEncodeAfterEncoding: ks_percent_encode_after_encoding,
        encodeHtml: ks_encode_html,
        getCurrentUrl: () => state.pageUrl,
        setCurrentUrl: (newUrl, kind) => {
          if (typeof newUrl !== "string" || newUrl.length === 0) return;
          const previous = state.pageUrl;
          if (startupCdpDebug) {
            try {
              console.log(
                "[kitesurf-debug] setCurrentUrl",
                JSON.stringify({
                  kind,
                  previous,
                  newUrl,
                  same: previous === newUrl,
                }),
              );
            } catch {}
          }
          state.pageUrl = newUrl;
          if (kind === "hash" && previous !== newUrl && state.window) {
            const stateForPopstate = state.window.history?.state ?? null;
            queuePageTask(() => {
              try {
                const event: any = new ksEventCtors.HashChangeEvent("hashchange", {
                  bubbles: false,
                  cancelable: false,
                  oldURL: previous,
                  newURL: newUrl,
                });
                __ks_dispatchTrusted(state.window, event);
              } catch {}
            });
            queuePageTask(() => {
              try {
                const event: any = new ksEventCtors.PopStateEvent("popstate", {
                  bubbles: false,
                  cancelable: false,
                  state: stateForPopstate,
                });
                __ks_dispatchTrusted(state.window, event);
              } catch {}
            });
            scrollToFragment(newUrl);
          }
          if (previous !== newUrl || kind === "navigate") {
            try {
              const navigationType =
                kind === "hash"
                  ? "fragment"
                  : kind === "pushState" || kind === "replaceState"
                    ? "historyApi"
                    : "other";
              sendUpstreamEvent({
                event: "kitesurf.navigatedWithinDocument",
                params: {
                  url: newUrl,
                  navigationType,
                  kind,
                  previousUrl: previous,
                },
              });
            } catch {}
          }
        },
        getRectByAuthId: (authId: number) => {
          if (typeof authId !== "number" || authId <= 0) return null;
          const paint = ensurePaintDom();
          if (!paint) return null;
          try {
            return rectWithScrollOffset(paint.getBoundingClientRect(authId));
          } catch {
            invalidatePaintDom();
            return null;
          }
        },
        getScrollInfoByAuthId: (authId: number) => {
          if (typeof authId !== "number" || authId <= 0) return null;
          const paint = ensurePaintDom();
          if (!paint) return null;
          try {
            return paint.nodeScrollInfo(authId);
          } catch {
            invalidatePaintDom();
            return null;
          }
        },
        getOffsetMetricsByAuthId: (authId: number) => {
          if (typeof authId !== "number" || authId <= 0) return null;
          const paint = ensurePaintDom();
          if (!paint) return null;
          try {
            return paint.offsetMetrics(authId);
          } catch {
            invalidatePaintDom();
            return null;
          }
        },
        getStickyShiftByAuthId: (authId: number) => {
          if (typeof authId !== "number" || authId <= 0) return null;
          const paint = ensurePaintDom();
          if (!paint) return null;
          try {
            return paint.stickyShift(authId);
          } catch {
            invalidatePaintDom();
            return null;
          }
        },
        hitTestViaPaint: (x: number, y: number) => {
          const paint = ensurePaintDom();
          if (!paint) return -1;
          try {
            const id = paint.elementFromPoint(x + state.scrollX, y + state.scrollY);
            return typeof id === "number" && id >= 0 ? id : -1;
          } catch {
            invalidatePaintDom();
            return -1;
          }
        },
        getComputedStyleForAuthId: (authId: number, pseudo?: string) =>
          computedStyleForAuthId(authId, pseudo),
        getComputedStyleValueForAuthId: (authId: number, name: string) =>
          computedStyleValueForAuthId(authId, name),
        getExternalSheetRules: (nodeId: number) => externalSheetRulesForNode(nodeId),
        getScrollOffset: () => ({ x: state.scrollX, y: state.scrollY }),
        setScrollOffset: (x: number, y: number) => setScrollOffset(x, y),
        setWheelScrollOffset: (x: number, y: number) =>
          setScrollOffset(
            x,
            y,
            Number(navigateOptions?.ttyCellW) || 0,
            Number(navigateOptions?.ttyCellH) || 0,
          ),
        armTransitionDrain,
      }),
    );
    state.document = built.document;
    state.window = built.window;
    try {
      void resolveExternalSvgSprites();
    } catch {}
    state.getOpLog = built.getOpLog || (() => []);
    state.setReadyState = built.setReadyState || (() => {});
    state.drainCookieWrites = built.drainCookieWrites || (() => []);
    state.setCookieString = built.setCookieString || (() => {});
    state.resolveNodeId = built.nodeFor || (() => null);
    state.notifyImageResults = built.notifyImageResults || (() => {});
    state.notifyStylesheetResults = built.notifyStylesheetResults || (() => {});
    state.getActiveElement = built.getActiveElement || (() => null);
    state.drainCdpMutationsRaw = built.drainCdpMutations || (() => []);
    __ks_dispatchTrustedEvent = built.__ks_dispatchTrustedEvent || null;
    __ks_activateLabel = built.__ks_activateLabel;
    state.dispatchTrustedEvent = __ks_dispatchTrusted;
    ksGlobal.__ks_canonicalize_inline_style = (css: string) => {
      try {
        return ks_parse_inline_style(css);
      } catch {
        return [];
      }
    };
    installGlobals(state.document, state.window, built);
    preinstallStaticIframes();
    ksSpan("dom.mark_engine_functions", null, () =>
      markEngineFunctions([globalThis, state.window, state.document]),
    );
    getInternalState().afterIframeInsert = (iframeEl: unknown) => {
      try {
        handleDynamicIframeInsert(iframeEl);
      } catch (err) {
        try {
          console.warn(
            "[kitesurf-iframe] dynamic-insert handler failed:",
            err instanceof Error ? err.message : String(err),
          );
        } catch {}
      }
    };
    getInternalState().afterIframeRemove = (iframeEl: unknown) => {
      try {
        const frameId = (iframeEl as { __ks_iframeFrameId?: unknown } | null)?.__ks_iframeFrameId;
        if (typeof frameId !== "string" || frameId.length === 0) return;
        sendUpstreamEvent({ event: "kitesurf.frameDetached", params: { frameId } });
      } catch {}
    };
    getInternalState().afterIframeSrcChange = (iframeEl: unknown) => {
      try {
        handleIframeSrcChange(iframeEl);
      } catch (err) {
        try {
          console.warn(
            "[kitesurf-iframe] src-change handler failed:",
            err instanceof Error ? err.message : String(err),
          );
        } catch {}
      }
    };
    getInternalState().navigateIframe = (iframeEl: unknown, url: string, post?: IframePost) => {
      try {
        handleIframeSrcChange(iframeEl, url, post);
      } catch (err) {
        warnIframeFailure(err, { operation: "form target navigation", url });
      }
    };
    getInternalState().endClassicScript = async () => {
      try {
        await drainSettleMicrotasks();
      } catch {}
      try {
        getInternalState().setCurrentScript?.(null);
      } catch {}
    };
    getInternalState().afterScriptInsert = (info: unknown) => {
      const rec = (info && typeof info === "object" ? info : {}) as {
        id?: unknown;
        src?: unknown;
        source?: unknown;
        type?: unknown;
        integrity?: unknown;
        nonce?: unknown;
        crossOrigin?: unknown;
      };
      const src = typeof rec.src === "string" ? rec.src : "";
      const source = typeof rec.source === "string" ? rec.source : "";
      const integrity = typeof rec.integrity === "string" ? rec.integrity : "";
      const nonce = typeof rec.nonce === "string" ? rec.nonce : "";
      if (src) {
        runInsertedExternalScript({
          id: typeof rec.id === "number" ? rec.id : -1,
          src,
          type: typeof rec.type === "string" ? rec.type : "",
          integrity,
          nonce,
          crossOrigin: typeof rec.crossOrigin === "string" ? rec.crossOrigin : null,
        });
        return;
      }
      if (!source) return;
      const runInline = () => {
        try {
          evalInsertedOnBoa(source);
        } catch (err) {
          try {
            console.warn(
              "[kitesurf] inserted-script eval failed:",
              err instanceof Error ? err.message : String(err),
            );
          } catch {}
        }
      };
      const inlineMeta = { url: null, nonce, body: source };
      const sync = inlineInsertDecisionSync(inlineMeta);
      if (sync) {
        reportOnly(sync);
        if (sync.allowed) runInline();
        else reportBlocked(sync);
        return;
      }
      void (async () => {
        const verdict = await insertedScriptAllowed(inlineMeta);
        reportOnly(verdict);
        if (!verdict.allowed) {
          reportBlocked(verdict);
          return;
        }
        runInline();
      })();
    };
    if (typeof built.applyDeclarativeShadowRoots === "function") {
      try {
        built.applyDeclarativeShadowRoots();
      } catch {}
    }
    if (typeof built.stampInitialNamedGlobals === "function") {
      try {
        built.stampInitialNamedGlobals();
      } catch {}
    }
    emitNavigateDiagnostic("end", "shim");
    markPhase("shimMs");
    const hasScriptObservers = startupScriptDescriptors.length > 0 || /\son\w+\s*=/i.test(safeHtml);
    if (fontDeferActive() && hasScriptObservers) {
      await awaitDeferredFontBytes();
    }
    emitNavigateDiagnostic("start", "regular_scripts");

    resetConsoleBuffer();
    resetExceptionBuffer();

    const useBundle =
      startupHasClassicRegular || startupHasClassicAsync || startupModuleScriptCount > 0;

    if (startupHasClassicRegular || startupModuleScriptCount > 0) {
      const CSS_CRITICAL_RESOURCE_WAIT_BUDGET_MS = 5000;
      const CSS_CRITICAL_RESOURCE_POLL_INTERVAL_MS = 25;
      const cssStart = Date.now();
      const cssDeadline = cssStart + CSS_CRITICAL_RESOURCE_WAIT_BUDGET_MS;
      let cssWaits = 0;
      for (;;) {
        let pending = false;
        if (state.dom && typeof state.dom.hasPendingCriticalResources === "function") {
          try {
            pending = !!state.dom.hasPendingCriticalResources();
          } catch {}
        }
        if (!pending || Date.now() >= cssDeadline) break;
        cssWaits++;
        await NativePromise.race([
          nativeSleep(CSS_CRITICAL_RESOURCE_POLL_INTERVAL_MS),
          nextResourceSettle(),
        ]);
      }
      if (cssWaits > 0) {
        bundleExec.push(`css-block:${Date.now() - cssStart}ms`);
      }
    }
    let scriptCount = 0;
    let legacyPlan: ReturnType<typeof planScripts> | null = null;

    if (useBundle) {
      if (startupHasClassicRegular) {
        bundleExec.push("classic:start");
        const scriptStartedAt = nowMs();
        if (startupCdpDebug) {
          try {
            getInternalState().bundleDiag = null;
          } catch {}
        }
        await runClassicRegularBucket(bundleExec, scriptStartedAt, nowMs);
      } else {
        bundleExec.push("classic:skipped(no-bundle)");
      }
      emitNavigateDiagnostic("end", "regular_scripts");
      markPhase("regularScriptsMs");
      emitNavigateDiagnostic("start", "module_scripts");

      if (startupModuleScriptCount > 0) {
        installInitShims();
      }
      bundleExec.push("module:count=" + startupModuleScriptCount);
      const MAX_MODULE_ERRORS_LOGGED = 3;
      const MAX_MODULE_ERROR_MESSAGE_CHARS = 200;

      let moduleSuccessCount = 0;
      let moduleFailureCount = 0;
      try {
        const drainUpgrades = (globalThis as { __ks_drainCustomElementUpgrades?: () => void })
          .__ks_drainCustomElementUpgrades;
        const pendingImports: Array<Promise<void>> = [];
        const trackModuleImport = (
          moduleIndex: number,
          moduleUrl: string,
          modulePromise: Promise<unknown>,
        ): Promise<void> =>
          modulePromise.then(
            () => {
              moduleSuccessCount++;
            },
            (error) => {
              moduleFailureCount++;
              if (moduleFailureCount <= MAX_MODULE_ERRORS_LOGGED) {
                const errorMessage = errorMessageOrValue(error).slice(
                  0,
                  MAX_MODULE_ERROR_MESSAGE_CHARS,
                );
                bundleExec.push("module:err[" + moduleIndex + "]=" + errorMessage);
              }
              pushException(error, {
                scriptId: "bundle:module-" + moduleIndex,
                url: moduleUrl || "/__ks_user_module_" + moduleIndex + ".js",
                text: "Uncaught",
              });
              console.error(
                "[kitesurf] user module " + moduleIndex + " (" + moduleUrl + ") threw:",
                error,
              );
            },
          );
        for (let moduleIndex = 0; moduleIndex < startupModuleScriptCount; moduleIndex++) {
          const moduleUrl = startupModuleScriptUrls[moduleIndex] ?? "";
          const moduleImport = trackModuleImport(moduleIndex, moduleUrl, importModule(moduleUrl));
          const outcome = await NativePromise.race([
            moduleImport.then(() => "settled" as const),
            nativeSleep(0).then(() => "pending" as const),
          ]);
          if (outcome === "pending") {
            bundleExec.push("module:tla-parked[" + moduleIndex + "]");
            drainInitShims();
            drainDeferParked();
            installInitShims();
            pendingImports.push(moduleImport);
          }
          drainPageCustomElementUpgrades(drainUpgrades);
        }
        if (pendingImports.length > 0) {
          drainInitShims();
          await NativePromise.race([
            NativePromise.all(pendingImports),
            nativeSleep(TLA_SETTLE_BUDGET_MS),
          ]);
        }
      } finally {
        if (startupModuleScriptCount > 0) {
          drainInitShims();
        }
        drainDeferParked();
        bundleExec.push(
          "module:done(ok=" + moduleSuccessCount + ",err=" + moduleFailureCount + ")",
        );
      }
      emitNavigateDiagnostic("end", "module_scripts");
      markPhase("moduleScriptsMs");

      scriptCount = Array.isArray(startupScriptDescriptors) ? startupScriptDescriptors.length : 0;
    } else {
      const scripts = extractScripts();
      const plan = planScripts(scripts);
      legacyPlan = plan;

      await runRegularPhase(plan);
      emitNavigateDiagnostic("end", "regular_scripts");
      markPhase("regularScriptsMs");
      emitNavigateDiagnostic("start", "module_scripts");

      await runModulePhase(plan);
      emitNavigateDiagnostic("end", "module_scripts");
      markPhase("moduleScriptsMs");

      scriptCount = scripts.length;
    }
    state.setReadyState("interactive");
    dispatchLifecycle(state.document, "readystatechange", { bubbles: false });
    dispatchLifecycle(state.document, "DOMContentLoaded", {
      bubbles: true,
      cancelable: false,
    });

    const startedAsyncAndLoadAt = nowMs();
    state.loadCompletion = (async () => {
      const loadPhases: Record<string, number> = {};
      let loadPhaseStartedAt = startedAsyncAndLoadAt;
      const markLoadPhase = (name: string) => {
        const phaseEndedAt = nowMs();
        loadPhases[name] = +(phaseEndedAt - loadPhaseStartedAt).toFixed(3);
        loadPhaseStartedAt = phaseEndedAt;
      };

      emitNavigateDiagnostic("start", "async_scripts");
      if (useBundle) {
        if (startupHasClassicAsync) {
          try {
            const mod = (await importModule("./__ks_user_classic_async.js")) as {
              default?: { run?: () => unknown };
              run?: () => unknown;
            };
            const run = (mod && mod.default && mod.default.run) || mod.run;
            if (typeof run === "function") {
              await run();
            } else {
              console.error(
                "[kitesurf] classic async bucket: no run() export",
                Object.keys(mod || {}),
              );
            }
          } catch (err) {
            pushException(err, {
              scriptId: "bundle:classic-async",
              url: "/__ks_user_classic_async.js",
              text: "Uncaught",
            });
            console.error("[kitesurf] classic async bucket threw:", err);
          }
        }
      } else if (legacyPlan) {
        await runAsyncPhase(legacyPlan);
      }
      emitNavigateDiagnostic("end", "async_scripts");
      markLoadPhase("asyncScriptsMs");

      emitNavigateDiagnostic("start", "resource_drain");
      {
        const RESOURCE_WAIT_BUDGET_MS = 25_000;
        const POLL_INTERVAL_MS = 10;
        const SUBRESOURCE_INFLIGHT_WAIT_BACKSTOP_MS = 1_000;
        const QUIET_TURNS = Math.max(1, startupResourceDrainQuietTurns);
        const resourceDrainStartedAt = nowMs();
        const statsAtStart = snapshotFetchStats();
        let pollCount = 0;
        let activityWaveCount = 0;
        let quietTurns = 0;
        let iframeGateExpired = false;
        while (true) {
          if (sessionClosing) throw SESSION_CLOSED_ERROR;
          let hasCriticalResources = false;
          if (state.dom && typeof state.dom.hasPendingCriticalResources === "function") {
            try {
              hasCriticalResources = !!state.dom.hasPendingCriticalResources();
            } catch {
              hasCriticalResources = false;
            }
          }
          try {
            reevaluateDeferredUrls();
          } catch {}
          const hasBlockingSubresources = blockingInflightCount() > 0;
          const iframeGateHeld = awaitingIframeInstalls;
          const iframeInstallGatePending =
            iframeGateHeld && nowMs() - resourceDrainStartedAt < IFRAME_INSTALL_WAIT_MS;
          if (iframeGateHeld && !iframeInstallGatePending && !iframeGateExpired) {
            iframeGateExpired = true;
            console.warn(
              "[kitesurf-iframe] load gate expired after " +
                IFRAME_INSTALL_WAIT_MS +
                "ms without an iframeInstallsSettled; `load` was held " +
                "for the full backstop",
            );
          }
          if (!hasCriticalResources && !hasBlockingSubresources && !iframeInstallGatePending) {
            if (quietTurns >= QUIET_TURNS) break;
            quietTurns++;
            pollCount++;
            await drainSettleMicrotasks();
            try {
              pumpPageTask();
            } catch (e) {
              reportEngineError("runtime", e, "pumpPageTask threw during load settle");
            }
            try {
              (state.dom as { pumpResourceMessages?: () => void } | null)?.pumpResourceMessages?.();
            } catch {}
            if (pageTimerDueWithin(POLL_INTERVAL_MS)) {
              await NativePromise.race([
                nativeSleep(POLL_INTERVAL_MS),
                nextTimerTask(),
                sessionClosingSignal,
              ]);
            }
          } else {
            if (quietTurns > 0) activityWaveCount++;
            quietTurns = 0;
            pollCount++;
            if (hasBlockingSubresources) {
              await NativePromise.race([
                waitForInflightZero(),
                nativeSleep(SUBRESOURCE_INFLIGHT_WAIT_BACKSTOP_MS),
                sessionClosingSignal,
              ]);
            } else {
              await NativePromise.race([nativeSleep(POLL_INTERVAL_MS), sessionClosingSignal]);
            }
          }
          if (nowMs() - resourceDrainStartedAt > RESOURCE_WAIT_BUDGET_MS) break;
        }
        const statsAtEnd = snapshotFetchStats();
        emitNavigateDiagnostic("end", "resource_drain", {
          polls: pollCount,
          waves: activityWaveCount,
          ...(iframeGateExpired ? { iframe_gate_expired: true } : {}),
          d_count: statsAtEnd.count - statsAtStart.count,
          d_slot_ms: Math.round(statsAtEnd.slotMs - statsAtStart.slotMs),
          d_fetch_ms: Math.round(statsAtEnd.fetchMs - statsAtStart.fetchMs),
          d_deliver_ms: Math.round(statsAtEnd.deliverMs - statsAtStart.deliverMs),
          max_deliver_ms: Math.round(statsAtEnd.maxDeliverMs),
        });
      }
      markLoadPhase("resourceDrainMs");

      try {
        const bodyEl = (state.document as any)?.body;
        const attrs = bodyEl?.attributes;
        if (attrs) {
          for (const attribute of Array.from(attrs as ArrayLike<any>)) {
            const attributeName = String((attribute as any)?.name || "");
            if (attributeName.startsWith("on")) {
              compileEventAttribute(bodyEl, attributeName);
            }
          }
        }
      } catch {}

      const getSettleState = (): [number, number, number] => [
        cascadeSeq() | 0,
        timersScheduledCount(),
        blockingInflightCount(),
      ];
      const settleBaseline = getSettleState();

      state.setReadyState("complete");
      dispatchLifecycle(state.document, "readystatechange", { bubbles: false });
      dispatchLifecycle(state.window, "load", { bubbles: false });
      dispatchLifecycle(state.window, "pageshow", { bubbles: false });

      let postLoadPassCount = 0;
      let previousSettleState = settleBaseline;
      const settleStartedAt = nowMs();
      const SETTLE_BUDGET_MS = 250;
      const MAX_POST_LOAD_SETTLE_PASSES = 3;
      for (let pass = 0; pass < MAX_POST_LOAD_SETTLE_PASSES; pass++) {
        await drainSettleMicrotasks();
        const currentSettleState = getSettleState();
        const outputMoved =
          currentSettleState[0] !== previousSettleState[0] ||
          currentSettleState[2] !== previousSettleState[2];
        const timersMoved = currentSettleState[1] !== previousSettleState[1];
        previousSettleState = currentSettleState;
        if (!outputMoved && !timersMoved) break;
        if (!outputMoved && pass > 0) break;
        if (nowMs() - settleStartedAt > SETTLE_BUDGET_MS) break;
        postLoadPassCount++;
        await yieldToPageTasks();
      }
      {
        const finalSettleState = getSettleState();
        loadPhases.plPasses = postLoadPassCount;
        loadPhases.plMutations = finalSettleState[0] - settleBaseline[0];
        loadPhases.plTimers = finalSettleState[1] - settleBaseline[1];
        loadPhases.plInflightEnd = finalSettleState[2];
      }
      try {
        ksGlobal.__ks_drainCustomElementUpgrades?.();
        await drainSettleMicrotasks();
        const afterUpgradeState = getSettleState();
        if (
          afterUpgradeState[0] !== previousSettleState[0] ||
          afterUpgradeState[2] !== previousSettleState[2]
        ) {
          postLoadPassCount++;
          await yieldToPageTasks();
        }
        previousSettleState = afterUpgradeState;
      } catch {}
      try {
        startLateSpriteSweep();
      } catch {}
      markLoadPhase("postLoadDrainMs");

      return {
        console: drainConsole(),
        cookieWrites: state.drainCookieWrites(),
        cdpMutations: drainCdpMutations(),
        exceptions: drainExceptions(),
        phases: loadPhases,
        readyAt: Date.now(),
      };
    })();
    state.settleLoadCompletionArmed();
    getInternalState().mutationSeq += 1;

    return {
      title: "",
      nodeCount: 0,
      documentNodeId: 0,
      url: safeUrl,
      scriptCount,
      readyState: "interactive",
      console: drainConsole(),
      cookieWrites: state.drainCookieWrites(),
      cdpMutations: drainCdpMutations(),
      exceptions: drainExceptions(),
      phases,
      bundleExec,
      fontDegradedReads: deferredDegradedReads(),
    };
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
    try {
      setTailToken((this.env as any)?.KS_TAIL_TOKEN);
    } catch {}
    if (startupLagWatchdog) {
      try {
        installLagWatchdog();
      } catch {}
    }
    const self = this;
    // Duplicate these callback stubs; openSession arguments expire when the call returns.
    const raw = init && init.upstream ? init.upstream : null;
    const upstream = raw && raw.dup ? raw.dup() : raw;
    const rawOutbound = init && init.outbound ? init.outbound : null;
    const outbound = rawOutbound && rawOutbound.dup ? rawOutbound.dup() : rawOutbound;
    if (outbound) setSessionOutbound(outbound);
    let closed = false;
    const closeSession = () => {
      if (closed) return;
      closed = true;
      clearUpstreamSender();
      if (upstream) {
        try {
          upstream[Symbol.dispose] && upstream[Symbol.dispose]();
        } catch {}
      }
      if (outbound) {
        clearSessionOutbound(outbound);
        try {
          outbound[Symbol.dispose] && outbound[Symbol.dispose]();
        } catch {}
      }
      sessionClosing = true;
      resolveSessionClosing();
    };
    if (upstream) {
      registerUpstreamSender((message) => {
        const upstreamPromise = upstream(message);
        if (upstreamPromise && upstreamPromise.catch) upstreamPromise.catch(() => {});
      });
    }
    installWasmTerminatedHandler();
    class PageScriptSessionTarget extends RpcTarget implements RetainedPageScriptSessionTarget {
      call<M extends PageScriptMethod>(
        method: M,
        params: PageScriptWireParams[M],
        meta: WireMeta,
      ): Promise<PageScriptReply<M>> {
        return invokeSessionMethod(self, method, params || {}, meta || {});
      }
      makeRenderPort() {
        return self.makeRenderPort();
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
    for (const raw of list) {
      const name = typeof raw === "string" && raw ? raw : null;
      if (!name) continue;
      const bindingCallback = function (payload) {
        if (typeof payload !== "string") return;
        sendUpstreamEvent({ event: "kitesurf.bindingCalled", params: { name, payload } });
      };
      try {
        globalThis[name] = bindingCallback;
      } catch {}
    }
    return { ok: true };
  }

  async setFrameBitmap(params: FrameBitmapParams): Promise<FrameBitmapReply> {
    const bitmap: {
      ownerBackendNodeId: unknown;
      width: unknown;
      height: unknown;
      rgba: unknown;
    } = isObjectRecord(params)
      ? {
          ownerBackendNodeId: params.ownerBackendNodeId,
          width: params.width,
          height: params.height,
          rgba: params.rgba,
        }
      : {
          ownerBackendNodeId: undefined,
          width: undefined,
          height: undefined,
          rgba: undefined,
        };
    const { ownerBackendNodeId, width, height, rgba } = bitmap;
    if (
      typeof ownerBackendNodeId !== "number" ||
      typeof width !== "number" ||
      typeof height !== "number" ||
      !(rgba instanceof Uint8Array)
    ) {
      return { ok: false, rc: -1, error: "bad args" };
    }
    if (!state.dom || typeof state.dom.setIframeImage !== "function") {
      return { ok: false, rc: -1, error: "dom missing" };
    }
    try {
      const resultCode = state.dom.setIframeImage(ownerBackendNodeId, width, height, rgba);
      if (resultCode === 0) {
        try {
          getInternalState().damageNodes.add(ownerBackendNodeId | 0);
        } catch {}
      }
      return { ok: resultCode >= 0, rc: resultCode };
    } catch (e) {
      return {
        ok: false,
        rc: -1,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async deliverMessage(params: DeliverMessageParams): Promise<{ ok: boolean; error?: string }> {
    const { dataJson, origin, sourceFrameOwnerId, fromParent } = params ?? {};
    let data: unknown = null;
    try {
      data = JSON.parse(String(dataJson ?? "null"));
    } catch {}
    const pageGlobal: any = globalThis;
    const win = pageGlobal.window ?? pageGlobal;
    let source: unknown = null;
    if (fromParent) {
      source = win.parent ?? null;
    } else if (typeof sourceFrameOwnerId === "number" && sourceFrameOwnerId > 0) {
      try {
        const iframes = pageGlobal.document?.querySelectorAll?.("iframe") ?? [];
        for (const iframeElement of iframes) {
          if (iframeElement && (iframeElement as any)._id === sourceFrameOwnerId) {
            source = (iframeElement as any).contentWindow ?? null;
            break;
          }
        }
      } catch {}
    }
    try {
      const MessageEventConstructor: any = pageGlobal.MessageEvent;
      const event = new MessageEventConstructor("message", {
        data,
        origin: String(origin ?? ""),
        source,
      });
      win.dispatchEvent(event);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async deliverWorkerEvent(params: WorkerEventParams): Promise<OkReply> {
    deliverWorkerEvent(params);
    return { ok: true };
  }

  async installIframeContent(params: IframeContentParams): Promise<OkReply> {
    const { ownerBackendNodeId, html, url, failed, frameId, mimeType, crossOrigin } = params ?? {};
    const iframeElement = state.resolveNodeId?.(ownerBackendNodeId);
    if (!iframeElement || String(iframeElement.tagName || "").toLowerCase() !== "iframe") {
      return { ok: true };
    }
    if (crossOrigin === true) {
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
    let hasSrcOrSrcdoc = false;
    try {
      hasSrcOrSrcdoc =
        iframeElement.hasAttribute?.("src") === true ||
        iframeElement.hasAttribute?.("srcdoc") === true;
    } catch {}
    if (
      (!url || url === "about:blank") &&
      !hasSrcOrSrcdoc &&
      (iframeElement as any).__ks_iframeContentDocument
    ) {
      (iframeElement as any).__ks_iframeFrameId = frameId;
      return { ok: true };
    }
    let contentDoc = null;
    try {
      const DOMParserConstructor = ksGlobal.DOMParser;
      // An about:blank document has no doctype, so it is in quirks mode.
      const sourceHtml =
        !failed && typeof html === "string" && html.length > 0
          ? html
          : !url || url === "about:blank"
            ? "<html><head></head><body></body></html>"
            : "<!doctype html><html><head></head><body></body></html>";
      if (DOMParserConstructor) {
        const parser = new DOMParserConstructor();
        const parserMime = pickDomParserMime(mimeType);
        contentDoc = parser.parseFromString(sourceHtml, parserMime);
        if (contentDoc) (contentDoc as any)._mutable = true;
        // An initial about:blank child inherits its creator's referrer.
        setFrameReferrer(
          contentDoc,
          typeof url === "string" && url && url !== "about:blank"
            ? frameNavigationReferrer(url)
            : state.pageUrl,
        );
        // Keep the committed URL available as the document base.
        if (contentDoc && typeof url === "string" && url.length > 0) {
          try {
            Object.defineProperty(contentDoc, "_baseUrl", {
              value: url,
              configurable: true,
              writable: true,
            });
          } catch {}
        }
      }
    } catch (err) {
      try {
        console.warn(
          "[kitesurf-iframe] parseFromString failed for " + url + ":",
          err instanceof Error ? err.message : String(err),
        );
      } catch {}
    }
    const contentWindow: Record<string, unknown> = {
      document: contentDoc,
      parent: ksGlobal.window ?? globalThis,
      top: ksGlobal.window ?? globalThis,
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
    if (contentDoc) {
      try {
        Object.defineProperty(contentDoc, "defaultView", {
          value: contentWindow,
          configurable: true,
        });
      } catch {}
    }
    (iframeElement as any).__ks_iframeContentDocument = contentDoc;
    (iframeElement as any).__ks_iframeContentWindow = contentWindow;
    (iframeElement as any).__ks_iframeFrameId = frameId;
    fireIframeLoad(iframeElement);
    return { ok: true };
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
    const returnByValue = !!(options && options.returnByValue);
    const awaitPromise = options === undefined ? true : options.awaitPromise !== false;
    const thisObjectId =
      options && typeof options.thisObjectId === "string" ? options.thisObjectId : null;
    let result: EvalResultBody;
    try {
      const functionSource =
        typeof functionDeclaration === "string" ? functionDeclaration : "undefined";
      const factory = new SyncFunction("return (" + functionSource + ");");
      const pageFunction = factory();
      if (typeof pageFunction !== "function") {
        throw new TypeError("functionDeclaration did not evaluate to a function");
      }
      const argumentValues = (Array.isArray(argumentSpecs) ? argumentSpecs : []).map((spec) => {
        if (typeof spec === "string") {
          try {
            return JSON.parse(spec);
          } catch {
            return undefined;
          }
        }
        if (spec && typeof spec === "object") {
          if (typeof spec.objectId === "string") {
            return lookupHandle(spec.objectId);
          }
          if (typeof spec.json === "string") {
            try {
              return JSON.parse(spec.json);
            } catch {
              return undefined;
            }
          }
        }
        return undefined;
      });
      const thisValue =
        thisObjectId !== null ? (lookupHandle(thisObjectId) ?? globalThis) : globalThis;
      let value = pageFunction.apply(thisValue, argumentValues);
      if (awaitPromise && value && typeof value.then === "function") {
        value = await value;
      }
      result = packResult(value, returnByValue);
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "EvalError" &&
        typeof error.message === "string" &&
        error.message.includes("Code generation from strings disallowed")
      ) {
        const functionSource =
          typeof functionDeclaration === "string" ? functionDeclaration : "undefined";
        const liveArguments = (Array.isArray(argumentSpecs) ? argumentSpecs : []).map((spec) => {
          if (typeof spec === "string") {
            try {
              return JSON.parse(spec);
            } catch {
              return undefined;
            }
          }
          if (spec && typeof spec === "object") {
            if (typeof spec.objectId === "string") return lookupHandle(spec.objectId);
            if (typeof spec.json === "string") {
              try {
                return JSON.parse(spec.json);
              } catch {
                return undefined;
              }
            }
          }
          return undefined;
        });
        const thisValue =
          thisObjectId !== null ? (lookupHandle(thisObjectId) ?? globalThis) : globalThis;
        try {
          const boaResult = await ks_call_cdp(
            functionSource,
            thisValue,
            liveArguments,
            awaitPromise,
            returnByValue,
          );
          result = packBoaResult(boaResult, returnByValue);
        } catch (boaError) {
          result = packException(
            boaError instanceof Error ? boaError : new Error(String(boaError)),
          );
        }
      } else {
        result = packException(error);
      }
    }
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
    if (
      objectValue === null ||
      (typeof objectValue !== "object" && typeof objectValue !== "function")
    ) {
      return { result: [] };
    }
    const result: PropertyDescriptor[] = [];
    const seen = new Set();
    const collect = (target, isOwn) => {
      let names;
      try {
        names = Object.getOwnPropertyNames(target);
      } catch {
        return;
      }
      for (const name of names) {
        if (seen.has(name)) continue;
        seen.add(name);
        let descriptor;
        try {
          descriptor = Object.getOwnPropertyDescriptor(target, name);
        } catch {
          continue;
        }
        if (!descriptor) continue;
        const entry: PropertyDescriptor = {
          name,
          configurable: !!descriptor.configurable,
          enumerable: !!descriptor.enumerable,
          isOwn,
        };
        if ("value" in descriptor) {
          entry.writable = !!descriptor.writable;
          try {
            entry.value = packResult(descriptor.value, false);
          } catch {}
        } else {
          if (typeof descriptor.get === "function") {
            try {
              entry.get = packResult(descriptor.get, false);
            } catch {}
          }
          if (typeof descriptor.set === "function") {
            try {
              entry.set = packResult(descriptor.set, false);
            } catch {}
          }
        }
        result.push(entry);
      }
    };
    collect(objectValue, true);
    if (!ownOnly) {
      const MAX_PROTOTYPE_DESCRIPTOR_CHAIN_DEPTH = 6;
      let proto = null;
      try {
        proto = Object.getPrototypeOf(objectValue);
      } catch {}
      let depth = 0;
      while (proto && depth++ < MAX_PROTOTYPE_DESCRIPTOR_CHAIN_DEPTH) {
        collect(proto, false);
        try {
          proto = Object.getPrototypeOf(proto);
        } catch {
          break;
        }
      }
    }
    return { result };
  }

  async dispatchMouseEvent(type: string, init: MouseEventInit): Promise<MouseDispatchReply> {
    if (!state.document || typeof ksEventCtors.MouseEvent !== "function") {
      return {
        console: drainConsole(),
        cookieWrites: state.drainCookieWrites(),
        cdpMutations: drainCdpMutations(),
        defaultPrevented: false,
      };
    }
    let defaultPrevented = false;
    let navigateTo: string | null = null;
    let hashNavigateTo: string | null = null;
    let navigatePost: ReturnType<typeof takePendingSubmitNav> = null;
    const internalState = getInternalState();
    internalState.dispatchingUserEvent = true;
    internalState.pendingSubmitNav = null;
    try {
      const eventType = String(type || "click");
      const clientX = init && typeof init.clientX === "number" ? init.clientX : 0;
      const clientY = init && typeof init.clientY === "number" ? init.clientY : 0;
      const previousMousePosition = eventType === "mousemove" ? lastMousePosition : null;
      const eventInit = {
        ...(init || {}),
        composed: true,
        pageX: clientX + state.scrollX,
        pageY: clientY + state.scrollY,
        movementX: previousMousePosition ? clientX - previousMousePosition.x : 0,
        movementY: previousMousePosition ? clientY - previousMousePosition.y : 0,
      };
      if (eventType === "mousemove" || eventType === "mousedown" || eventType === "mouseup") {
        lastMousePosition = { x: clientX, y: clientY };
      }
      const POINTER_EVENT_TYPES = ["click", "auxclick", "dblclick", "contextmenu"];
      let event: MouseInputEvent;
      if (eventType === "wheel" && typeof ksEventCtors.WheelEvent === "function") {
        event = new ksEventCtors.WheelEvent(eventType, eventInit);
      } else if (
        POINTER_EVENT_TYPES.indexOf(eventType) !== -1 &&
        typeof ksEventCtors.PointerEvent === "function"
      ) {
        event = new ksEventCtors.PointerEvent(eventType, {
          ...eventInit,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
        });
      } else {
        event = new ksEventCtors.MouseEvent(eventType, eventInit);
      }

      let targetEl = mouseTargetAtPoint(eventType, clientX, clientY, event);
      if (!targetEl) {
        targetEl = state.document.body || state.document.documentElement || state.document;
      }

      if (__ksOverTarget && !__ksIsConnected(__ksOverTarget)) {
        const recomputed = __ksFirstConnected(__ksOverChain);
        __ksSetOverTarget(recomputed);
        __ksFireBoundaryEvent(recomputed, "pointerover", null, true, eventInit);
        __ksFireBoundaryEvent(recomputed, "mouseover", null, true, eventInit);
      }

      const targetChain = __ksAncestorChain(targetEl);
      if (eventType === "mousemove" && __ksOverTarget !== targetEl) {
        const from = __ksOverTarget;
        __ksSetOverTarget(targetEl, targetChain);
        __ksDispatchBoundaryEvents(from, targetEl, eventInit);
      }

      if (targetEl && !__ksIsConnected(targetEl)) {
        const reconnected: MouseTarget | null = __ksFirstConnected(targetChain);
        if (reconnected) {
          targetEl = reconnected;
          if (eventType === "mousemove") __ksSetOverTarget(reconnected);
        }
      }

      if (eventType === "mousedown") {
        __ksMouseDownTarget = targetEl;
      } else if (
        (eventType === "click" || eventType === "dblclick" || eventType === "auxclick") &&
        __ksMouseDownTarget &&
        __ksMouseDownTarget !== targetEl
      ) {
        const common: MouseTarget | null = __ksCommonAncestor(__ksMouseDownTarget, targetEl);
        if (common) targetEl = common;
      }

      const isRangeInput = (element) =>
        element &&
        element.tagName === "INPUT" &&
        element.getAttribute &&
        (element.getAttribute("type") || "").toLowerCase() === "range";
      const applyRangeFromX = (element, clientX) => {
        try {
          const rect = element.getBoundingClientRect();
          if (!rect || !(rect.width > 0)) return false;
          const DEFAULT_RANGE_INPUT_MAX = 100;
          const RANGE_INPUT_THUMB_MIN_RADIUS_PX = 2;
          const RANGE_INPUT_THUMB_HEIGHT_FRACTION = 0.5;
          const RANGE_INPUT_THUMB_WIDTH_FRACTION = 0.25;
          const RANGE_INPUT_THUMB_RADIUS_FACTOR = 0.8;
          const RANGE_INPUT_MIN_TRACK_TRAVEL_PX = 1;
          const min = parseFloat(element.getAttribute("min")) || 0;
          const maxRaw = parseFloat(element.getAttribute("max"));
          const max = Math.max(min, Number.isFinite(maxRaw) ? maxRaw : DEFAULT_RANGE_INPUT_MAX);
          const stepAttr = element.getAttribute("step");
          const step =
            stepAttr === "any"
              ? 0
              : Number.isFinite(parseFloat(stepAttr)) && parseFloat(stepAttr) > 0
                ? parseFloat(stepAttr)
                : 1;
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
          const next = String(raw);
          if (getValueRawOnControl(element) === next) return false;
          setValueRawOnControl(element, next);
          try {
            __ks_dispatchTrusted(
              element,
              new ksEventCtors.InputEvent("input", {
                bubbles: true,
                cancelable: false,
              }),
            );
          } catch {}
          return true;
        } catch {
          return false;
        }
      };
      if (eventType === "mousemove" && __ksRangeDrag && __ksRangeDrag.el) {
        const rangeDrag = __ksRangeDrag;
        if (applyRangeFromX(rangeDrag.el, clientX)) rangeDrag.changed = true;
      } else if (eventType === "mouseup" && __ksRangeDrag && __ksRangeDrag.el) {
        const rangeDrag = __ksRangeDrag;
        if (applyRangeFromX(rangeDrag.el, clientX)) rangeDrag.changed = true;
        if (rangeDrag.changed) {
          try {
            __ks_dispatchTrusted(
              rangeDrag.el,
              new ksEventCtors.Event("change", {
                bubbles: true,
                cancelable: false,
              }),
            );
          } catch {}
        }
        __ksRangeDrag = null;
      }

      const isCheckableTarget =
        eventType === "click" &&
        targetEl &&
        targetEl.tagName === "INPUT" &&
        ((targetEl.type || "").toLowerCase() === "checkbox" ||
          (targetEl.type || "").toLowerCase() === "radio");
      let previousCheckedState;
      const setCheckedRaw = (element, value) => {
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
      };
      if (isCheckableTarget) {
        previousCheckedState = !!targetEl.checked;
        const nextCheckedState =
          (targetEl.type || "").toLowerCase() === "checkbox" ? !previousCheckedState : true;
        setCheckedRaw(targetEl, nextCheckedState);
      }

      let compatibilityMouseAllowed = true;
      const dispatchPointerEvent = (eventType) => {
        if (typeof ksEventCtors.PointerEvent !== "function") return true;
        const pointerInit = {
          ...eventInit,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
        };
        const coalescedEvents =
          eventType === "pointermove"
            ? [new ksEventCtors.PointerEvent(eventType, pointerInit)]
            : undefined;
        return __ks_dispatchTrusted(
          targetEl,
          new ksEventCtors.PointerEvent(eventType, {
            ...pointerInit,
            coalescedEvents,
          }),
        );
      };
      if (eventType === "mousedown") {
        __ksPointerDownCanceled = false;
        __ksPointerDownCanceled = !dispatchPointerEvent("pointerdown");
        compatibilityMouseAllowed = !__ksPointerDownCanceled;
        defaultPrevented = !compatibilityMouseAllowed;
      } else if (eventType === "mousemove") {
        dispatchPointerEvent("pointermove");
        compatibilityMouseAllowed = !__ksPointerDownCanceled;
      } else if (eventType === "mouseup") {
        dispatchPointerEvent("pointerup");
        if (__ksPointerDownCanceled) {
          compatibilityMouseAllowed = false;
          __ksPointerDownCanceled = false;
        }
      }

      const allowed = compatibilityMouseAllowed ? __ks_dispatchTrusted(targetEl, event) : true;
      if (compatibilityMouseAllowed || eventType !== "mousedown") {
        defaultPrevented = !allowed;
      }

      if (eventType === "mousedown" && !defaultPrevented) {
        const focusable = findFocusableAncestor(targetEl);
        if (focusable && typeof focusable.focus === "function") {
          try {
            focusable.focus();
          } catch {}
        } else if (
          state.document &&
          state.document.activeElement &&
          typeof state.document.activeElement.blur === "function"
        ) {
          try {
            state.document.activeElement.blur();
          } catch {}
        }
      }

      const wantsCaretWork =
        (eventType === "mousedown" && !defaultPrevented) ||
        (eventType === "mousemove" && __ksCaretDragActive && (event.buttons & 1) === 1);
      if (wantsCaretWork) {
        updateCaretFromMouse(eventType, event, targetEl, clientX, clientY);
      }
      if (eventType === "mouseup") {
        __ksCaretDragActive = false;
        __ksControlCaretAnchor = null;
        __ksCaretDragOrigin = null;
      }

      if (
        eventType === "mousedown" &&
        !defaultPrevented &&
        isRangeInput(targetEl) &&
        !targetEl.disabled
      ) {
        __ksRangeDrag = { el: targetEl, changed: false };
        if (applyRangeFromX(targetEl, clientX)) __ksRangeDrag.changed = true;
      }

      if (eventType === "wheel" && !defaultPrevented) {
        const dx = event.deltaX || 0;
        const dy = event.deltaY || 0;
        const wheelBridge = ksGlobal.__ks_scrollByWheel;
        let bridgeAvailable =
          typeof wheelBridge === "function" && !!targetEl && typeof targetEl._id === "number";
        if (bridgeAvailable) {
          try {
            wheelBridge(targetEl._id, dx, dy);
          } catch {
            bridgeAvailable = false;
          }
        }
        if (!bridgeAvailable) {
          try {
            scrollBy(dx, dy);
          } catch {}
        }
      }

      if (isCheckableTarget) {
        if (defaultPrevented) {
          setCheckedRaw(targetEl, previousCheckedState);
        } else {
          try {
            const inputEv = new ksEventCtors.InputEvent("input", {
              bubbles: true,
              cancelable: false,
            });
            __ks_dispatchTrusted(targetEl, inputEv);
          } catch {}
          try {
            const changeEv = new ksEventCtors.Event("change", {
              bubbles: true,
              cancelable: false,
            });
            __ks_dispatchTrusted(targetEl, changeEv);
          } catch {}
        }
      }

      if (eventType === "click" && !defaultPrevented && targetEl) {
        try {
          const activationNavigation = buttonActivationNavigation(targetEl);
          if (activationNavigation) navigateTo = activationNavigation;
        } catch (err) {
          console.error("[kitesurf] button activation failed", err);
        }
      }

      // CDP clicks bypass Element.click(); the shim owns forwarding without exposing a page-global
      // hook or trusting a page-provided isTrusted property.
      if (eventType === "click" && !defaultPrevented && targetEl) {
        try {
          __ks_activateLabel?.(targetEl, event);
        } catch (err) {
          console.error("[kitesurf] label activation failed", err);
        }
      }

      if (eventType === "click" && !defaultPrevented && targetEl) {
        try {
          let sel: MouseTarget | null | undefined = targetEl;
          while (sel && sel !== state.document && (sel.tagName || "").toUpperCase() !== "SELECT") {
            sel = sel.parentNode;
          }
          const toggle = ksGlobal.__ksSelectDropdownToggle;
          if (
            sel &&
            (sel.tagName || "").toUpperCase() === "SELECT" &&
            typeof toggle === "function"
          ) {
            toggle(sel);
          }
        } catch (err) {
          console.error("[kitesurf] select dropdown toggle failed", err);
        }
      }

      if (eventType === "click" && !defaultPrevented && targetEl) {
        try {
          toggleDetailsFromSummary(targetEl);
        } catch (err) {
          console.error("[kitesurf] details toggle failed", err);
        }
      }

      if (eventType === "click" && !defaultPrevented && targetEl && targetEl !== state.document) {
        const navigation = activateAnchorNavigation(targetEl, clientX, clientY);
        if (navigation?.kind === "hash") {
          hashNavigateTo = navigation.url;
        } else if (navigation?.kind === "navigate") {
          navigateTo = navigation.url;
        }
      }
    } catch (err) {
      console.error("[kitesurf] Input.dispatchMouseEvent failed", err);
    } finally {
      const nav = takePendingSubmitNav();
      if (nav && typeof nav.url === "string") {
        if (typeof nav.postData === "string") navigatePost = nav;
        else if (!navigateTo) navigateTo = nav.url;
      }
    }
    return {
      console: drainConsole(),
      cookieWrites: state.drainCookieWrites(),
      cdpMutations: drainCdpMutations(),
      defaultPrevented,
      navigateTo,
      navigatePost,
      hashNavigateTo,
    };
  }

  async dispatchKeyEvent(type: string, init: KeyEventInit): Promise<KeyDispatchReply> {
    const KeyboardEventConstructor:
      | BuildDocumentResult["Event"]
      | BuildDocumentResult["KeyboardEvent"] = ksEventCtors.KeyboardEvent || ksEventCtors.Event;
    if (!state.document || typeof KeyboardEventConstructor !== "function") {
      return {
        console: drainConsole(),
        cookieWrites: state.drainCookieWrites(),
        cdpMutations: drainCdpMutations(),
        defaultPrevented: false,
      };
    }
    if (type === "keydown") __ksSuppressChar = false;
    if (type === "keypress" && __ksSuppressChar) {
      return {
        console: drainConsole(),
        cookieWrites: state.drainCookieWrites(),
        cdpMutations: drainCdpMutations(),
        defaultPrevented: true,
      };
    }
    let defaultPrevented = false;
    let navigateTo: string | null = null;
    let navigatePost: ReturnType<typeof takePendingSubmitNav> = null;
    const internalState = getInternalState();
    internalState.dispatchingUserEvent = true;
    internalState.pendingSubmitNav = null;
    try {
      const eventType = String(type || "keydown");
      const event = new KeyboardEventConstructor(eventType, {
        ...(init || {}),
        composed: true,
      });
      const focused = state.getActiveElement();
      const targetEl =
        focused || state.document.body || state.document.documentElement || state.document;
      const allowed = __ks_dispatchTrusted(targetEl, event);
      defaultPrevented = !allowed;
      if (eventType === "keydown" && defaultPrevented) __ksSuppressChar = true;

      if (
        eventType === "keydown" &&
        init?.key === "Tab" &&
        !defaultPrevented &&
        !init.altKey &&
        !init.ctrlKey &&
        !init.metaKey
      ) {
        moveTabFocus(!!init.shiftKey);
      }
      if (eventType === "keydown" && !defaultPrevented) {
        scrollForKey(init?.key || "", init);
      }

      {
        const keyName = init && typeof init.key === "string" ? init.key : "";
        const isSpace = keyName === " " || keyName === "Spacebar";
        if (eventType === "keydown" && isSpace) {
          __ksSpaceArmedTarget =
            !defaultPrevented && focused && isKeyboardActivatable(focused) ? focused : null;
        }
        const activateNow =
          !defaultPrevented &&
          focused &&
          ((eventType === "keydown" && keyName === "Enter" && isKeyboardActivatable(focused)) ||
            (eventType === "keyup" && isSpace && __ksSpaceArmedTarget === focused));
        if (eventType === "keyup" && isSpace) __ksSpaceArmedTarget = null;
        if (activateNow) {
          try {
            focused.click?.();
          } catch {}
        }
      }

      const isCharBearing = eventType === "keydown" || eventType === "keypress";
      const editHost = defaultPrevented ? null : editingHostOf(focused);
      if (editHost) {
        const text = typeof init?.text === "string" ? init.text : "";
        const key = typeof init?.key === "string" ? init.key : "";
        if (eventType === "keydown" && (key === "Backspace" || key === "Delete")) {
          editContentEditable(
            editHost,
            key === "Backspace" ? "deleteContentBackward" : "deleteContentForward",
            null,
            __ks_dispatchTrusted,
          );
        } else if (isCharBearing && text && !init.ctrlKey && !init.metaKey) {
          let typed = true;
          if (eventType === "keydown") {
            typed = __ks_dispatchTrusted(
              targetEl,
              new KeyboardEventConstructor("keypress", { ...init, composed: true }),
            );
          }
          if (!typed) {
            defaultPrevented = true;
          } else if (text === "\r" || text === "\n") {
            editContentEditable(
              editHost,
              init.shiftKey ? "insertLineBreak" : "insertParagraph",
              null,
              __ks_dispatchTrusted,
            );
          } else if (!hasControlChar(text)) {
            editContentEditable(editHost, "insertText", text, __ks_dispatchTrusted);
          }
        }
      }
      if (
        focused &&
        !defaultPrevented &&
        isCharBearing &&
        (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA")
      ) {
        const text = init && typeof init.text === "string" ? init.text : "";
        const key = init && typeof init.key === "string" ? init.key : "";
        const oldValue = getValueRawOnControl(focused);
        const oldLength = oldValue.length;
        const rawStart =
          typeof focused.selectionStart === "number" ? focused.selectionStart : oldLength;
        const rawEnd = typeof focused.selectionEnd === "number" ? focused.selectionEnd : rawStart;
        const selectionStart = Math.max(0, Math.min(rawStart, oldLength));
        const selectionEnd = Math.max(selectionStart, Math.min(rawEnd, oldLength));
        let newValue = oldValue;
        let nextCursor = selectionStart;
        const HIGH_SURROGATE_START_CODE_UNIT = 0xd800;
        const HIGH_SURROGATE_END_CODE_UNIT = 0xdbff;
        const LOW_SURROGATE_START_CODE_UNIT = 0xdc00;
        const LOW_SURROGATE_END_CODE_UNIT = 0xdfff;
        const isHighSurrogate = (unit: number) =>
          unit >= HIGH_SURROGATE_START_CODE_UNIT && unit <= HIGH_SURROGATE_END_CODE_UNIT;
        const isLowSurrogate = (unit: number) =>
          unit >= LOW_SURROGATE_START_CODE_UNIT && unit <= LOW_SURROGATE_END_CODE_UNIT;
        const isPrintable = text.length > 0 && !hasControlChar(text);
        if (isPrintable) {
          newValue = oldValue.slice(0, selectionStart) + text + oldValue.slice(selectionEnd);
          nextCursor = selectionStart + text.length;
        } else if (eventType === "keydown" && (key === "Backspace" || key === "Delete")) {
          if (selectionStart !== selectionEnd) {
            newValue = oldValue.slice(0, selectionStart) + oldValue.slice(selectionEnd);
          } else if (key === "Backspace" && selectionStart > 0) {
            const previous = selectionStart - 1;
            const deleteStart =
              previous > 0 &&
              isLowSurrogate(oldValue.charCodeAt(previous)) &&
              isHighSurrogate(oldValue.charCodeAt(previous - 1))
                ? previous - 1
                : previous;
            newValue = oldValue.slice(0, deleteStart) + oldValue.slice(selectionEnd);
            nextCursor = deleteStart;
          } else if (key === "Delete" && selectionStart < oldLength) {
            const next = selectionStart + 1;
            const deleteEnd =
              isHighSurrogate(oldValue.charCodeAt(selectionStart)) &&
              next < oldLength &&
              isLowSurrogate(oldValue.charCodeAt(next))
                ? next + 1
                : next;
            newValue = oldValue.slice(0, selectionStart) + oldValue.slice(deleteEnd);
          }
        }
        if (newValue !== oldValue) {
          setValueRawOnControl(focused, newValue);
          notifyControlValueMutation(focused, nextCursor, KeyboardEventConstructor);
        }
        if (eventType === "keydown" && key === "Enter" && focused.tagName === "INPUT") {
          dispatchEnterChange(focused, KeyboardEventConstructor);
          const implicitNavigation = submitFormOnEnter(focused);
          if (implicitNavigation) navigateTo = implicitNavigation;
        }
      }
    } catch (err) {
      console.error("[kitesurf] Input.dispatchKeyEvent failed", err);
    } finally {
      const nav = takePendingSubmitNav();
      if (nav && typeof nav.url === "string") {
        if (typeof nav.postData === "string") navigatePost = nav;
        else if (!navigateTo) navigateTo = nav.url;
      }
    }
    return {
      console: drainConsole(),
      cookieWrites: state.drainCookieWrites(),
      cdpMutations: drainCdpMutations(),
      defaultPrevented,
      navigateTo,
      navigatePost,
    };
  }

  queryDom<M extends QueryDomMethod>(method: M, args: QueryDomArgs<M>): Promise<QueryDomResult<M>>;
  async queryDom(
    method: QueryDomMethod,
    args: Record<string, unknown> | undefined,
  ): Promise<QueryDomResult<QueryDomMethod>> {
    if (method === "setFrameContext") {
      const parentOrigin = String(args?.parentOrigin ?? "");
      getInternalState().frameContext = { parentOrigin };
      return { ok: true } satisfies QueryDomResult<"setFrameContext">;
    }
    requireQueryDomDocument(state);
    const queryArgs = args || {};
    switch (method) {
      case "getDocument":
      case "nodeSubtree":
      case "getOuterHTMLAndSeq":
        return queryDomDocumentRead(state, method, queryArgs);
      case "getOuterHTML":
        return queryDomOuterHTML(state, queryArgs);
      case "querySelector":
      case "querySelectorAll":
      case "matchSelectorList":
        return queryDomSelectorRead(state, method, queryArgs);
      case "getAncestorElementIds":
        return queryDomAncestorElementIds(state, queryArgs);
      case "parseStyleSheet":
        return queryDomParseStylesheet(queryArgs);
      case "enumerateStyleSheets":
        return queryDomEnumerateStyleSheets(state);
      case "getSceneStats":
        return queryDomSceneStats();
      case "pumpTasks":
        return queryDomPumpTasks(queryArgs);
      case "recordScene":
        return queryDomRecordScene(state, queryArgs);
      case "getFontUrlData":
        return queryDomGetFontUrlData(queryArgs);
      case "getPaintResources":
        return queryDomGetPaintResources(state, queryArgs);
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
        return queryDomFormState(state, method, queryArgs);
      case "setViewport":
        return queryDomSetViewport(state, queryArgs);
      case "setMediaType":
        return queryDomSetMediaType(state, queryArgs);
      case "setSuppressBackgrounds":
        return queryDomSetSuppressBackgrounds(queryArgs);
      case "awaitPendingResources":
        return await queryDomAwaitPendingResources(state, queryArgs);
      case "pageBoxJson":
      case "setLayoutMode":
      case "getLayoutMode":
      case "setCdpDomActive":
        return queryDomLayoutSettings(state, method, queryArgs);
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
        return queryDomNodeHandle(state, method, queryArgs);
      case "hasPendingCriticalResources":
        return queryDomHasPendingCriticalResources(state);
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
}

type QueryDomActiveState = typeof state & { dom: DomHandle };

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
    case "getDocument": {
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
    case "nodeSubtree": {
      const id = numericNodeId(queryArgs);
      if (id == null) return { node: null } satisfies QueryDomResult<"nodeSubtree">;
      try {
        const subtree = pageState.dom.nodeSubtree ? pageState.dom.nodeSubtree(id) : null;
        return {
          node: sanitizeCdpNodeTree(subtree) || null,
        } satisfies QueryDomResult<"nodeSubtree">;
      } catch {
        return { node: null } satisfies QueryDomResult<"nodeSubtree">;
      }
    }
    case "getOuterHTMLAndSeq": {
      let outerHTML = "";
      try {
        outerHTML = pageState.dom.outerHTML(0);
      } catch {}
      const seq = getInternalState().mutationSeq | 0;
      return {
        outerHTML,
        seq,
        scrollX: state.scrollX,
        scrollY: state.scrollY,
      } satisfies QueryDomResult<"getOuterHTMLAndSeq">;
    }
  }
}

function queryDomOuterHTML(
  pageState: QueryDomActiveState,
  queryArgs: Record<string, unknown>,
): QueryDomResult<"getOuterHTML"> {
  const id = numericNodeId(queryArgs) ?? 0;
  try {
    const rawOuterHTML = pageState.dom.outerHTML(id);
    const sourceDoctype =
      state.document?.doctype?.parentNode === state.document ? state.sourceDoctype : null;
    const markerMarkup = state.sourceDoctype ? `<!--${state.sourceDoctype.marker}-->` : null;
    const markerIndex = id === 0 && markerMarkup ? rawOuterHTML.indexOf(markerMarkup) : -1;
    const outerHTML =
      markerIndex >= 0 && markerMarkup
        ? rawOuterHTML.slice(0, markerIndex) + rawOuterHTML.slice(markerIndex + markerMarkup.length)
        : rawOuterHTML;
    if (
      id !== 0 ||
      queryArgs.includeDoctype !== true ||
      !sourceDoctype ||
      markerIndex < 0 ||
      /^(?:\s|<!--[\s\S]*?-->)*<!doctype\b/i.test(outerHTML)
    ) {
      return { outerHTML } satisfies QueryDomResult<"getOuterHTML">;
    }
    return {
      outerHTML:
        outerHTML.slice(0, markerIndex) + sourceDoctype.markup + outerHTML.slice(markerIndex),
    } satisfies QueryDomResult<"getOuterHTML">;
  } catch {
    return { outerHTML: "" } satisfies QueryDomResult<"getOuterHTML">;
  }
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
    case "querySelector": {
      const selector = String(queryArgs.selector || "");
      try {
        const id = pageState.dom.querySelector(selector);
        return { nodeId: id < 0 ? 0 : id } satisfies QueryDomResult<"querySelector">;
      } catch (err) {
        return { nodeId: 0, error: String(err) } satisfies QueryDomResult<"querySelector">;
      }
    }
    case "querySelectorAll": {
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
    case "matchSelectorList": {
      const nodeId = numericNodeId(queryArgs);
      if (nodeId == null) return { matches: [] } satisfies QueryDomResult<"matchSelectorList">;
      const selectorListText = String(queryArgs.selectorListText || "");
      const selectors = splitSelectorList(selectorListText);
      const matches: number[] = [];
      for (let i = 0; i < selectors.length; i++) {
        const sel = selectors[i].trim();
        if (!sel) continue;
        try {
          if (pageState.dom.matchesInSubtree(nodeId, sel)) {
            matches.push(i);
          }
        } catch {}
      }
      return { matches } satisfies QueryDomResult<"matchSelectorList">;
    }
  }
}

function queryDomAncestorElementIds(
  pageState: QueryDomActiveState,
  queryArgs: Record<string, unknown>,
): QueryDomResult<"getAncestorElementIds"> {
  const id = numericNodeId(queryArgs);
  if (id == null) return { ancestorIds: [] } satisfies QueryDomResult<"getAncestorElementIds">;
  const ancestorIds: number[] = [];
  let currentNodeId = id;
  for (let hops = 0; hops < MAX_ANCESTOR_STYLE_HOPS; hops++) {
    let parent: number;
    try {
      parent = pageState.dom.parentId(currentNodeId);
    } catch {
      break;
    }
    if (typeof parent !== "number" || parent < 0) break;
    let info: { nodeType?: number } | null = null;
    try {
      info = pageState.dom.nodeInfo(parent);
    } catch {}
    if (!info) break;
    if (info.nodeType === 1) ancestorIds.push(parent);
    else if (info.nodeType === 9) break;
    currentNodeId = parent;
  }
  return { ancestorIds } satisfies QueryDomResult<"getAncestorElementIds">;
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
    if (typeof id !== "number" || id < 0) continue;
    let text = "";
    try {
      text = pageState.dom.textContent(id) || "";
    } catch {}
    sheets.push({ ownerNodeId: id, text, isInline: true });
  }
}

function appendLinkedStyleSheets(
  pageState: QueryDomActiveState,
  sheets: QueryDomEnumeratedStyleSheets,
): void {
  const linkIds = pageState.dom.querySelectorAll("link[rel]");
  for (const id of Array.from(linkIds)) {
    if (typeof id !== "number" || id < 0) continue;
    let attrs: unknown[] | undefined;
    try {
      attrs = attributesFromNodeInfo(pageState.dom.nodeInfo(id));
    } catch {}
    if (!attrs) continue;
    const href = stylesheetHref(attrs);
    if (!href) continue;
    let resolvedUrl = "";
    try {
      const base = pageState.dom.baseURL() || "about:blank";
      resolvedUrl = new URL(href, base).href;
    } catch {
      continue;
    }
    const cached = resourceCacheStyles.get(resolvedUrl) ?? "";
    sheets.push({
      ownerNodeId: id,
      text: cached,
      sourceURL: resolvedUrl,
      isInline: false,
      cors: stylesheetCors.get(resolvedUrl) ?? "pending",
    });
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
  const idle = seq !== 0 && seq <= wakeAfter && !animating && !hasPendingAnimationFrames();
  armPaintWake(idle ? wakeAfter : null);
  return {
    seq,
    animating,
    pumped,
    idle,
    nextRafDelayMs,
  } satisfies QueryDomResult<"pumpTasks">;
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
    wake.sinceSeq !== null &&
    wake.seqNow <= wake.sinceSeq &&
    wake.seqNow !== 0 &&
    state.scrollX === state.lastRecordScrollX &&
    state.scrollY === state.lastRecordScrollY &&
    state.paintViewportW === state.lastRecordViewportW &&
    state.paintViewportH === state.lastRecordViewportH &&
    !isAnimating()
  );
}

async function queryDomRecordScene(
  pageState: QueryDomActiveState,
  queryArgs: Record<string, unknown>,
): Promise<QueryDomResult<"recordScene">> {
  // Scene-stream and screencast wake thresholds are tracked independently.
  const armWake = queryArgs.armWake === true;
  if (typeof queryArgs.armWake === "boolean") armPaintWake(null, "scene");
  let pumped = -1;
  let pumpMs = 0;
  let nextRafDelayMs: number | undefined;
  if (queryArgs.pumpRaf === true) {
    const { frameIntervalMs }: { frameIntervalMs?: unknown } = queryArgs;
    const pumpResult = await pumpPageTasksAsDriver(frameIntervalMs);
    pumped = pumpResult.pumped;
    pumpMs = pumpResult.pumpMs;
    nextRafDelayMs = pumpResult.nextRafDelayMs;
  }
  for (const push of [...getInternalState().pendingCanvasPushes]) push();
  const seqNow = getInternalState().mutationSeq | 0;
  const sinceSeq = typeof queryArgs.sinceSeq === "number" ? queryArgs.sinceSeq | 0 : null;
  const wake = { armWake, pumped, pumpMs, nextRafDelayMs, seqNow, sinceSeq };
  if (isRecordSceneUnchanged(wake)) {
    return {
      unchanged: true,
      seq: seqNow,
      idle: armRecordSceneIdleWake(armWake, seqNow),
      pumped,
      pumpMs,
      nextRafDelayMs,
      scrollX: state.scrollX,
      scrollY: state.scrollY,
    } satisfies QueryDomResult<"recordScene">;
  }
  const preparation = prepareQueryDomRecordScene(pageState, queryArgs, wake);
  if (preparation.kind === "response") return preparation.response;
  const rendered = renderQueryDomScene(preparation.context);
  if (rendered.kind === "response") return rendered.response;
  return finishQueryDomRecordScene(preparation.context, rendered);
}

function prepareQueryDomRecordScene(
  pageState: QueryDomActiveState,
  queryArgs: Record<string, unknown>,
  wake: QueryDomRecordSceneWake,
): QueryDomRecordScenePreparation {
  const cascadeSeqNow = cascadeSeq();
  const omitBg = queryArgs.omitBackground === true;
  const clientWire = queryArgs.producer === "client";
  const rawImages = queryArgs.images === "raw";
  const internalState = getInternalState();
  const allowPartial = queryArgs.allowPartial === true;
  const baseSeq = typeof queryArgs.baseSeq === "number" ? queryArgs.baseSeq | 0 : -1;
  const epochLayoutDirty = !!internalState.layoutDirtySinceRecord;
  const epochDamage = internalState.damageNodes;
  const epochDamageSize = epochDamage.size;
  // An interleaved scene record can invalidate the renderer's base sequence.
  const epochBase = internalState.lastRecordSeq | 0;
  const { paint, fresh: isFreshPaint } = takePaintPrep();
  if (!paint) {
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
  prepareCachedPaint(paint, isFreshPaint, cascadeSeqNow);
  const clip = readSceneClip(queryArgs.clip);
  const hasClip = clip !== null;
  const scrollDx = state.scrollX - state.lastRecordScrollX;
  const scrollDy = state.scrollY - state.lastRecordScrollY;
  const scrolled = scrollDx !== 0 || scrollDy !== 0;
  const allowScrollShift = queryArgs.allowScrollShift === true;
  const partialPlan = planPartialScene({
    paint,
    allowPartial,
    clientWire,
    epochLayoutDirty,
    baseSeq,
    epochBase,
    scrolled,
    allowScrollShift,
    scrollDeltaX: scrollDx,
    scrollDeltaY: scrollDy,
    sinceSeq: wake.sinceSeq,
    hasClip,
    epochDamage,
    viewportWidth: state.paintViewportW || 0,
    viewportHeight: state.paintViewportH || 0,
  });
  const context: QueryDomRecordSceneContext = {
    pageState,
    queryArgs,
    wake,
    internalState,
    epochDamageSize,
    epochLayoutDirty,
    rawImages,
    omitBg,
    clientWire,
    allowPartial,
    baseSeq,
    paint,
    clip,
    hasClip,
    scrollDx,
    scrollDy,
    scrolled,
    allowScrollShift,
    partialPlan,
  };
  const skip = queryDomRecordSceneSkipResult(context);
  if (skip) return { kind: "response", response: skip };
  return { kind: "ready", context };
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
  const { pageState, paint, rawImages, clientWire, hasClip, clip, omitBg } = context;
  let scene: Uint8Array | null = null;
  let emittedPartial = false;
  let partialClip = context.partialPlan.partialClip;
  const extraPatches: ScenePatch[] = [];
  try {
    const memory = coreWasmMemory;
    const renderScene = rawImages
      ? (...args: Parameters<typeof paint.renderSceneRaw>) =>
          renderSceneRawPooled(paint, memory, ...args)
      : paint.renderScene.bind(paint);
    const renderClip = (rawImages ? paint.renderSceneClipRaw : paint.renderSceneClip).bind(paint);
    if (context.partialPlan.scrollClips.length > 0 && !hasClip) {
      const scrollPatchSet = renderScrollScenePatches(
        renderClip,
        context.partialPlan.scrollClips,
        state.scrollX,
        state.scrollY,
        clientWire,
      );
      scene = scrollPatchSet.scene;
      partialClip = scrollPatchSet.partialClip;
      extraPatches.push(...scrollPatchSet.patches);
      emittedPartial = true;
    } else if (partialClip && !hasClip) {
      scene = renderClip(
        partialClip.x,
        partialClip.y,
        Math.min(MAX_SCENE_CLIP_DIMENSION_PX, partialClip.w),
        Math.min(MAX_SCENE_CLIP_DIMENSION_PX, partialClip.h),
        false,
        clientWire,
      );
      emittedPartial = true;
    } else {
      scene = clip
        ? renderClip(
            Math.floor(clip.x),
            Math.floor(clip.y),
            Math.min(MAX_SCENE_CLIP_DIMENSION_PX, Math.ceil(clip.width)),
            Math.min(MAX_SCENE_CLIP_DIMENSION_PX, Math.ceil(clip.height)),
            omitBg,
            clientWire,
          )
        : renderScene(state.scrollX, state.scrollY, 0, 0, omitBg, clientWire);
    }
  } catch (e) {
    invalidatePaintDom();
    reportEngineError("wasm", e, "renderScene threw");
    let fallbackHtml = "";
    try {
      fallbackHtml = pageState.dom.outerHTML(0) || "";
    } catch {}
    return {
      kind: "response",
      response: {
        scene: new Uint8Array(0),
        seq: getInternalState().mutationSeq | 0,
        error: errorMessage(e),
        fallbackHtml,
        scrollX: state.scrollX,
        scrollY: state.scrollY,
      } satisfies QueryDomResult<"recordScene">,
    };
  }
  if (!scene || scene.length === 0) {
    invalidatePaintDom();
    reportEngineError("wasm", new Error("renderScene returned empty"));
    let fallbackHtml = "";
    try {
      fallbackHtml = pageState.dom.outerHTML(0) || "";
    } catch {}
    return {
      kind: "response",
      response: {
        scene: new Uint8Array(0),
        seq: getInternalState().mutationSeq | 0,
        error: "renderScene returned empty",
        fallbackHtml,
        scrollX: state.scrollX,
        scrollY: state.scrollY,
      } satisfies QueryDomResult<"recordScene">,
    };
  }
  return { kind: "rendered", scene, emittedPartial, partialClip, extraPatches };
}

function finishQueryDomRecordScene(
  context: QueryDomRecordSceneContext,
  rendered: Extract<QueryDomRecordSceneRender, { kind: "rendered" }>,
): QueryDomResult<"recordScene"> {
  const { internalState, paint } = context;
  const { scene } = rendered;
  const { inkIds, inkNow, pinnedNow } = context.partialPlan;
  const { allowPartial, allowScrollShift, scrolled } = context;
  const outSeq = getInternalState().mutationSeq | 0;
  internalState.damageNodes.clear();
  internalState.layoutDirtySinceRecord = false;
  internalState.lastRecordSeq = outSeq;
  for (const id of inkIds) {
    if (inkRects.size >= MAX_TRACKED_INK_RECTS) break;
    if (!inkRects.has(id)) inkRects.set(id, []);
  }
  for (const id of inkRects.keys()) {
    const rect = inkNow.get(id) ?? readInkRect(paint, id);
    if (rect) inkRects.set(id, rect);
    else inkRects.delete(id);
  }
  pinnedAtRecord =
    allowPartial && allowScrollShift && scrolled
      ? (pinnedNow ?? readPinnedRects(paint))
      : undefined;
  state.lastRecordScrollX = state.scrollX;
  state.lastRecordScrollY = state.scrollY;
  state.lastRecordViewportW = state.paintViewportW;
  state.lastRecordViewportH = state.paintViewportH;
  recheckIntersectionObservers("layout");
  const resourceBatch = inlineQueryDomSceneResources(context, scene);
  return queryDomRecordSceneResponse(context, rendered, outSeq, resourceBatch);
}

function inlineQueryDomSceneResources(
  context: QueryDomRecordSceneContext,
  scene: Uint8Array,
): Uint8Array | null {
  const { queryArgs, paint } = context;
  let resourceBatch: Uint8Array | null = null;
  const inlineResources = queryArgs.inlineResources === true;
  if (inlineResources && typeof paint.renderSceneInlineResources === "function") {
    try {
      const inlineResourceBatch = paint.renderSceneInlineResources(
        scene,
        resourceHashes(queryArgs.haveImages),
        resourceHashes(queryArgs.haveFonts),
      );
      const INLINE_RESOURCE_CAP = 4 * 1024 * 1024;
      if (
        inlineResourceBatch &&
        inlineResourceBatch.length > 0 &&
        inlineResourceBatch.length <= INLINE_RESOURCE_CAP
      ) {
        resourceBatch = inlineResourceBatch;
      }
    } catch {}
  }
  return resourceBatch;
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
    clip: emittedPartial ? partialClip : null,
    shift: emittedPartial && scrolled ? { x: -scrollDx, y: -scrollDy } : undefined,
    patches: extraPatches.length > 0 ? extraPatches : undefined,
    baseSeq: emittedPartial ? baseSeq : -1,
    scrollX: state.scrollX,
    scrollY: state.scrollY,
    damageCount: epochDamageSize,
    layoutDirty: epochLayoutDirty,
    skipReason: emittedPartial ? "" : skipReason,
  } satisfies QueryDomResult<"recordScene">;
}

async function queryDomGetFontUrlData(
  queryArgs: Record<string, unknown>,
): Promise<QueryDomResult<"getFontUrlData">> {
  const url = String(queryArgs.url || "") || fontUrlForKey(String(queryArgs.key || ""));
  if (!url) return { bytes: null, error: "no url" } satisfies QueryDomResult<"getFontUrlData">;
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
  const DEFAULT_PDF_PAPER_WIDTH_CSS_PX = 816;
  const DEFAULT_PDF_PAPER_HEIGHT_CSS_PX = 1056;
  const pdfW =
    queryArgs && typeof queryArgs.width === "number" && queryArgs.width > 0
      ? queryArgs.width | 0
      : DEFAULT_PDF_PAPER_WIDTH_CSS_PX;
  const pdfH =
    queryArgs && typeof queryArgs.height === "number" && queryArgs.height > 0
      ? queryArgs.height | 0
      : DEFAULT_PDF_PAPER_HEIGHT_CSS_PX;
  const readPx = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  const { paint, fresh: isFreshPaint } = takePaintPrep();
  if (!paint) {
    return {
      envelope: new Uint8Array(0),
      error: "ensurePaintDom returned null",
    } satisfies QueryDomResult<"recordPdfScenes">;
  }
  prepareCachedPaint(paint, isFreshPaint, cascadeSeq, cascadeSeq);
  try {
    if (typeof paint.recordPdfScenes !== "function") {
      return {
        envelope: new Uint8Array(0),
        error: "recordPdfScenes not exported",
      } satisfies QueryDomResult<"recordPdfScenes">;
    }
    const envelope = paint.recordPdfScenes(
      pdfW,
      pdfH,
      readPx(queryArgs.marginTop),
      readPx(queryArgs.marginRight),
      readPx(queryArgs.marginBottom),
      readPx(queryArgs.marginLeft),
    );
    if (!envelope || envelope.length === 0) {
      return {
        envelope: new Uint8Array(0),
        error: "empty pdf scene envelope",
      } satisfies QueryDomResult<"recordPdfScenes">;
    }
    return { envelope } satisfies QueryDomResult<"recordPdfScenes">;
  } catch (e) {
    invalidatePaintDom();
    return {
      envelope: new Uint8Array(0),
      error: errorMessage(e),
    } satisfies QueryDomResult<"recordPdfScenes">;
  }
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
    case "getComputedStyle": {
      const id = numericNodeId(queryArgs);
      if (id == null) return { computedStyle: [] } satisfies QueryDomResult<"getComputedStyle">;
      const props = computedStyleForAuthId(id);
      return {
        computedStyle: (props ?? []).map(({ name, value }) => ({ name, value })),
      } satisfies QueryDomResult<"getComputedStyle">;
    }
    case "getRect": {
      const id = numericNodeId(queryArgs);
      if (id == null) return { rect: null } satisfies QueryDomResult<"getRect">;
      const paint = ensurePaintDom();
      if (!paint) return { rect: null } satisfies QueryDomResult<"getRect">;
      try {
        const range: unknown = paint.getBoundingClientRect(id);
        if (!isWasmBoundingRect(range)) {
          return { rect: null } satisfies QueryDomResult<"getRect">;
        }
        return {
          rect: {
            ...range,
            x: (Number(range.x) || 0) - state.scrollX,
            y: (Number(range.y) || 0) - state.scrollY,
          },
        } satisfies QueryDomResult<"getRect">;
      } catch {
        invalidatePaintDom();
        return { rect: null } satisfies QueryDomResult<"getRect">;
      }
    }
    case "elementFromPoint": {
      const clientX = queryArgs && typeof queryArgs.x === "number" ? queryArgs.x : 0;
      const clientY = queryArgs && typeof queryArgs.y === "number" ? queryArgs.y : 0;
      const paint = ensurePaintDom();
      if (!paint) return { nodeId: -1 } satisfies QueryDomResult<"elementFromPoint">;
      try {
        const id = paint.elementFromPoint(clientX + state.scrollX, clientY + state.scrollY);
        return {
          nodeId: typeof id === "number" && id >= 0 ? id : -1,
        } satisfies QueryDomResult<"elementFromPoint">;
      } catch {
        invalidatePaintDom();
        return { nodeId: -1 } satisfies QueryDomResult<"elementFromPoint">;
      }
    }
  }
}

async function queryDomNotRenderedNodeIds(
  queryArgs: Record<string, unknown>,
): Promise<QueryDomResult<"notRenderedNodeIds">> {
  await awaitDeferredFonts();
  const paint = ensurePaintDom();
  if (!paint)
    return { displayNone: [], invisible: [] } satisfies QueryDomResult<"notRenderedNodeIds">;
  try {
    const before = getInternalState().mutationSeq | 0;
    // Call through DomHandle rather than asserting a local method shape.
    const renderStatus: unknown = paint.notRenderedNodeIds();
    const displayNone =
      isObjectRecord(renderStatus) && isNumberArray(renderStatus.displayNone)
        ? renderStatus.displayNone
        : [];
    const invisible =
      isObjectRecord(renderStatus) && isNumberArray(renderStatus.invisible)
        ? renderStatus.invisible
        : [];
    return {
      displayNone: Array.from(displayNone),
      invisible: Array.from(invisible),
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

function queryDomSetViewport(
  pageState: QueryDomActiveState,
  queryArgs: Record<string, unknown>,
): QueryDomResult<"setViewport"> {
  const viewportWidth =
    queryArgs && typeof queryArgs.width === "number"
      ? Math.max(1, Math.floor(queryArgs.width))
      : DEFAULT_VIEWPORT_WIDTH_PX;
  const viewportHeight =
    queryArgs && typeof queryArgs.height === "number"
      ? Math.max(1, Math.floor(queryArgs.height))
      : DEFAULT_VIEWPORT_HEIGHT_PX;
  const dimsChanged =
    state.paintViewportW !== viewportWidth || state.paintViewportH !== viewportHeight;
  state.paintViewportW = viewportWidth;
  state.paintViewportH = viewportHeight;
  if (dimsChanged) {
    try {
      const internalState = getInternalState();
      internalState.mutationSeq = (internalState.mutationSeq | 0) + 1;
    } catch {}
  }
  try {
    const internalState = getInternalState();
    internalState.viewportW = viewportWidth;
    internalState.viewportH = viewportHeight;
  } catch {}
  try {
    pageState.dom.setViewport(viewportWidth, viewportHeight);
    setScrollOffset(state.scrollX, state.scrollY);
    return {
      ok: true,
      width: viewportWidth,
      height: viewportHeight,
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
  const mediaType = queryArgs && typeof queryArgs.media === "string" ? queryArgs.media : "";
  const normalised = mediaType === "print" ? "print" : "screen";
  const changed = state.currentMediaType !== normalised;
  const quiet = !!(queryArgs && queryArgs.quiet);
  try {
    pageState.dom.setMediaType(mediaType);
    if (state.paintCacheHandle) {
      try {
        state.paintCacheHandle.setMediaType(mediaType);
      } catch {}
    }
    state.currentMediaType = normalised;
    if (changed && !quiet) {
      try {
        const internalState = getInternalState();
        internalState.mutationSeq = (internalState.mutationSeq | 0) + 1;
      } catch {}
    }
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

function queryDomSetSuppressBackgrounds(
  queryArgs: Record<string, unknown>,
): QueryDomResult<"setSuppressBackgrounds"> {
  const enabled = !!(queryArgs && queryArgs.enabled);
  const SUPPRESS_BACKGROUND_STYLE_ID = "__ks_no_bg";
  try {
    const doc = state.document as any;
    if (!doc)
      return {
        ok: false,
        error: "no document",
      } satisfies QueryDomResult<"setSuppressBackgrounds">;
    const existing =
      typeof doc.getElementById === "function"
        ? doc.getElementById(SUPPRESS_BACKGROUND_STYLE_ID)
        : null;
    if (enabled) {
      if (existing)
        return {
          ok: true,
          changed: false,
        } satisfies QueryDomResult<"setSuppressBackgrounds">;
      const style = doc.createElement("style");
      style.id = SUPPRESS_BACKGROUND_STYLE_ID;
      style.textContent =
        "*,*::before,*::after{" +
        "background-color:transparent !important;" +
        "background-image:none !important;" +
        "}";
      const head = doc.head || doc.getElementsByTagName?.("head")?.[0];
      if (!head)
        return {
          ok: false,
          error: "no <head>",
        } satisfies QueryDomResult<"setSuppressBackgrounds">;
      head.appendChild(style);
      return { ok: true, changed: true } satisfies QueryDomResult<"setSuppressBackgrounds">;
    } else {
      if (!existing)
        return {
          ok: true,
          changed: false,
        } satisfies QueryDomResult<"setSuppressBackgrounds">;
      try {
        existing.parentNode?.removeChild(existing);
      } catch (e) {
        return {
          ok: false,
          error: String((e as any)?.message || e),
        } satisfies QueryDomResult<"setSuppressBackgrounds">;
      }
      return { ok: true, changed: true } satisfies QueryDomResult<"setSuppressBackgrounds">;
    }
  } catch (e) {
    return {
      ok: false,
      error: String((e as any)?.message || e),
    } satisfies QueryDomResult<"setSuppressBackgrounds">;
  }
}

async function queryDomAwaitPendingResources(
  pageState: QueryDomActiveState,
  queryArgs: Record<string, unknown>,
): Promise<QueryDomResult<"awaitPendingResources">> {
  const DEFAULT_PENDING_RESOURCE_TIMEOUT_MS = 15000;
  const timeoutMs =
    queryArgs && typeof queryArgs.timeoutMs === "number" && queryArgs.timeoutMs > 0
      ? queryArgs.timeoutMs
      : DEFAULT_PENDING_RESOURCE_TIMEOUT_MS;
  const drainStartedAt = Date.now();
  const deadline = drainStartedAt + timeoutMs;

  if (queryArgs && queryArgs.upgradeFonts === true) {
    try {
      upgradeToFullFonts();
    } catch {}
  }

  if (pageState.dom) demandFacesForScriptText(pageState.dom);
  const emoji = emojiPendingPromise();
  const cjk = cjkPendingPromise();
  const upgrade = upgradePendingPromise();
  const fontPromises: Promise<void>[] = [];
  if (emoji) fontPromises.push(emoji.catch(() => {}));
  if (cjk) fontPromises.push(cjk.catch(() => {}));
  for (const promise of scriptPendingPromises()) {
    fontPromises.push(promise.catch(() => {}));
  }
  if (upgrade) fontPromises.push(upgrade.catch(() => {}));
  let fontsTimedOut = false;
  const fontsDone =
    fontPromises.length === 0
      ? NativePromise.resolve()
      : NativePromise.race([
          NativePromise.all(fontPromises).then(() => {}),
          nativeSleep(timeoutMs).then(() => {
            fontsTimedOut = true;
          }),
        ]);

  if (fontPromises.length > 0) await fontsDone;
  const fontsMs = Date.now() - drainStartedAt;

  const scopeArg =
    queryArgs && typeof queryArgs.scope === "object"
      ? (queryArgs.scope as QueryDomArgs<"awaitPendingResources">["scope"])
      : null;
  const captureRect = (() => {
    if (!scopeArg) return null;
    if (scopeArg.mode === "viewport") {
      return {
        x: state.scrollX,
        y: state.scrollY,
        w: state.paintViewportW,
        h: state.paintViewportH,
      };
    }
    if (scopeArg.mode === "rect") {
      return {
        x: Number(scopeArg.x) || 0,
        y: Number(scopeArg.y) || 0,
        w: Number(scopeArg.w) || 0,
        h: Number(scopeArg.h) || 0,
      };
    }
    return null;
  })();

  const images = await drainPendingImages(pageState, captureRect, deadline, drainStartedAt);
  if (fontPromises.length > 0) {
    console.log(
      `[kitesurf-fonts] pre-render font drain settled in ` +
        `${fontsMs}ms (emoji=${!!emoji} cjk=${!!cjk} ` +
        `upgrade=${!!upgrade} timedOut=${fontsTimedOut})`,
    );
  }
  return {
    ok: true,
    waited: images.waited === true || fontPromises.length > 0,
    timedOut: images.timedOut === true || fontsTimedOut,
    fontsMs,
    fontsTimedOut,
    fonts: { emoji: !!emoji, cjk: !!cjk, upgrade: !!upgrade },
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
  try {
    ensurePaintDom();
  } catch {}
  const MIN_RESOLVE_GAP_MS = 250;
  const MAX_IMAGE_DRAIN_ITERATION_SAMPLES = 40;
  const IMAGE_DRAIN_POLL_INTERVAL_MS = 25;
  let waited = false;
  let pending = 0;
  let resolves = 0;
  let iterations = 0;
  let lastResolveSheetSeq = -1;
  let lastResolveAt = 0;
  const iterTimes: number[] = [];
  while (true) {
    iterations++;
    if (iterTimes.length < MAX_IMAGE_DRAIN_ITERATION_SAMPLES) {
      iterTimes.push(Date.now() - drainStartedAt);
    }
    const sheetSeq = getStylesheetDeliverySeq();
    const wantResolve =
      resolves === 0 ||
      (sheetSeq !== lastResolveSheetSeq && Date.now() - lastResolveAt >= MIN_RESOLVE_GAP_MS);
    if (wantResolve && (resolves === 0 || Date.now() < deadline)) {
      lastResolveSheetSeq = sheetSeq;
      lastResolveAt = Date.now();
      resolves++;
      try {
        pending = dom.discoverPendingImages() | 0;
      } catch {
        pending = 0;
      }
    } else {
      pending = readPendingImageCount(dom);
    }
    if (captureRect) {
      if (countRelevantInflightImages(scope) === 0) break;
    } else if (pending === 0 && resourceInflight.size === 0) {
      break;
    }
    if (Date.now() >= deadline) {
      return reportPendingImageDrainTimeout({
        drainStartedAt,
        waited,
        pending,
        resolves,
        iterations,
        iterTimes,
      });
    }
    waited = true;
    await nativeSleep(IMAGE_DRAIN_POLL_INTERVAL_MS);
  }
  return {
    waited,
    timedOut: false,
    ms: Date.now() - drainStartedAt,
    pending: 0,
    inflight: 0,
    resolves,
    iterations,
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
  let relevantCount = 0;
  for (const url of resourceInflight) {
    if (!isImageInflight(url)) relevantCount++;
  }
  if (relevantCount > 0 || !scope.captureRect) return relevantCount;
  const seqNow = cascadeSeq() | 0;
  if (seqNow !== scope.rectVerdictSeq) {
    scope.rectVerdicts.clear();
    scope.rectVerdictSeq = seqNow;
  }
  for (const url of imageInflightUrls()) {
    const cached = scope.rectVerdicts.get(url);
    if (cached !== undefined) {
      if (cached) relevantCount++;
      continue;
    }
    const { known, hits } = imageUrlCaptureRelevance(scope.dom, url, scope.captureRect);
    const relevant = hits || !known;
    scope.rectVerdicts.set(url, relevant);
    if (relevant) relevantCount++;
  }
  return relevantCount;
}

function imageUrlCaptureRelevance(
  dom: PendingImageDom,
  url: string,
  captureRect: PendingImageCaptureRect,
): { known: boolean; hits: boolean } {
  let known = false;
  let hits = false;
  try {
    const ids = dom.pendingImageNodes ? Array.from(dom.pendingImageNodes(url)) : [];
    for (const id of ids) {
      const range = dom.getBoundingClientRect ? dom.getBoundingClientRect(id) : null;
      if (!range) continue;
      known = true;
      const rectX = Number(range.x) || 0;
      const rectY = Number(range.y) || 0;
      const width = Number(range.width) || 0;
      const height = Number(range.height) || 0;
      if (
        rectX < captureRect.x + captureRect.w &&
        rectX + width > captureRect.x &&
        rectY < captureRect.y + captureRect.h &&
        rectY + height > captureRect.y
      ) {
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
    case "pageBoxJson": {
      try {
        const json = pageState.dom.pageBoxJson();
        return { ok: true, json } satisfies QueryDomResult<"pageBoxJson">;
      } catch (e) {
        return {
          ok: false,
          error: String((e && (e as Error).message) || e),
        } satisfies QueryDomResult<"pageBoxJson">;
      }
    }
    case "setLayoutMode": {
      const mode = queryArgs && typeof queryArgs.mode === "string" ? queryArgs.mode : "full";
      try {
        if (typeof pageState.dom.setLayoutMode === "function") {
          pageState.dom.setLayoutMode(mode);
          return {
            ok: true,
            mode: pageState.dom.layoutMode ? pageState.dom.layoutMode() : mode,
          } satisfies QueryDomResult<"setLayoutMode">;
        }
        return {
          ok: false,
          error: "setLayoutMode unsupported in this wasm build",
        } satisfies QueryDomResult<"setLayoutMode">;
      } catch (e) {
        return {
          ok: false,
          error: String((e && (e as Error).message) || e),
        } satisfies QueryDomResult<"setLayoutMode">;
      }
    }
    case "getLayoutMode": {
      try {
        return {
          mode: pageState.dom.layoutMode ? pageState.dom.layoutMode() : "full",
        } satisfies QueryDomResult<"getLayoutMode">;
      } catch {
        return { mode: "full" } satisfies QueryDomResult<"getLayoutMode">;
      }
    }
    case "setCdpDomActive": {
      try {
        ksGlobal.__ks_cdpDomActive = !!(queryArgs && queryArgs.active);
      } catch {}
      return { ok: true } satisfies QueryDomResult<"setCdpDomActive">;
    }
  }
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
    case "describeNode": {
      const id = numericNodeId(queryArgs);
      if (id == null) {
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
      try {
        const info = pageState.dom.nodeInfo(id);
        if (info && typeof info === "object") delete info.attributeNamespaces;
        return { node: { ...info, backendNodeId: id } } satisfies QueryDomResult<"describeNode">;
      } catch {
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
    }
    case "resolveNode": {
      const id = numericNodeId(queryArgs);
      if (id == null) return {} satisfies QueryDomResult<"resolveNode">;
      const element = state.resolveNodeId(id);
      if (!element) return {} satisfies QueryDomResult<"resolveNode">;
      const objectId = mintHandle(element);
      return {
        object: {
          type: "object",
          subtype: "node",
          className: "Element",
          description: "Element",
          objectId,
        },
      } satisfies QueryDomResult<"resolveNode">;
    }
    case "getAttributes": {
      const id = numericNodeId(queryArgs);
      if (id == null) return { attributes: [] } satisfies QueryDomResult<"getAttributes">;
      try {
        const info: unknown = pageState.dom.nodeInfo(id);
        const attributes = isObjectRecord(info) ? info.attributes : undefined;
        return {
          attributes: isStringArray(attributes) ? attributes : [],
        } satisfies QueryDomResult<"getAttributes">;
      } catch {
        return { attributes: [] } satisfies QueryDomResult<"getAttributes">;
      }
    }
    case "focus": {
      const id = numericNodeId(queryArgs);
      if (id == null) return {} satisfies QueryDomResult<"focus">;
      const element = state.resolveNodeId(id);
      if (!element || typeof element.focus !== "function")
        return {} satisfies QueryDomResult<"focus">;
      try {
        element.focus();
      } catch {}
      return {} satisfies QueryDomResult<"focus">;
    }
  }
}

function queryDomPageState(): QueryDomResult<"getPageState"> {
  let href = "";
  let title = "";
  try {
    href = String(ksGlobal.location?.href ?? "");
  } catch {}
  try {
    title = String(ksGlobal.document?.title ?? "");
  } catch {}
  return {
    seq: getInternalState().mutationSeq | 0,
    scrollX: state.scrollX,
    scrollY: state.scrollY,
    href,
    title,
  } satisfies QueryDomResult<"getPageState">;
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
    case "formStateSnapshot": {
      // A partial snapshot is incomplete if any control could not be resolved or read.
      const before = getInternalState().mutationSeq | 0;
      let complete = true;
      const values: Array<[number, string]> = [];
      const checked: Array<[number, boolean]> = [];
      const selected: Array<[number, boolean]> = [];
      let ids: number[] = [];
      try {
        ids = Array.from(pageState.dom.querySelectorAll("input,textarea,select")).filter(
          (n): n is number => typeof n === "number" && n >= 0,
        );
      } catch {
        complete = false;
      }
      for (const id of ids)
        complete = collectFormControlState(id, values, checked, selected) && complete;
      return {
        values,
        checked,
        selected,
        ...(queryArgs.includeReadStamp === true
          ? {
              readStamp: {
                before,
                after: getInternalState().mutationSeq | 0,
                complete,
              },
            }
          : {}),
      } satisfies QueryDomResult<"formStateSnapshot">;
    }
    case "setControlValueAsUser": {
      const id = numericNodeId(queryArgs);
      if (id == null)
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
      let value = "";
      try {
        value = String(element.value ?? "");
      } catch {}
      return { ...result, value } satisfies QueryDomResult<"setControlValueAsUser">;
    }
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
    if (method === "markPaintDamage") {
      paint.paintDamageMark?.();
      return {};
    }
    const raw = String(paint.paintDamageSince?.(numericNodeId(queryArgs) ?? 0) ?? "");
    return raw ? JSON.parse(raw) : {};
  } catch {
    invalidatePaintDom();
    return {};
  }
}

function queryDomMemoryStats(): QueryDomResult<"getMemoryStats"> {
  const bytes = getCoreWasmMemoryBytes();
  const initialBytes = getCoreWasmMemoryInitialBytes();
  let bridge = null;
  try {
    bridge = { ...JSON.parse(ks_bridge_pins()), ...JSON.parse(ks_cycle_stats()) };
  } catch {
    bridge = null;
  }
  let domFastpath = null;
  try {
    domFastpath = JSON.parse(state.dom?.fastpathStats?.() ?? "null");
  } catch {
    domFastpath = null;
  }
  let domNodes: number | null = null;
  try {
    domNodes = state.dom?.nodeCount?.() ?? null;
  } catch {
    domNodes = null;
  }
  return {
    bytes,
    initialBytes,
    deltaBytes: Math.max(0, bytes - initialBytes),
    bridge,
    domFastpath,
    domNodes,
    wrappers: detachedWrapperStats(),
    paint: paintPrepStats(),
    intersectionObserver: intersectionObserverStats(),
    timerWheel: { ...timerWheelStats(), shim: deferShimStats() },
  } satisfies QueryDomResult<"getMemoryStats">;
}

type QueryDomDiagnosticsMethod = Extract<
  QueryDomMethod,
  "boaForceCollect" | "getFontFaces" | "getMemprofDump" | "resetMemprof"
>;

function queryDomDiagnostics(
  method: QueryDomDiagnosticsMethod,
): QueryDomResult<QueryDomDiagnosticsMethod> {
  switch (method) {
    case "boaForceCollect": {
      try {
        const collected = JSON.parse(ks_boa_force_collect());
        ks_cycle_collect(false);
        return collected satisfies QueryDomResult<"boaForceCollect">;
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
        } satisfies QueryDomResult<"boaForceCollect">;
      }
    }
    case "getFontFaces": {
      try {
        return { json: font_families_json() } satisfies QueryDomResult<"getFontFaces">;
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
        } satisfies QueryDomResult<"getFontFaces">;
      }
    }
    case "getMemprofDump": {
      const dump = ksGlobal.__memprof_dump;
      if (typeof dump !== "function") {
        return {
          error: "memprof recorder not installed (build with KITESURF_MEMPROF=1)",
        } satisfies QueryDomResult<"getMemprofDump">;
      }
      try {
        return { json: dump() } satisfies QueryDomResult<"getMemprofDump">;
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
        } satisfies QueryDomResult<"getMemprofDump">;
      }
    }
    case "resetMemprof": {
      const reset = ksGlobal.__memprof_reset;
      if (typeof reset !== "function") {
        return {
          error: "memprof recorder not installed (build with KITESURF_MEMPROF=1)",
        } satisfies QueryDomResult<"resetMemprof">;
      }
      try {
        reset();
        return { ok: true } satisfies QueryDomResult<"resetMemprof">;
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
        } satisfies QueryDomResult<"resetMemprof">;
      }
    }
  }
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

  const body = raw.slice("<!doctype".length, -1).trim();
  const parsed = body.match(
    /^([^\s>]+)(?:\s+(PUBLIC|SYSTEM)\s+(?:"([^"]*)"|'([^']*)')(?:\s+(?:"([^"]*)"|'([^']*)'))?)?$/i,
  );
  if (!parsed) return { markup: raw, end };

  const name = parsed[1]?.toLowerCase() ?? "html";
  const keyword = parsed[2]?.toUpperCase();
  const firstId = parsed[3] ?? parsed[4];
  const secondId = parsed[5] ?? parsed[6];
  const quote = (value: string) => (value.includes('"') ? `'${value}'` : `"${value}"`);
  if (keyword === "PUBLIC" && firstId !== undefined) {
    const system = secondId === undefined ? "" : ` ${quote(secondId)}`;
    return {
      markup: `<!DOCTYPE ${name} PUBLIC ${quote(firstId)}${system}>`,
      end,
    };
  }
  if (keyword === "SYSTEM" && firstId !== undefined) {
    return {
      markup: `<!DOCTYPE ${name} SYSTEM ${quote(firstId)}>`,
      end,
    };
  }
  return { markup: `<!DOCTYPE ${name}>`, end };
}

function numericNodeId(params: Record<string, unknown>): number | null {
  if (typeof params.nodeId === "number") return params.nodeId;
  if (typeof params.backendNodeId === "number") return params.backendNodeId;
  if (typeof params.objectId === "string") {
    if (params.objectId.startsWith("node:")) {
      const nodeId = Number(params.objectId.slice(5));
      return Number.isFinite(nodeId) ? nodeId : null;
    }
    if (params.objectId.startsWith("ps:")) {
      const nodeObject: unknown = lookupHandle(params.objectId);
      if (
        nodeObject !== null &&
        (typeof nodeObject === "object" || typeof nodeObject === "function")
      ) {
        const nodeId: unknown = Reflect.get(nodeObject, "_id");
        if (typeof nodeId === "number") return nodeId;
      }
    }
  }
  return null;
}

export default {
  fetch(): Response {
    return new Response("PageScript", { status: 404 });
  },
};
