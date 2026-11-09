// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Bundle this sibling once so PageScript and the separate DOM shim share its state.

import type { UpstreamMessage } from "@kitesurf/jsrpc-types/page-script";

export const DEFAULT_VIEWPORT_WIDTH_PX = 1280;
export const DEFAULT_VIEWPORT_HEIGHT_PX = 720;

export type UpstreamSender = (message: UpstreamMessage) => void;

export interface IframePost {
  body: string;
  contentType: string;
}

export interface BundleDiag {
  entered: boolean;
  exited: boolean;
  bodyChars: number;
  entryDom: unknown;
  exitDom: unknown;
}

export interface KitesurfInternalState {
  mutationSeq: number;

  attrSeq: number;
  childSeq: number;

  treeSeq: number;

  lastMutationAt: number;

  paintNeutralSeq: number;

  damageNodes: Set<number>;

  layoutDirtySinceRecord: boolean;

  pendingCanvasPushes: Set<() => void>;

  lastRecordSeq: number;

  styleSheetsDirty: boolean;

  documentReopened: boolean;

  setCurrentScript:
    | ((
        src: string | null | undefined,
        domIndex?: number,
        bodyKey?: string,
        rawSrc?: string,
      ) => void)
    | null;
  currentScriptSrc: string | undefined;
  currentScriptRawSrc?: string | undefined;
  currentScriptDomIndex?: number | undefined;
  currentScriptBodyKey?: string | undefined;

  endClassicScript: (() => Promise<void>) | null;
  // Reports a caught script error to the Runtime.exceptionThrown buffer. The classic bundle
  // catches per script, so this is the only signal a pageerror listener gets.
  pushException:
    | ((err: unknown, opts: { scriptId: string; url: string; text?: string }) => void)
    | null;
  // Fires load (ok) or error at a parser-inserted external classic script. domIndex is its
  // ordinal among the document's <script> elements; rawSrc and src check the match.
  parserScriptLifecycle:
    | ((domIndex: number, rawSrc: string, src: string, ok: boolean) => Promise<void>)
    | null;

  bundleDiag: BundleDiag | null;

  afterIframeInsert: ((iframeEl: unknown) => void) | null;
  afterIframeRemove: ((iframeEl: unknown) => void) | null;

  afterScriptInsert: ((info: unknown) => void) | null;

  afterIframeSrcChange: ((iframeEl: unknown) => void) | null;

  navigateIframe: ((iframeEl: unknown, url: string, post?: IframePost) => void) | null;

  markNative: ((fn: unknown, name: string) => void) | null;

  // A duplicated RPC callback owned and cleared by the retained session.
  upstreamSender: UpstreamSender | null;

  viewportW: number;
  viewportH: number;

  dispatchingUserEvent: boolean;

  pendingSubmitNav: {
    url: string;
    postData?: string;
    postContentType?: string;
  } | null;

  frameContext: { parentOrigin: string } | null;
}

// Screencast and scene-stream loops track their own last-delivered sequence.
const paintWakeAfterSeq = new Map<"screencast" | "scene", number>();

// A null threshold disarms only this consumer.
export function armPaintWake(
  afterSeq: number | null,
  consumer: "screencast" | "scene" = "screencast",
): void {
  if (afterSeq === null) paintWakeAfterSeq.delete(consumer);
  else paintWakeAfterSeq.set(consumer, afterSeq);
}

export function notePaintWake(): void {
  // One paintDirty event wakes every armed consumer, so consume all thresholds together.
  if (paintWakeAfterSeq.size === 0) return;
  paintWakeAfterSeq.clear();
  sendUpstreamEvent({ event: "kitesurf.paintDirty", params: {} });
}

// No prototype: page script can put a setter on Object.prototype, and a write to a field that
// is not an own property yet would call it with this record as its receiver.
export function createInternalState(): KitesurfInternalState {
  let mutationSeq = 0;
  const state: KitesurfInternalState = {
    attrSeq: 0,
    childSeq: 0,
    treeSeq: 0,
    get mutationSeq() {
      return mutationSeq;
    },
    set mutationSeq(v: number) {
      mutationSeq = v;
      for (const afterSeq of paintWakeAfterSeq.values()) {
        if (v > afterSeq) {
          notePaintWake();
          break;
        }
      }
    },
    lastMutationAt: 0,
    paintNeutralSeq: 0,
    damageNodes: new Set<number>(),
    layoutDirtySinceRecord: false,
    pendingCanvasPushes: new Set(),
    lastRecordSeq: -1,
    styleSheetsDirty: false,
    documentReopened: false,
    setCurrentScript: null,
    currentScriptSrc: undefined,
    endClassicScript: null,
    pushException: null,
    parserScriptLifecycle: null,
    bundleDiag: null,
    afterIframeInsert: null,
    afterIframeRemove: null,
    afterScriptInsert: null,
    afterIframeSrcChange: null,
    navigateIframe: null,
    markNative: null,
    upstreamSender: null,
    viewportW: DEFAULT_VIEWPORT_WIDTH_PX,
    viewportH: DEFAULT_VIEWPORT_HEIGHT_PX,
    dispatchingUserEvent: false,
    pendingSubmitNav: null,
    frameContext: null,
  };
  return Object.setPrototypeOf(state, null);
}

