// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Converts image and stylesheet resource results into DOM load and error events.

import { dom, pageUrl, nodeFor, liveDocument } from "../state.js";
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
const imageRequestGen = new Map();
function bumpImageRequestGen(id) {
  const next = (imageRequestGen.get(id) || 0) + 1;
  imageRequestGen.set(id, next);
  return next;
}

function queueImageTerminalEvent(id, gen, pumpDecodes = false): void {
  try {
    setTimeout(() => dispatchQueuedImageTerminalEvent(id, gen, pumpDecodes), 0);
  } catch {}
}

function dispatchQueuedImageTerminalEvent(id: number, gen: number, pumpDecodes: boolean): void {
  if (imageRequestGen.get(id) !== gen) return;
  if (pumpDecodes) {
    try {
      dom.pumpResourceMessages?.();
    } catch {}
  }
  try {
    notifyImageResults([id], true);
  } catch {}
}

function resolveImageUrl(raw, el) {
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
function srcsetHasNoFetchableCandidate(srcset, el) {
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
    const sources = imageSourceAttributes(el);
    updateImageLoadState(el, id, gen, sources);
  } catch {}
}

function updateImageLoadState(
  el: HTMLImageElement,
  id: number,
  gen: number,
  sources: ImageSourceAttributes,
): void {
  if (clearPendingForEmptyImageSources(id, sources)) return;
  if (handleSingleImageSource(el, id, gen, sources)) return;
  if (handleNonPendingImageRequest(id, gen)) return;
  if (handleUnusableImageSourceset(el, id, gen, sources)) return;
  pendingImageReloads.add(id);
}

type ImageSourceAttributes = { src: string | null; srcset: string | null };

function imageSourceAttributes(el: HTMLImageElement): ImageSourceAttributes {
  let src: string | null = null;
  let srcset: string | null = null;
  try {
    src = el.getAttribute("src");
  } catch {}
  try {
    srcset = el.getAttribute("srcset");
  } catch {}
  return { src, srcset };
}

function clearPendingForEmptyImageSources(id: number, sources: ImageSourceAttributes): boolean {
  if (!hasNoImageSource(sources)) return false;
  pendingImageReloads.delete(id);
  return true;
}

function hasNoImageSource(sources: ImageSourceAttributes): boolean {
  return (
    (sources.src === null || sources.src === "") &&
    (sources.srcset === null || sources.srcset === "")
  );
}

function handleSingleImageSource(
  el: HTMLImageElement,
  id: number,
  gen: number,
  sources: ImageSourceAttributes,
): boolean {
  if (!hasOnlyImageSrc(sources)) return false;
  const resolved = resolveImageUrl(sources.src as string, el);
  if (!isFetchableImageUrl(resolved)) {
    pendingImageReloads.delete(id);
    queueImageErrorResult(id, gen);
    return true;
  }
  if (resolved.startsWith("data:")) {
    pendingImageReloads.delete(id);
    queueImageTerminalEvent(id, gen, true);
    return true;
  }
  if (isImageCached(resolved)) {
    pendingImageReloads.delete(id);
    queueImageTerminalEvent(id, gen);
    return true;
  }
  return false;
}

function hasOnlyImageSrc(sources: ImageSourceAttributes): boolean {
  return (
    sources.src !== null && sources.src !== "" && (sources.srcset === null || sources.srcset === "")
  );
}

function queueImageErrorResult(id: number, gen: number): void {
  try {
    setTimeout(() => {
      if (imageRequestGen.get(id) !== gen) return;
      try {
        notifyImageResults([id], false);
      } catch {}
    }, 0);
  } catch {}
}

function isImageCached(url: string): boolean {
  try {
    return Boolean(dom.imageCacheHas?.(url));
  } catch {
    return false;
  }
}

function handleNonPendingImageRequest(id: number, gen: number): boolean {
  if (!imageRequestIsNotPending(id)) return false;
  pendingImageReloads.delete(id);
  queueImageTerminalEvent(id, gen);
  return true;
}

function imageRequestIsNotPending(id: number): boolean {
  try {
    return typeof dom.imageIsPending === "function" && !dom.imageIsPending(id);
  } catch {
    return false;
  }
}

function handleUnusableImageSourceset(
  el: HTMLImageElement,
  id: number,
  gen: number,
  sources: ImageSourceAttributes,
): boolean {
  if (!hasOnlyUnusableImageSourceset(el, sources)) return false;
  pendingImageReloads.delete(id);
  queueImageTerminalEvent(id, gen);
  return true;
}

function hasOnlyUnusableImageSourceset(
  el: HTMLImageElement,
  sources: ImageSourceAttributes,
): boolean {
  return isImageSrcUnusable(el, sources.src) && hasUnusableImageSourceset(el, sources.srcset);
}

