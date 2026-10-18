// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Holds the PageScript generation's shared DOM, globals, and lifecycle state.

import type { RawCdpMutation } from "@kitesurf/jsrpc-types/shared";
import type { LoadCompletion } from "@kitesurf/jsrpc-types/page-script";
import type {
  DomHandle,
  ShimDocument,
  ShimElement,
  ShimGlobal,
  ShimNode,
  ShimWindow,
} from "./types.ts";

import { DEFAULT_VIEWPORT_HEIGHT_PX, DEFAULT_VIEWPORT_WIDTH_PX } from "./internal-state.js";
export { DEFAULT_VIEWPORT_HEIGHT_PX, DEFAULT_VIEWPORT_WIDTH_PX };

export interface PageScriptState {
  dom: DomHandle | null;

  blobUrls: Map<string, Blob>;

  pageUrl: string;

  sourceDoctype: { markup: string; marker: string } | null;

  connectionId: string;

  mainFrameId: string;

  cookieKey: string;

  document: ShimDocument | null;
  window: ShimWindow | null;

  lastForceRestyleSeq: number;

  lastRecordScrollX: number;
  lastRecordScrollY: number;
  lastRecordViewportW: number;
  lastRecordViewportH: number;

  currentMediaType: "screen" | "print";

  paintCacheHandle: DomHandle | null;
  paintCacheSeq: number;
  paintCacheFresh: boolean;
  paintCacheViewportW: number;
  paintCacheViewportH: number;
  paintViewportW: number;
  paintViewportH: number;
  scrollX: number;
  scrollY: number;

  getOpLog: () => unknown[];
  setReadyState: (s: string) => void;
  drainCookieWrites: () => string[];
  setCookieString: (s: string) => void;
  resolveNodeId: (id: number) => ShimElement | null;
  getActiveElement: () => ShimElement | null;
  drainCdpMutationsRaw: () => RawCdpMutation[];
  dispatchTrustedEvent: (target: ShimNode, event: unknown) => boolean;
  notifyImageResults: (nodeIds: ArrayLike<number>, ok: boolean) => void;

  notifyStylesheetResults: (url: string, ok: boolean) => void;

  loadCompletion: Promise<LoadCompletion> | null;

  navigateStarted: boolean;

  loadCompletionArmed: Promise<void>;
  settleLoadCompletionArmed: () => void;
}

// This arbitrary-key view is for page shims, not WorkerGlobalScope's event types.
export const ksGlobal = globalThis as ShimGlobal;

export const ksEventCtors: ShimGlobal = {};

let settleArmed: () => void = () => {};
const armedDeferred = new Promise<void>((resolve) => {
  settleArmed = resolve;
});

export const state: PageScriptState = {
  dom: null,
  blobUrls: new Map(),
  pageUrl: "",
  sourceDoctype: null,
  connectionId: "",
  mainFrameId: "",
  cookieKey: "",
  document: null,
  window: null,
  lastForceRestyleSeq: -1,
  lastRecordScrollX: 0,
  lastRecordScrollY: 0,
  lastRecordViewportW: 0,
  lastRecordViewportH: 0,
  currentMediaType: "screen",

  paintCacheHandle: null,
  paintCacheSeq: -1,
  paintCacheFresh: false,
  paintCacheViewportW: 0,
  paintCacheViewportH: 0,
  paintViewportW: DEFAULT_VIEWPORT_WIDTH_PX,
  paintViewportH: DEFAULT_VIEWPORT_HEIGHT_PX,
  scrollX: 0,
  scrollY: 0,

  getOpLog: () => [],
  setReadyState: () => {},
  drainCookieWrites: () => [],
  setCookieString: () => {},
  resolveNodeId: () => null,
  getActiveElement: () => null,
  drainCdpMutationsRaw: () => [],
  dispatchTrustedEvent: (target, event) => target.dispatchEvent(event),
  notifyImageResults: () => {},
  notifyStylesheetResults: () => {},

  loadCompletion: null,

  navigateStarted: false,
  loadCompletionArmed: armedDeferred,
  settleLoadCompletionArmed: () => settleArmed(),
};