export function sendUpstreamEvent(message: UpstreamMessage): void {
  const sender = _state.upstreamSender;
  if (!sender) return;
  try {
    sender(message);
  } catch {
    // The duplicated session callback may already be disposed during teardown.
  }
}

export function registerUpstreamSender(sender: UpstreamSender): void {
  _state.upstreamSender = sender;
}

export function clearUpstreamSender(): void {
  _state.upstreamSender = null;
}

const _state: KitesurfInternalState = createInternalState();

// The hooks dom-shim, page-script and the wasm core call each other through. Declared beside the
// record so both packages type it the same way without importing each other; dom-shim objects are
// `object` here for the same reason as BundleDiag's `unknown`. All optional: each side installs
// its hooks when it loads, and a bare WPT harness never installs page-script's.
export interface KitesurfInternals {
  // Installed by page-script for dom-shim. True while a CDP client has the DOM domain enabled;
  // record.ts and element.ts then queue DOM.* mutation events.
  cdpDomActive?: boolean;
  // Terminal cell size in CSS px, set for TTY targets so wheel scrolls move by whole cells.
  ttyCellWidth?: number;
  ttyCellHeight?: number;
  // Trace parent of the current RPC (the `tp` envelope field).
  traceParent?: string;
  // The highest parent clock sample, in epoch ms. Date.now() can freeze within a turn, so
  // animation time floors to this; the wasm core reads it too.
  clockFloorMs?: number;
  jsSpanEnter?: (op: string, bytes: number, detail: string) => number;
  jsSpanExit?: (slot: number) => void;
  // In lazy font mode, upgrades to the full fonts so text shaped outside layout (canvas, SVG)
  // gets outlines. Null when nothing is pending.
  demandFontOutlines?: () => Promise<void> | null;
  // document.fonts.ready and .status read these.
  fontsReady?: () => Promise<void>;
  fontsInflightCount?: () => number;
  // Registers deferred fonts for canvas measureText. False while bytes are still in flight.
  demandDeferredFonts?: () => boolean;
  // Custom-element registry hooks; page-script owns the registry.
  notifyConnected?: (root: object) => void;
  upgradeCustomElement?: (element: object, tagName: string) => void;
  customElementObservesAttribute?: (element: object, name: string) => boolean;
  notifyCustomElementAttributeChanged?: (
    element: object,
    name: string,
    oldValue: string | null,
    newValue: string | null,
    namespace: string | null,
  ) => void;

  // Installed by dom-shim for page-script. createElementNoUpgrade mints a wrapper with no
  // custom-element upgrade, for page-script's HTMLElement constructor.
  createElementNoUpgrade?: (tag: string) => unknown;
  // The form behind a form's page-facing proxy, whose members no named control overrides.
  formBehindProxy?: <T extends object>(form: T) => T;
  scrollByWheel?: (hitNodeId: number, dx: number, dy: number) => boolean;
  toggleSelectDropdown?: (select: unknown) => boolean;

  // Installed by page-script for the wasm core (core/src/js/internals.rs). Close a small V8
  // function over a boa trampoline shim and its pin handle(s), so a crossing costs no closure.
  wrapBoaFunction?: (call: Function, construct: Function, handle: number) => Function;
  wrapBoaMethod?: (call: Function, fnHandle: number, receiverHandle: number) => Function;
  // A baked module's V8 namespace, so boa reuses it instead of fetching.
  nativeImport?: (url: unknown) => Promise<unknown>;
  // A module body for boa's fetch-and-interpret path, through the script gate.
  // The referrer is the importing module's URL, or the page's for an entry import.
  fetchModuleSource?: (url: unknown, referrer?: unknown) => Promise<string>;
  // Run due page timers while boa awaits; returns how many ran. Installed read-only.
  readonly pumpDueTimers?: (deadlineMs?: number) => number;
  // Ms until the next page timer is due, or Infinity.
  readonly nextTimerDelay?: () => number;

  // Set by tests, benches and the memprof build. domDebug is the live DomHandle, for e2e tests
  // that inspect wasm state directly; canvasPushMs overrides the canvas push backstop, in ms.
  domDebug?: unknown;
  canvasPushMs?: unknown;
  // Installed by the memprof recorder banner.
  memprofImports?: object;
  memprofDump?: () => string;
  memprofReset?: () => void;
}

// The one KitesurfInternals record, with no prototype, so a missing hook reads as undefined. The
// wasm and the e2e tests have no import, so it is also on globalThis under a registered symbol:
// non-enumerable and non-writable. Its fields stay writable for the tests that stub a hook.
const ksInternals: KitesurfInternals = Object.create(null);
Object.defineProperty(globalThis, Symbol.for("kitesurf.internals"), { value: ksInternals });

export function getInternals(): KitesurfInternals {
  return ksInternals;
}

export function getInternalState(): KitesurfInternalState {
  return _state;
}

export function takeDocumentReopened(): boolean {
  const v = _state.documentReopened;
  _state.documentReopened = false;
  return v;
}
