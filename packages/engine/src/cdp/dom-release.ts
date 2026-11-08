// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Releases wasm DOM handles for frames and targets without importing the core module.

import type { FrameState, TargetState } from "./types.ts";
import type { DomHandle } from "../wasm.ts";

// wasm.ts registers the factory so this widely imported release path stays wasm-free.
let domFactory: ((html: string, baseUrl: string) => DomHandle) | null = null;
export function setDomFactory(fn: (html: string, baseUrl: string) => DomHandle): void {
  domFactory = fn;
}

export function freeDetachedDom(
  dom: DomHandle,
  tag: string,
  detail: Record<string, unknown>,
): void {
  try {
    dom.free();
  } catch (err) {
    console.warn(
      `${tag} ` +
        JSON.stringify({
          ...detail,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        }),
    );
  }
}

export function releaseFrameDom(frame: FrameState): void {
  // The srcdoc parse input can be large and is never read again once the frame's DOM is released.
  frame.srcdoc = null;
  const dom = frame.dom;
  if (!dom) return;
  frame.dom = null;
  const charged = frame.domBytes;
  if (charged && frame.domBudget) {
    frame.domBudget.bytes -= charged;
    frame.domBytes = undefined;
  }
  freeDetachedDom(dom, "[kitesurf-iframe]", {
    event: "frame_dom_free_failed",
    frameId: frame.frameId,
    url: frame.url,
    detached: frame.detached,
  });
}

export function releaseTargetDom(target: TargetState): void {
  const dom = target.dom;
  // Advance even when empty; a screenshot may still hold the previous handle.
  target.domEpoch += 1;
  if (!dom) return;
  target.dom = null;
  freeDetachedDom(dom, "[kitesurf-target]", {
    event: "target_dom_free_failed",
    targetId: target.targetId,
    url: target.url,
  });
}

export function releaseAllDomHandles(target: TargetState): void {
  for (const frame of target.frames.values()) releaseFrameDom(frame);
  releaseTargetDom(target);
}

// The engine keeps the source only to rehydrate a fallback DOM when PageScript is absent. A
// large document's source is a second full copy of the page, so keep the fallback for small
// pages and let PageScript own the document once it is live. Releasing it means a target whose
// PageScript later retires (a screencast render failure) has only the synthetic blank document
// for DOM, CSS and accessibility fallbacks.
export const MAX_RETAINED_FALLBACK_HTML_CHARS = 1 << 20;

export function releaseFallbackHtml(target: TargetState): void {
  if (target.html.length > MAX_RETAINED_FALLBACK_HTML_CHARS) {
    target.html = "";
    target.fallbackHtmlReleased = true;
  }
}

export function stripNoscript(dom: DomHandle): void {
  let ids: Int32Array;
  try {
    ids = dom.querySelectorAll("noscript");
  } catch {
    return;
  }
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i];
    if (id === undefined || id < 0) continue;
    try {
      dom.removeNode(id);
    } catch {}
  }
}

export function ensureTargetDom(target: TargetState): DomHandle | null {
  if (target.dom) return target.dom;
  if (!target.html || !domFactory) return null;
  try {
    const dom = domFactory(
      target.html,
      target.url && /^https?:/.test(target.url) ? target.url : "https://kitesurf.local/",
    );
    stripNoscript(dom);
    target.dom = dom;
    return dom;
  } catch (err) {
    console.warn(
      "[kitesurf-target] dom_rehydrate_failed " +
        JSON.stringify({
          targetId: target.targetId,
          url: target.url,
          message: err instanceof Error ? err.message : String(err),
        }),
    );
    return null;
  }
}
