// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements HTMLCanvasElement dimensions, cached 2D contexts, and bitmap export.

import type * as Idl from "../idl/types.generated.js";
import { ksGlobal, dom } from "../state.js";
import { canvas2dCache } from "../registries.js";
import { makeCanvas2DContext } from "../canvas2d.js";
import { defineReflectedUnsignedLong } from "./reflect.js";
import { HTMLElement, checkInternalConstruct } from "./html-element.js";

// The registered wrapper and its cache entry, so a stale finalization for a
// replaced wrapper leaves the live entry alone.
type CanvasCacheEntry = { deref(): object | undefined };
interface HeldCanvas {
  readonly id: number;
  readonly entry: CanvasCacheEntry;
}

const canvasSurfaceReaper = (() => {
  try {
    const FR: typeof FinalizationRegistry | undefined = ksGlobal.FinalizationRegistry;
    if (typeof FR !== "function") return null;
    return new FR((held: HeldCanvas) => {
      if (canvas2dCache.get(held.id) !== held.entry) return;
      canvas2dCache.delete(held.id);
      try {
        dom?.clearCanvasPixels(held.id);
      } catch {}
    });
  } catch {
    return null;
  }
})();

const NativeWeakRef: typeof WeakRef | undefined = ksGlobal.WeakRef;
const canvasRef = (canvas: HTMLCanvasElement): CanvasCacheEntry =>
  NativeWeakRef ? new NativeWeakRef(canvas) : { deref: () => canvas };

function cachedCanvas(canvas: HTMLCanvasElement): CanvasCacheEntry | undefined {
  const cached = canvas2dCache.get(canvas._id);
  return cached?.deref() === canvas ? cached : undefined;
}

function flushCanvasCtx(canvas: HTMLCanvasElement): void {
  if (!cachedCanvas(canvas)) return;
  try {
    canvas.__ks2dCtx?.__ksFlushForRead?.();
  } catch {}
}
function canvasPngBytes(canvas: HTMLCanvasElement): Uint8Array | null {
  if (!cachedCanvas(canvas)) return null;
  return encodeCanvasPng(canvas._id);
}

function encodeCanvasPng(id: number): Uint8Array | null {
  try {
    const bytes = dom?.canvasEncodePng(id);
    if (bytes && bytes.length > 0) return bytes;
  } catch {}
  return null;
}
// Callers flush queued draws first, so a pending cross-origin draw taints the
// canvas before this check. Readback from a tainted canvas throws SecurityError.
// https://html.spec.whatwg.org/#concept-canvas-origin-clean
function ensureCanvasOriginClean(canvas: HTMLCanvasElement): void {
  const isClean = dom?.canvasIsOriginClean;
  if (typeof isClean !== "function") return;
  const id = canvas._id;
  let originClean = true;
  try {
    originClean = !!isClean.call(dom, id);
  } catch {}
  if (!originClean) {
    throw new (ksGlobal.DOMException || Error)(
      "The canvas has been tainted by cross-origin data.",
      "SecurityError",
    );
  }
}
// The reflections below the class install these.
interface HTMLCanvasElement extends Pick<Idl.HTMLCanvasElement, "width" | "height"> {}

// getContext() only knows "2d".
class HTMLCanvasElement extends HTMLElement implements Idl.HTMLCanvasElement {
  // The 2D context, cached on the element by its first getContext("2d").
  declare __ks2dCtx?: ReturnType<typeof makeCanvas2DContext>;
  constructor(nodeId: number, info: unknown, token?: symbol) {
    super(nodeId, info);
    checkInternalConstruct(token, "HTMLCanvasElement");
  }
  getContext(contextType?: string, _attributes?: unknown): Idl.RenderingContext | null {
    const kind = String(contextType ?? "").toLowerCase();
    if (kind !== "2d") return null;
    return getOrCreateCanvasContext(this);
  }
  toDataURL(_type?: string, _quality?: unknown): string {
    flushCanvasCtx(this);
    ensureCanvasOriginClean(this);
    const bytes = canvasPngBytes(this);
    if (!bytes) {
      return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
    }
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += Reflect.apply(String.fromCharCode, null, bytes.subarray(i, i + 0x8000));
    }
    return "data:image/png;base64," + btoa(bin);
  }
  toBlob(callback: Idl.BlobCallback, _type?: string, _quality?: unknown): void {
    flushCanvasCtx(this);
    ensureCanvasOriginClean(this);
    const bytes = canvasPngBytes(this);
    setTimeout(() => {
      try {
        const BlobCtor = ksGlobal.Blob;
        callback(bytes && BlobCtor ? new BlobCtor([bytes], { type: "image/png" }) : null);
      } catch {}
    }, 0);
  }
}

function getOrCreateCanvasContext(canvas: HTMLCanvasElement): Idl.RenderingContext {
  const id = canvas._id;
  const context = existingCanvasContext(canvas, id);
  if (context) return context;
  clearReplacedCanvasPixels(canvas, id);
  const ctx = makeCanvas2DContext(canvas);
  Object.defineProperty(canvas, "__ks2dCtx", { value: ctx, configurable: true });
  const entry = canvasRef(canvas);
  canvas2dCache.set(id, entry);
  registerCanvasSurface(canvas, id, entry);
  return ctx;
}

function existingCanvasContext(
  canvas: HTMLCanvasElement,
  id: number,
): ReturnType<typeof makeCanvas2DContext> | null {
  const cached = canvas2dCache.get(id);
  const cachedWrapper = cached?.deref();
  return cachedWrapper === canvas && canvas.__ks2dCtx ? canvas.__ks2dCtx : null;
}

function clearReplacedCanvasPixels(canvas: HTMLCanvasElement, id: number): void {
  const cached = canvas2dCache.get(id);
  if (!cached || cached.deref() === canvas) return;
  try {
    dom?.clearCanvasPixels(id);
  } catch {}
}

function registerCanvasSurface(
  canvas: HTMLCanvasElement,
  id: number,
  entry: CanvasCacheEntry,
): void {
  try {
    canvasSurfaceReaper?.register(canvas, { id, entry });
  } catch {}
}

defineReflectedUnsignedLong(HTMLCanvasElement.prototype, "width", "width", 300);
defineReflectedUnsignedLong(HTMLCanvasElement.prototype, "height", "height", 150);

export { HTMLCanvasElement };