function isImageSrcUnusable(el: HTMLImageElement, src: string | null): boolean {
  return src === null || src === "" || !isFetchableImageUrl(resolveImageUrl(src, el));
}

function hasUnusableImageSourceset(el: HTMLImageElement, srcset: string | null): boolean {
  return srcset !== null && srcset !== "" && srcsetHasNoFetchableCandidate(srcset, el);
}

// Read the decoded size from wasm so cache hits are included.
function imageNaturalSizeFor(el: Element): [number, number] | null {
  try {
    const imageSize = dom.imageNaturalSize?.(el._id);
    if (imageSize && imageSize.length >= 2) return [imageSize[0], imageSize[1]];
  } catch {}
  return null;
}

export function notifyImageResults(
  nodeIds: Iterable<unknown> | null | undefined,
  ok: boolean,
): void {
  if (!nodeIds) return;
  for (const rawId of nodeIds) notifyImageResult(rawId, ok);
}

function notifyImageResult(rawId: unknown, ok: boolean): void {
  const id = Number(rawId);
  if (!Number.isFinite(id)) return;
  notifyFiniteImageResult(id, ok);
}

function notifyFiniteImageResult(id: number, ok: boolean): void {
  if (imageLoadResults.has(id)) return;
  pendingImageReloads.delete(id);
  const el = imageElementFor(id);
  const applied = imageResultApplied(ok, el);
  imageLoadResults.set(id, applied);
  if (!el) return;
  dispatchImageResultEvent(el, applied);
}

function imageElementFor(id: number): Element | null {
  let el: Element | null = null;
  try {
    el = nodeFor(id);
  } catch {}
  return el;
}

function imageResultApplied(ok: boolean, el: Element | null): boolean {
  return ok && el ? imageNaturalSizeFor(el) !== null : ok;
}

type LoadErrorAttribute = "onload" | "onerror";

function dispatchImageResultEvent(el: Element, applied: boolean): void {
  const type = applied ? "load" : "error";
  const attrName: LoadErrorAttribute = applied ? "onload" : "onerror";
  installLoadErrorAttributeHandler(el, attrName);
  try {
    el.dispatchEvent(new KsEvent(type, { bubbles: false, cancelable: false }));
  } catch {}
}

function installLoadErrorAttributeHandler(el: Element, attrName: LoadErrorAttribute): void {
  try {
    if (typeof el[attrName] !== "function") {
      installLoadErrorAttributeSource(el, attrName);
    }
  } catch {}
}

function installLoadErrorAttributeSource(el: Element, attrName: LoadErrorAttribute): void {
  const source = el.getAttribute?.(attrName);
  if (typeof source === "string" && source.length > 0) {
    installAttrEventHandler(el, attrName, source);
  }
}

export function notifyStylesheetResults(url: unknown, ok: boolean): void {
  if (!url) return;
  let links: Idl.NodeList | null;
  try {
    links = liveDocument().querySelectorAll("link");
  } catch {
    links = null;
  }
  if (!links) return;
  for (const node of Array.from(links)) notifyStylesheetNode(node, url, ok);
}

function notifyStylesheetNode(node: Idl.Node | null, url: unknown, ok: boolean): void {
  if (!isElementWrapper(node)) return;
  notifyStylesheetElement(node, url, ok);
}

function notifyStylesheetElement(el: Element, url: unknown, ok: boolean): void {
  const rel = stylesheetRel(el);
  if (!rel.split(/\s+/).includes("stylesheet")) return;
  const href = stylesheetHref(el);
  if (href !== String(url)) return;
  notifyStylesheetElementResult(el, href, ok);
}

function stylesheetRel(el: Element): string {
  let rel = "";
  try {
    rel = String(el.getAttribute("rel") || "");
  } catch {}
  return rel;
}

function stylesheetHref(el: Element): string {
  let href = "";
  try {
    href = String(el.href || "");
  } catch {}
  return href;
}

function notifyStylesheetElementResult(el: Element, href: string, ok: boolean): void {
  const id = Number(el._id);
  if (!Number.isFinite(id)) return;
  if (linkLoadFired.get(id) === href) return;
  linkLoadFired.set(id, href);
  dispatchStylesheetResultEvent(el, ok);
}

function dispatchStylesheetResultEvent(el: Element, ok: boolean): void {
  const type = ok ? "load" : "error";
  const attrName: LoadErrorAttribute = ok ? "onload" : "onerror";
  installLoadErrorAttributeHandler(el, attrName);
  try {
    el.dispatchEvent(new KsEvent(type, { bubbles: false, cancelable: false }));
  } catch {}
}

export { imageLoadResults, imageNaturalSizeFor, invalidateImageLoadStateFor, pendingImageReloads };
