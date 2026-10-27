// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Converts image and stylesheet resource results into DOM load and error events.

import { dom, pageUrl, elementFor, liveDocument } from "../state.js";
import { linkLoadFired } from "../registries.js";
import { KsEvent } from "../events/event.js";
import { installAttrEventHandler } from "./event-handlers.js";
import type { Element } from "./element.js";
import type { HTMLImageElement } from "./image.js";
import { isElementWrapper } from "./html-tag.js";
import type * as Idl from "../idl/types.generated.js";

// PageScript reports fetched image results here. Cache hits bypass that path,
// so this module also queues events for loads that finish during a flush.

// Terminal image state, keyed by wasm node ID.
const imageLoadResults = new Map<number, boolean>();

// An image stays incomplete after src/srcset changes until its new request settles.
const pendingImageReloads = new Set<number>();

// Advancing on every src/srcset write rejects queued results from older requests.
const imageRequestGen = new Map<number, number>();
function bumpImageRequestGen(id: number) {
  const next = (imageRequestGen.get(id) || 0) + 1;
  imageRequestGen.set(id, next);
  return next;
}

function queueImageTerminalEvent(id: number, gen: number, pumpDecodes = false) {
  try {
    setTimeout(() => {
      if (imageRequestGen.get(id) !== gen) return;
      if (pumpDecodes) {
        try {
          dom.pumpResourceMessages();
        } catch {}
      }
      try {
        notifyImageResults([id], true);
      } catch {}
    }, 0);
  } catch {}
}

function resolveImageUrl(raw: string, el: Element) {
  try {
    return new URL(raw, el.baseURI || pageUrl).href;
  } catch {
    return null;
  }
}
function isFetchableImageUrl(resolved: string | null): resolved is string {
  return (
    resolved !== null &&
    (resolved.startsWith("http://") ||
      resolved.startsWith("https://") ||
      resolved.startsWith("data:"))
  );
}
function srcsetHasNoFetchableCandidate(srcset: string, el: Element) {
  let seen = 0;
  for (const part of String(srcset).split(",")) {
    const raw = part.trim().split(/\s+/)[0];
    if (!raw) continue;
    seen++;
    if (isFetchableImageUrl(resolveImageUrl(raw, el))) return false;
  }
  return seen > 0;
}

function invalidateImageLoadStateFor(el: HTMLImageElement): void {
  try {
    const id = el._id;
    imageLoadResults.delete(id);
    const gen = bumpImageRequestGen(id);
    let src: string | null = null;
    let srcset: string | null = null;
    try {
      src = el.getAttribute("src");
    } catch {}
    try {
      srcset = el.getAttribute("srcset");
    } catch {}
    if ((src === null || src === "") && (srcset === null || srcset === "")) {
      pendingImageReloads.delete(id);
      return;
    }
    if (src !== null && src !== "" && (srcset === null || srcset === "")) {
      const resolved = resolveImageUrl(src, el);
      if (!isFetchableImageUrl(resolved)) {
        pendingImageReloads.delete(id);
        try {
          setTimeout(() => {
            if (imageRequestGen.get(id) !== gen) return;
            try {
              notifyImageResults([id], false);
            } catch {}
          }, 0);
        } catch {}
        return;
      }
      if (resolved.startsWith("data:")) {
        pendingImageReloads.delete(id);
        queueImageTerminalEvent(id, gen, true);
        return;
      }
      try {
        if (dom.imageCacheHas(resolved)) {
          pendingImageReloads.delete(id);
          queueImageTerminalEvent(id, gen);
          return;
        }
      } catch {}
    }
    try {
      if (!dom.imageIsPending(id)) {
        pendingImageReloads.delete(id);
        queueImageTerminalEvent(id, gen);
        return;
      }
    } catch {}
    const srcUnusable =
      src === null || src === "" || !isFetchableImageUrl(resolveImageUrl(src, el));
    if (
      srcUnusable &&
      srcset !== null &&
      srcset !== "" &&
      srcsetHasNoFetchableCandidate(srcset, el)
    ) {
      pendingImageReloads.delete(id);
      queueImageTerminalEvent(id, gen);
      return;
    }
    pendingImageReloads.add(id);
  } catch {}
}

// Read the decoded size from wasm so cache hits are included.
function imageNaturalSizeFor(el: Element): [number, number] | null {
  try {
    const imageSize = dom.imageNaturalSize(el._id);
    if (imageSize.length >= 2) return [imageSize[0], imageSize[1]];
  } catch {}
  return null;
}

export function notifyImageResults(
  nodeIds: Iterable<unknown> | null | undefined,
  ok: boolean,
): void {
  if (!nodeIds) return;
  for (const rawId of nodeIds) {
    const id = Number(rawId);
    if (!Number.isFinite(id)) continue;
    if (imageLoadResults.has(id)) continue;
    pendingImageReloads.delete(id);
    let el: Element | null = null;
    try {
      el = elementFor(id);
    } catch {}
    const applied = ok && el ? imageNaturalSizeFor(el) !== null : ok;
    imageLoadResults.set(id, applied);
    if (!el) continue;
    const type = applied ? "load" : "error";
    const attrName = applied ? "onload" : "onerror";
    try {
      if (typeof el[attrName] !== "function") {
        const source = el.getAttribute?.(attrName);
        if (typeof source === "string" && source.length > 0) {
          installAttrEventHandler(el, attrName, source);
        }
      }
    } catch {}
    try {
      el.dispatchEvent(new KsEvent(type, { bubbles: false, cancelable: false }));
    } catch {}
  }
}

export function notifyStylesheetResults(url: unknown, ok: boolean): void {
  if (!url) return;
  let links: Idl.NodeList | null = null;
  try {
    links = liveDocument().querySelectorAll("link");
  } catch {
    return;
  }
  if (!links) return;
  for (const node of Array.from(links)) {
    if (!isElementWrapper(node)) continue;
    const el = node;
    let rel = "";
    try {
      rel = String(el.getAttribute("rel") || "");
    } catch {}
    if (!rel.split(/\s+/).includes("stylesheet")) continue;
    let href = "";
    try {
      href = String(el.href || "");
    } catch {}
    if (href !== String(url)) continue;
    const id = Number(el._id);
    if (!Number.isFinite(id)) continue;
    if (linkLoadFired.get(id) === href) continue;
    linkLoadFired.set(id, href);
    const type = ok ? "load" : "error";
    const attrName = ok ? "onload" : "onerror";
    try {
      if (typeof el[attrName] !== "function") {
        const source = el.getAttribute?.(attrName);
        if (typeof source === "string" && source.length > 0) {
          installAttrEventHandler(el, attrName, source);
        }
      }
    } catch {}
    try {
      el.dispatchEvent(new KsEvent(type, { bubbles: false, cancelable: false }));
    } catch {}
  }
}

export { imageLoadResults, imageNaturalSizeFor, invalidateImageLoadStateFor, pendingImageReloads };
