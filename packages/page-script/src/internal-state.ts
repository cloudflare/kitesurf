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

export function createInternalState(): KitesurfInternalState {
  let mutationSeq = 0;
  return {
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

export function getInternalState(): KitesurfInternalState {
  return _state;
}

export function takeDocumentReopened(): boolean {
  const v = _state.documentReopened;
  _state.documentReopened = false;
  return v;
}
