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

function flushCanvasCtx(canvas: HTMLCanvasElement): void {
  const cached = canvas2dCache.get(canvas._id);
  if (!cached || cached.deref() !== canvas) return;
  try {
    canvas.__ks2dCtx?.__ksFlushForRead?.();
  } catch {}
}
function canvasPngBytes(canvas: HTMLCanvasElement): Uint8Array | null {
  const cached = canvas2dCache.get(canvas._id);
  if (!cached || cached.deref() !== canvas) return null;
  try {
    const bytes = dom?.canvasEncodePng(canvas._id);
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
  let clean = true;
  try {
    clean = !!isClean.call(dom, canvas._id);
  } catch {
    clean = true;
  }
  if (!clean) {
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
    const id = this._id;
    const cached = canvas2dCache.get(id);
    const cachedWrapper = cached?.deref();
    if (cachedWrapper === this && this.__ks2dCtx) return this.__ks2dCtx;
    if (cached && cachedWrapper !== this) {
      try {
        dom?.clearCanvasPixels(id);
      } catch {}
    }
    const ctx = makeCanvas2DContext(this);
    Object.defineProperty(this, "__ks2dCtx", { value: ctx, configurable: true });
    const entry = canvasRef(this);
    canvas2dCache.set(id, entry);
    try {
      canvasSurfaceReaper?.register(this, { id, entry });
    } catch {}
    return ctx;
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

defineReflectedUnsignedLong(HTMLCanvasElement.prototype, "width", "width", 300);
defineReflectedUnsignedLong(HTMLCanvasElement.prototype, "height", "height", 150);

export { HTMLCanvasElement };
