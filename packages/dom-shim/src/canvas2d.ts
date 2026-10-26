// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Queues Canvas 2D operations in JavaScript and flushes them to wasm-backed canvas surfaces.

import type * as Idl from "./idl/types.generated.js";
import { ksGlobal, dom } from "./state.js";
import { getInternalState } from "./internal-state.js";
import { canvas2dCache, postMutationHooks } from "./registries.js";
import { markBrandWrapped } from "./webidl.js";
import { ksInternals } from "./internals.js";

const CtxWeakRef: any =
  ksGlobal.WeakRef ??
  class {
    private _v: any;
    constructor(v: any) {
      this._v = v;
    }
    deref() {
      return this._v;
    }
  };

const detachedDirty = new Set<{ deref(): any }>();
postMutationHooks.push(() => {
  if (detachedDirty.size === 0) return;
  for (const ref of [...detachedDirty]) {
    const c = ref.deref();
    if (!c) {
      detachedDirty.delete(ref);
      continue;
    }
    if (!c.isConnected) continue;
    detachedDirty.delete(ref);
    try {
      c.__ks2dCtx?.__ksConnectedPush?.();
    } catch {}
  }
});

const PUSH_MIN_INTERVAL_MS = 66;

function pushMinIntervalMs(): number {
  const v = Number(ksInternals.canvasPushMs) | 0;
  return v > 0 ? v : PUSH_MIN_INTERVAL_MS;
}

const OP_QUEUE_HIGH_WATER = 8192;
const OP_QUEUE_FONT_HOLD_LIMIT_FACTOR = 4;

let fontHold: Promise<void> | null = null;
const heldPushes: Set<() => void> = new Set();

function noteOutlineDemand(): void {
  if (fontHold) return;
  let p: any = null;
  try {
    p = ksInternals.demandFontOutlines?.();
  } catch {}
  if (p && typeof p.then === "function") {
    fontHold = p;
    const release = () => {
      fontHold = null;
      const retries = [...heldPushes];
      heldPushes.clear();
      for (const fn of retries) {
        try {
          fn();
        } catch {}
      }
    };
    p.then(release, release);
  }
}

function batchHasTextOp(ops: CanvasOp[]): boolean {
  for (const op of ops) {
    if (op && (op.o === "fillText" || op.o === "strokeText")) return true;
  }
  return false;
}

function bumpPaintNeutral(nodeId?: number): void {
  try {
    const cs = getInternalState();
    cs.mutationSeq = (cs.mutationSeq | 0) + 1;
    cs.lastMutationAt = Date.now();
    cs.paintNeutralSeq = (cs.paintNeutralSeq | 0) + 1;
    if (typeof nodeId === "number" && nodeId >= 0 && cs.damageNodes) {
      cs.damageNodes.add(nodeId | 0);
    }
  } catch {}
}

const MAX_IMAGE_DATA_PIXELS = 4096 * 4096;

function makeImageData(w: number, h: number, data?: Uint8ClampedArray): any {
  const width = Math.max(1, w | 0);
  const height = Math.max(1, h | 0);
  if (!data && width * height > MAX_IMAGE_DATA_PIXELS) {
    throw new RangeError("ImageData size exceeds the supported range");
  }
  const bytes = data ?? new Uint8ClampedArray(width * height * 4);
  const ID = ksGlobal.ImageData;
  if (typeof ID === "function") {
    try {
      return new ID(bytes, width, height);
    } catch {}
  }
  return { width, height, data: bytes, colorSpace: "srgb" };
}

function domExc(message: string, name: string): Error {
  try {
    return new ksGlobal.DOMException(message, name);
  } catch {
    const e: any = new Error(message);
    e.name = name;
    return e;
  }
}

function serializeColor(v: unknown): string {
  const d = dom as any;
  if (typeof d?.canvasSerializeColor !== "function") return "";
  try {
    return d.canvasSerializeColor(String(v));
  } catch {
    return "";
  }
}

type CanvasGradientSpec = {
  k: "linear" | "radial" | "conic";
  v: number[];
  stops: Array<[number, string]>;
};

type CanvasPatternSpec = {
  k: "pattern";
  id: number;
  rep: string;
  oc?: boolean;
};

type CanvasStyleSpec = { k: "color"; c: string } | CanvasGradientSpec | CanvasPatternSpec;

type CanvasOp = {
  o: string;
  a?: number[];
  s?: string;
  g?: CanvasStyleSpec;
  id?: number;
  oc?: boolean;
};

type CanvasImageSource = { id: number; kind: "canvas" } | { id: number; kind: "img"; oc: boolean };

// Keep operation metadata private so page properties cannot forge renderer input.
const gradientSpecs = new WeakMap<object, CanvasGradientSpec>();
const patternSpecs = new WeakMap<object, CanvasPatternSpec>();

// Neither interface has a constructor; the context passes this.
const CANVAS_STYLE_TOKEN = Symbol("kitesurfCanvasStyle");

export class CanvasGradientShim implements Idl.CanvasGradient {
  constructor(token: symbol, spec: CanvasGradientSpec) {
    if (token !== CANVAS_STYLE_TOKEN) throw new TypeError("Illegal constructor");
    gradientSpecs.set(this, spec);
  }
  addColorStop(offset: number, color: string): void {
    const off = Number(offset);
    if (!(off >= 0 && off <= 1)) {
      throw domExc("offset out of range", "IndexSizeError");
    }
    const css = serializeColor(color);
    if (!css) throw domExc("invalid color", "SyntaxError");
    const spec = gradientSpecs.get(this);
    if (!spec) throw new TypeError("Illegal invocation");
    spec.stops.push([off, css]);
  }
}

export class CanvasPatternShim implements Idl.CanvasPattern {
  constructor(token: symbol, spec: CanvasPatternSpec) {
    if (token !== CANVAS_STYLE_TOKEN) throw new TypeError("Illegal constructor");
    patternSpecs.set(this, spec);
  }
  setTransform(_transform?: Idl.DOMMatrix2DInit): void {
    /* accepted, not applied */
  }
}

const LINE_CAPS = ["butt", "round", "square"];
const LINE_JOINS = ["miter", "round", "bevel"];
const TEXT_ALIGNS = ["start", "end", "left", "right", "center"];
const TEXT_BASELINES = ["alphabetic", "top", "hanging", "middle", "ideographic", "bottom"];
const COMPOSITES = [
  "source-over",
  "source-in",
  "source-out",
  "source-atop",
  "destination-over",
  "destination-in",
  "destination-out",
  "destination-atop",
  "lighter",
  "copy",
  "xor",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
];

interface CanvasState {
  fillStyle: string | CanvasGradientShim | CanvasPatternShim;
  strokeStyle: string | CanvasGradientShim | CanvasPatternShim;
  globalAlpha: number;
  globalCompositeOperation: string;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  miterLimit: number;
  lineDash: number[];
  lineDashOffset: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: string;
  letterSpacing: string;
  wordSpacing: string;
  fontKerning: string;
  fontStretch: string;
  fontVariantCaps: string;
  textRendering: string;
  direction: string;
  transform: number[];
}

function defaultState(): CanvasState {
  return {
    fillStyle: "#000000",
    strokeStyle: "#000000",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    miterLimit: 10,
    lineDash: [] as number[],
    lineDashOffset: 0,
    font: "10px sans-serif",
    textAlign: "start",
    textBaseline: "alphabetic",
    imageSmoothingEnabled: true,
    imageSmoothingQuality: "low",
    letterSpacing: "0px",
    wordSpacing: "0px",
    fontKerning: "auto",
    fontStretch: "normal",
    fontVariantCaps: "normal",
    textRendering: "auto",
    direction: "inherit",
    transform: [1, 0, 0, 1, 0, 0],
  };
}

function parseCssSpacing(v: unknown): string | null {
  const s = String(v).trim();
  const m = /^(-?\d+(?:\.\d+)?)(px|pt|em|rem)$/.exec(s);
  if (!m) return null;
  const factor = m[2] === "px" ? 1 : m[2] === "pt" ? 4 / 3 : 16;
  return Number(m[1]) * factor + "px";
}

function fillRule(v: unknown): "evenodd" | "nonzero" {
  return v === "evenodd" ? "evenodd" : "nonzero";
}

function pathBuilders(emit: (op: CanvasOp) => void) {
  return {
    closePath() {
      emit({ o: "closePath" });
    },
    moveTo(x: unknown, y: unknown) {
      emit({ o: "moveTo", a: [Number(x), Number(y)] });
    },
    lineTo(x: unknown, y: unknown) {
      emit({ o: "lineTo", a: [Number(x), Number(y)] });
    },
    quadraticCurveTo(cx: unknown, cy: unknown, x: unknown, y: unknown) {
      emit({ o: "quad", a: [Number(cx), Number(cy), Number(x), Number(y)] });
    },
    bezierCurveTo(c1x: unknown, c1y: unknown, c2x: unknown, c2y: unknown, x: unknown, y: unknown) {
      emit({ o: "bezier", a: [c1x, c1y, c2x, c2y, x, y].map(Number) });
    },
    arc(x: unknown, y: unknown, r: unknown, a0: unknown, a1: unknown, ccw?: unknown) {
      const rr = Number(r);
      if (rr < 0) throw domExc("negative radius", "IndexSizeError");
      emit({ o: "arc", a: [Number(x), Number(y), rr, Number(a0), Number(a1), ccw ? 1 : 0] });
    },
    arcTo(x1: unknown, y1: unknown, x2: unknown, y2: unknown, r: unknown) {
      const rr = Number(r);
      if (rr < 0) throw domExc("negative radius", "IndexSizeError");
      emit({ o: "arcTo", a: [Number(x1), Number(y1), Number(x2), Number(y2), rr] });
    },
    // eslint-disable-next-line max-params -- Canvas ellipse keeps its WebIDL signature.
    ellipse(
      x: unknown,
      y: unknown,
      rx: unknown,
      ry: unknown,
      rot: unknown,
      a0: unknown,
      a1: unknown,
      ccw?: unknown,
    ) {
      if (Number(rx) < 0 || Number(ry) < 0) throw domExc("negative radius", "IndexSizeError");
      emit({ o: "ellipse", a: [x, y, rx, ry, rot, a0, a1, ccw ? 1 : 0].map(Number) });
    },
    rect(x: unknown, y: unknown, w: unknown, h: unknown) {
      emit({ o: "rect", a: [Number(x), Number(y), Number(w), Number(h)] });
    },
    roundRect(x: unknown, y: unknown, w: unknown, h: unknown, radii?: unknown) {
      const list: unknown[] = radii === undefined ? [0] : Array.isArray(radii) ? radii : [radii];
      if (list.length < 1 || list.length > 4) {
        throw new RangeError("roundRect: 1-4 radii required");
      }
      const pairs = list.map((r) => {
        if (typeof r === "object" && r !== null) {
          const rx = Number(("x" in r ? r.x : undefined) ?? 0);
          const ry = Number(("y" in r ? r.y : undefined) ?? 0);
          if (rx < 0 || ry < 0) throw new RangeError("negative radius");
          return [rx, ry];
        }
        const n = Number(r);
        if (n < 0) throw new RangeError("negative radius");
        return [n, n];
      });
      let c: number[][];
      if (pairs.length === 1) c = [pairs[0], pairs[0], pairs[0], pairs[0]];
      else if (pairs.length === 2) c = [pairs[0], pairs[1], pairs[0], pairs[1]];
      else if (pairs.length === 3) c = [pairs[0], pairs[1], pairs[2], pairs[1]];
      else c = pairs;
      const a = [
        Number(x),
        Number(y),
        Number(w),
        Number(h),
        c[0][0],
        c[0][1],
        c[1][0],
        c[1][1],
        c[2][0],
        c[2][1],
        c[3][0],
        c[3][1],
      ];
      if (a.some((v) => !Number.isFinite(v))) return;
      emit({ o: "roundRect", a });
    },
  };
}

const path2dOps = new WeakMap<Path2D, CanvasOp[]>();

function opsOf(path: Path2D, method: string): CanvasOp[] {
  const ops = path2dOps.get(path);
  if (!ops) throw new TypeError(`Path2D.${method}: illegal invocation`);
  return ops;
}

function matrixOps(m: unknown): CanvasOp[] | null {
  if (m === undefined || m === null) return [];
  if (typeof m !== "object") throw new TypeError("Path2D.addPath: transform must be an object");
  const read = (short: string, long: string, dflt: number) =>
    Number(Reflect.get(m, short) ?? Reflect.get(m, long) ?? dflt);
  const v = [
    read("a", "m11", 1),
    read("b", "m12", 0),
    read("c", "m21", 0),
    read("d", "m22", 1),
    read("e", "m41", 0),
    read("f", "m42", 0),
  ];
  if (!v.every(Number.isFinite)) return null;
  return [{ o: "transform", a: v }];
}

type CanvasPathMethods = ReturnType<typeof pathBuilders>;
export interface Path2D extends CanvasPathMethods {}
export class Path2D implements Idl.Path2D {
  constructor(init?: unknown) {
    const ops: CanvasOp[] = [];
    path2dOps.set(this, ops);
    if (init instanceof Path2D) ops.push(...opsOf(init, "constructor"));
    else if (init !== undefined) ops.push({ o: "svgPath", s: String(init) });
  }

  addPath(path: unknown, transform?: unknown): void {
    if (!(path instanceof Path2D)) throw new TypeError("Path2D.addPath: argument is not a Path2D");
    const added = opsOf(path, "addPath");
    const ops = opsOf(this, "addPath");
    const t = matrixOps(transform);
    if (t === null) return;
    if (t.length) ops.push({ o: "save" }, ...t, ...added, { o: "restore" });
    else ops.push(...added);
  }
}

const pathMethodNames = pathBuilders(() => {});
function isPathMethod(name: string): name is keyof typeof pathMethodNames {
  return Object.hasOwn(pathMethodNames, name);
}
for (const name of Object.keys(pathMethodNames)) {
  if (!isPathMethod(name)) continue;
  Object.defineProperty(Path2D.prototype, name, {
    value: function (this: Path2D, ...args: unknown[]) {
      const ops = opsOf(this, name);
      const builders = pathBuilders((op) => ops.push(op));
      return Reflect.apply(builders[name], builders, args);
    },
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

const CONTEXT_IMPL = Symbol("kitesurfCanvasContextImpl");
type ContextImpl = Record<PropertyKey, unknown>;

type CanvasHost = { _id: number; width?: number; height?: number; isConnected?: boolean };

// installContextForwarders defines the interface members on this prototype.
export interface CanvasRenderingContext2DImpl extends Idl.CanvasRenderingContext2D {
  __ksFlushForRead(): void;
  __ksConnectedPush(): void;
}

export class CanvasRenderingContext2DImpl implements Idl.CanvasRenderingContext2D {
  constructor() {
    throw new TypeError("Illegal constructor");
  }
}

function implOf(self: unknown): ContextImpl {
  const impl =
    typeof self === "object" && self !== null
      ? (self as { [CONTEXT_IMPL]?: ContextImpl })[CONTEXT_IMPL]
      : undefined;
  if (!impl) throw new TypeError("Illegal invocation");
  return impl;
}

function named<F extends Function>(fn: F, name: string, length: number): F {
  Object.defineProperty(fn, "name", { value: name, configurable: true });
  Object.defineProperty(fn, "length", { value: length, configurable: true });
  markBrandWrapped(fn);
  return fn;
}
export function makeCanvas2DContext(
  canvas: Idl.HTMLCanvasElement & { _id: number },
): CanvasRenderingContext2DImpl {
  noteOutlineDemand();
  // installContextForwarders builds this prototype; the symbol binds per-canvas state.
  const ctx = Object.create(CanvasRenderingContext2DImpl.prototype) as CanvasRenderingContext2DImpl;
  Object.defineProperty(ctx, CONTEXT_IMPL, { value: buildContextImpl(canvas) });
  return ctx;
}

function buildContextImpl(canvas: CanvasHost): ContextImpl {
  const dbg = { attempts: 0, pushes: 0, opsSent: 0, last: "" };
  const selfRef = new CtxWeakRef(canvas);
  function isLive(): boolean {
    // Numeric IDs are local to each DomHandle; wrapper identity prevents a stale
    // context from flushing into a different canvas with the same number.
    const entry = canvas2dCache.get(canvas._id);
    return !!entry && entry.deref() === canvas;
  }
  let q: CanvasOp[] = [];
  let pendingFullPut: { w: number; h: number; data: Uint8ClampedArray } | null = null;
  let putStaging: Uint8ClampedArray | null = null;
  let lastPushTs = 0;
  let trailingTimer: any = null;
  let sizeSent = false;
  let st: CanvasState = defaultState();
  const stack: CanvasState[] = [];

  function curW(): number {
    return Math.max(1, Number(canvas.width) || 300) | 0;
  }
  function curH(): number {
    return Math.max(1, Number(canvas.height) || 150) | 0;
  }

  function sendPendingPut(): void {
    if (!pendingFullPut) return;
    if (!isLive()) {
      pendingFullPut = null;
      dbg.last = "stale";
      return;
    }
    const p = pendingFullPut;
    pendingFullPut = null;
    const d = dom as any;
    if (typeof d?.canvasPutImageData !== "function") {
      dbg.last = "no-wasm-entry";
      return;
    }
    try {
      const bytes = new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.byteLength);
      d.canvasPutImageData(canvas._id, 0, 0, p.w, p.h, bytes);
    } catch (e) {
      dbg.last = "put threw: " + ((e as any)?.message ?? String(e));
    }
  }

  function flushOps(): void {
    if (!isLive()) {
      q = [];
      pendingFullPut = null;
      dbg.last = "stale";
      return;
    }
    sendPendingPut();
    if (q.length === 0) return;
    if (
      fontHold &&
      q.length < OP_QUEUE_HIGH_WATER * OP_QUEUE_FONT_HOLD_LIMIT_FACTOR &&
      batchHasTextOp(q)
    ) {
      heldPushes.add(pushNow);
      dbg.last = "font-hold";
      return;
    }
    const batch = q;
    q = [];
    const d = dom as any;
    if (typeof d?.canvasApplyOps !== "function") {
      dbg.last = "no-wasm-entry";
      return;
    }
    try {
      const rc = d.canvasApplyOps(canvas._id, JSON.stringify(batch));
      dbg.opsSent += batch.length;
      dbg.last = "ops rc=" + rc;
    } catch (e) {
      dbg.last = "ops threw: " + ((e as any)?.message ?? String(e));
    }
  }

  function ensureSize(): void {
    if (!sizeSent) {
      sizeSent = true;
      q.push({ o: "resize", a: [curW(), curH()] });
    }
  }

  function enqueue(op: CanvasOp): void {
    if (!isLive()) {
      dbg.last = "stale";
      return;
    }
    sendPendingPut();
    ensureSize();
    q.push(op);
    if (q.length >= OP_QUEUE_HIGH_WATER) {
      flushOps();
    }
    schedulePush();
  }

  function withPath2D(path: Path2D, op: CanvasOp): void {
    enqueue({ o: "pathPush" });
    for (const pathOp of opsOf(path, op.o)) enqueue(pathOp);
    enqueue(op);
    enqueue({ o: "pathPop" });
  }

  function pushNow(): void {
    getInternalState().pendingCanvasPushes.delete(pushNow);
    dbg.attempts++;
    if (!isLive()) {
      dbg.last = "stale";
      return;
    }
    // Avoid allocating a surface for a detached probe; explicit readback still flushes.
    if (!canvas.isConnected) {
      dbg.last = "detached";
      detachedDirty.add(selfRef);
      lastPushTs = Date.now();
      return;
    }
    flushOps();
    const d = dom as any;
    if (typeof d?.canvasFlush !== "function") {
      dbg.last = "no-wasm-entry";
      return;
    }
    try {
      const rc = d.canvasFlush(canvas._id);
      dbg.last = "flush rc=" + rc;
      if (rc >= 0 && rc !== 2) {
        dbg.pushes++;
        bumpPaintNeutral(canvas._id);
      }
    } catch (e) {
      dbg.last = "flush threw: " + ((e as any)?.message ?? String(e));
    }
    lastPushTs = Date.now();
  }

  function schedulePush(): void {
    const pending = getInternalState().pendingCanvasPushes;
    if (!pending.has(pushNow)) {
      // Scene recording drains these pushes first, so queued draws can appear in that frame.
      pending.add(pushNow);
      bumpPaintNeutral();
    }
    if (trailingTimer != null) return;
    const wait = pushMinIntervalMs() - (Date.now() - lastPushTs);
    try {
      trailingTimer = setTimeout(
        () => {
          trailingTimer = null;
          pushNow();
        },
        Math.max(0, wait),
      );
    } catch {
      pushNow();
    }
  }

  function resetAll(): void {
    q = [];
    pendingFullPut = null;
    putStaging = null;
    st = defaultState();
    stack.length = 0;
    sizeSent = true;
    q.push({ o: "resize", a: [curW(), curH()] });
    schedulePush();
  }
  for (const prop of ["width", "height"]) {
    let proto = canvas;
    let desc: any = null;
    while (proto && !desc) {
      desc = Object.getOwnPropertyDescriptor(proto, prop);
      proto = Object.getPrototypeOf(proto);
    }
    if (desc && desc.set) {
      try {
        Object.defineProperty(canvas, prop, {
          configurable: true,
          enumerable: true,
          get: desc.get,
          set(v: any) {
            desc.set.call(this, v);
            resetAll();
          },
        });
      } catch {}
    }
  }

  for (const meth of ["setAttribute", "removeAttribute", "toggleAttribute"]) {
    const originalMethod = (canvas as any)[meth];
    if (typeof originalMethod !== "function") continue;
    try {
      Object.defineProperty(canvas, meth, {
        configurable: true,
        writable: true,
        enumerable: false,
        value: function (name: any, ...rest: any[]) {
          const result = originalMethod.call(this, name, ...rest);
          const attributeName = String(name).toLowerCase();
          if (attributeName === "width" || attributeName === "height") resetAll();
          return result;
        },
      });
    } catch {}
  }

  function styleSpec(v: unknown): CanvasStyleSpec | null {
    if (typeof v === "string") return { k: "color", c: v };
    if (v instanceof CanvasGradientShim) {
      const g = gradientSpecs.get(v);
      return g ? { ...g, stops: g.stops.slice() } : null;
    }
    if (v instanceof CanvasPatternShim) {
      const p = patternSpecs.get(v);
      return p ? { ...p } : null;
    }
    return null;
  }

  function setStyle(which: "fillStyle" | "strokeStyle", v: any): void {
    if (typeof v === "string") {
      const css = serializeColor(v);
      if (!css) return;
      st[which] = css;
      enqueue({ o: which, g: { k: "color", c: css } });
      return;
    }
    const g = styleSpec(v);
    if (!g) return;
    st[which] = v;
    enqueue({ o: which, g });
  }

  function mat(): number[] {
    return st.transform;
  }
  function matMul(m: number[], n: number[]): number[] {
    return [
      m[0] * n[0] + m[2] * n[1],
      m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3],
      m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4],
      m[1] * n[4] + m[3] * n[5] + m[5],
    ];
  }

  function imageSource(img: any): CanvasImageSource | null {
    if (!img || typeof img !== "object") return null;
    // Resolve source type and URL from wasm instead of trusting page-writable wrapper attributes.
    const id = img._id;
    if (typeof id !== "number" || id < 0) return null;
    let info: { kind: string; src: string } | null;
    try {
      info = dom.canvasSourceInfo(id);
    } catch {
      return null;
    }
    if (!info) return null;
    if (info.kind === "canvas") return { id, kind: "canvas" };
    if (info.kind === "img") {
      return { id, kind: "img", oc: isImgOriginClean(info.src) };
    }
    return null;
  }

  let imageOrigin: { src: string; baseHref: string; docOrigin: string; clean: boolean } | null =
    null;
  function isImgOriginClean(src: string): boolean {
    try {
      if (!src) return true;
      const g = ksGlobal;
      const baseHref = (g.document && g.document.baseURI) || (g.location ? g.location.href : "");
      const docOrigin = (g.location && g.location.origin) || "";
      if (
        imageOrigin?.src === src &&
        imageOrigin.baseHref === baseHref &&
        imageOrigin.docOrigin === docOrigin
      ) {
        return imageOrigin.clean;
      }
      const abs = new URL(src, baseHref);
      const clean =
        abs.protocol === "data:" ||
        abs.protocol === "blob:" ||
        !docOrigin ||
        abs.origin === docOrigin;
      imageOrigin = { src, baseHref, docOrigin, clean };
      return clean;
    } catch {
      return false;
    }
  }

  const ctx: any = {
    canvas,
    __ksDbg: dbg,

    get fillStyle() {
      return st.fillStyle;
    },
    set fillStyle(v: any) {
      setStyle("fillStyle", v);
    },
    get strokeStyle() {
      return st.strokeStyle;
    },
    set strokeStyle(v: any) {
      setStyle("strokeStyle", v);
    },

    get globalAlpha() {
      return st.globalAlpha;
    },
    set globalAlpha(v: any) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0 && n <= 1) {
        st.globalAlpha = n;
        enqueue({ o: "alpha", a: [n] });
      }
    },
    get globalCompositeOperation() {
      return st.globalCompositeOperation;
    },
    set globalCompositeOperation(v: any) {
      const s = String(v);
      if (COMPOSITES.indexOf(s) >= 0) {
        st.globalCompositeOperation = s;
        enqueue({ o: "composite", s });
      }
    },

    get lineWidth() {
      return st.lineWidth;
    },
    set lineWidth(v: any) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) {
        st.lineWidth = n;
        enqueue({ o: "lineWidth", a: [n] });
      }
    },
    get lineCap() {
      return st.lineCap;
    },
    set lineCap(v: any) {
      const s = String(v);
      if (LINE_CAPS.indexOf(s) >= 0) {
        st.lineCap = s;
        enqueue({ o: "lineCap", s });
      }
    },
    get lineJoin() {
      return st.lineJoin;
    },
    set lineJoin(v: any) {
      const s = String(v);
      if (LINE_JOINS.indexOf(s) >= 0) {
        st.lineJoin = s;
        enqueue({ o: "lineJoin", s });
      }
    },
    get miterLimit() {
      return st.miterLimit;
    },
    set miterLimit(v: any) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) {
        st.miterLimit = n;
        enqueue({ o: "miterLimit", a: [n] });
      }
    },
    setLineDash(segments: any) {
      const arr = Array.from(segments ?? [], Number);
      if (arr.some((v) => !Number.isFinite(v) || v < 0)) return;
      st.lineDash = arr.length % 2 === 1 ? arr.concat(arr) : arr;
      enqueue({ o: "lineDash", a: st.lineDash });
    },
    getLineDash() {
      return st.lineDash.slice();
    },
    get lineDashOffset() {
      return st.lineDashOffset;
    },
    set lineDashOffset(v: any) {
      const n = Number(v);
      if (Number.isFinite(n)) {
        st.lineDashOffset = n;
        enqueue({ o: "lineDashOffset", a: [n] });
      }
    },

    get font() {
      return st.font;
    },
    set font(v: any) {
      const s = String(v);
      if (s) {
        st.font = s;
        enqueue({ o: "font", s });
      }
    },
    get textAlign() {
      return st.textAlign;
    },
    set textAlign(v: any) {
      const s = String(v);
      if (TEXT_ALIGNS.indexOf(s) >= 0) {
        st.textAlign = s;
        enqueue({ o: "textAlign", s });
      }
    },
    get textBaseline() {
      return st.textBaseline;
    },
    set textBaseline(v: any) {
      const s = String(v);
      if (TEXT_BASELINES.indexOf(s) >= 0) {
        st.textBaseline = s;
        enqueue({ o: "textBaseline", s });
      }
    },
    get imageSmoothingEnabled() {
      return st.imageSmoothingEnabled;
    },
    set imageSmoothingEnabled(v: any) {
      st.imageSmoothingEnabled = !!v;
      enqueue({ o: "smoothing", a: [v ? 1 : 0] });
    },
    get imageSmoothingQuality() {
      return st.imageSmoothingQuality;
    },
    set imageSmoothingQuality(v: any) {
      const s = String(v);
      if (["low", "medium", "high"].indexOf(s) >= 0) st.imageSmoothingQuality = s;
    },

    get letterSpacing() {
      return st.letterSpacing;
    },
    set letterSpacing(v: any) {
      const s = parseCssSpacing(v);
      if (s !== null) st.letterSpacing = s;
    },
    get wordSpacing() {
      return st.wordSpacing;
    },
    set wordSpacing(v: any) {
      const s = parseCssSpacing(v);
      if (s !== null) st.wordSpacing = s;
    },
    get fontKerning() {
      return st.fontKerning;
    },
    set fontKerning(v: any) {
      const s = String(v);
      if (["auto", "normal", "none"].indexOf(s) >= 0) st.fontKerning = s;
    },
    get fontStretch() {
      return st.fontStretch;
    },
    set fontStretch(v: any) {
      const s = String(v);
      if (
        [
          "ultra-condensed",
          "extra-condensed",
          "condensed",
          "semi-condensed",
          "normal",
          "semi-expanded",
          "expanded",
          "extra-expanded",
          "ultra-expanded",
        ].indexOf(s) >= 0
      )
        st.fontStretch = s;
    },
    get fontVariantCaps() {
      return st.fontVariantCaps;
    },
    set fontVariantCaps(v: any) {
      const s = String(v);
      if (
        [
          "normal",
          "small-caps",
          "all-small-caps",
          "petite-caps",
          "all-petite-caps",
          "unicase",
          "titling-caps",
        ].indexOf(s) >= 0
      ) {
        st.fontVariantCaps = s;
      }
    },
    get textRendering() {
      return st.textRendering;
    },
    set textRendering(v: any) {
      const s = String(v);
      if (["auto", "optimizeSpeed", "optimizeLegibility", "geometricPrecision"].indexOf(s) >= 0)
        st.textRendering = s;
    },
    get direction() {
      return st.direction;
    },
    set direction(v: any) {
      const s = String(v);
      if (["ltr", "rtl", "inherit"].indexOf(s) >= 0) st.direction = s;
    },

    save() {
      stack.push({ ...st, lineDash: st.lineDash.slice(), transform: st.transform.slice() });
      enqueue({ o: "save" });
    },
    restore() {
      const saved = stack.pop();
      if (saved) st = saved;
      enqueue({ o: "restore" });
    },

    setTransform(a: any, b?: any, c?: any, d?: any, e?: any, f?: any) {
      let m: number[];
      if (typeof a === "object" && a) {
        m = [
          a.a ?? a.m11 ?? 1,
          a.b ?? a.m12 ?? 0,
          a.c ?? a.m21 ?? 0,
          a.d ?? a.m22 ?? 1,
          a.e ?? a.m41 ?? 0,
          a.f ?? a.m42 ?? 0,
        ].map(Number);
      } else {
        m = [a, b, c, d, e, f].map(Number);
      }
      if (m.some((v) => !Number.isFinite(v))) return;
      st.transform = m;
      enqueue({ o: "setTransform", a: m });
    },
    transform(a: any, b: any, c: any, d: any, e: any, f: any) {
      const m = [a, b, c, d, e, f].map(Number);
      if (m.some((v) => !Number.isFinite(v))) return;
      st.transform = matMul(mat(), m);
      enqueue({ o: "transform", a: m });
    },
    resetTransform() {
      st.transform = [1, 0, 0, 1, 0, 0];
      enqueue({ o: "resetTransform" });
    },
    translate(x: any, y: any) {
      const m = [Number(x), Number(y)];
      if (m.some((v) => !Number.isFinite(v))) return;
      st.transform = matMul(mat(), [1, 0, 0, 1, m[0], m[1]]);
      enqueue({ o: "translate", a: m });
    },
    scale(x: any, y: any) {
      const m = [Number(x), Number(y)];
      if (m.some((v) => !Number.isFinite(v))) return;
      st.transform = matMul(mat(), [m[0], 0, 0, m[1], 0, 0]);
      enqueue({ o: "scale", a: m });
    },
    rotate(angle: any) {
      const radians = Number(angle);
      if (!Number.isFinite(radians)) return;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      st.transform = matMul(mat(), [cos, sin, -sin, cos, 0, 0]);
      enqueue({ o: "rotate", a: [radians] });
    },
    getTransform() {
      const m = st.transform;
      return {
        a: m[0],
        b: m[1],
        c: m[2],
        d: m[3],
        e: m[4],
        f: m[5],
        m11: m[0],
        m12: m[1],
        m21: m[2],
        m22: m[3],
        m41: m[4],
        m42: m[5],
        is2D: true,
        isIdentity:
          m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0,
      };
    },

    fillRect(x: any, y: any, w: any, h: any) {
      enqueue({ o: "fillRect", a: [Number(x), Number(y), Number(w), Number(h)] });
    },
    strokeRect(x: any, y: any, w: any, h: any) {
      enqueue({ o: "strokeRect", a: [Number(x), Number(y), Number(w), Number(h)] });
    },
    clearRect(x: any, y: any, w: any, h: any) {
      enqueue({ o: "clearRect", a: [Number(x), Number(y), Number(w), Number(h)] });
    },

    beginPath() {
      enqueue({ o: "beginPath" });
    },
    ...pathBuilders(enqueue),
    fill(pathOrRule?: unknown, rule?: unknown) {
      if (pathOrRule instanceof Path2D) withPath2D(pathOrRule, { o: "fill", s: fillRule(rule) });
      else enqueue({ o: "fill", s: fillRule(pathOrRule) });
    },
    stroke(path?: unknown) {
      if (path instanceof Path2D) withPath2D(path, { o: "stroke" });
      else enqueue({ o: "stroke" });
    },
    clip(pathOrRule?: unknown, rule?: unknown) {
      if (pathOrRule instanceof Path2D) withPath2D(pathOrRule, { o: "clip", s: fillRule(rule) });
      else enqueue({ o: "clip", s: fillRule(pathOrRule) });
    },
    isPointInPath(pathOrX: unknown, xOrY?: unknown, yOrRule?: unknown, maybeRule?: unknown) {
      const path = pathOrX instanceof Path2D ? pathOrX : null;
      const [x, y, rule] = path ? [xOrY, yOrRule, maybeRule] : [pathOrX, xOrY, yOrRule];
      const d = dom as any;
      if (typeof d?.canvasIsPointInPath !== "function") return false;
      if (path) {
        enqueue({ o: "pathPush" });
        for (const pathOp of opsOf(path, "isPointInPath")) enqueue(pathOp);
      }
      flushOps();
      try {
        return !!d.canvasIsPointInPath(
          canvas._id,
          Number(x),
          Number(y),
          fillRule(rule) === "evenodd",
        );
      } catch {
        return false;
      } finally {
        if (path) enqueue({ o: "pathPop" });
      }
    },
    isPointInStroke(_x: any, _y: any) {
      return false;
    },

    fillText(text: any, x: any, y: any, maxWidth?: any) {
      noteOutlineDemand();
      const a = [Number(x), Number(y)];
      if (maxWidth !== undefined) a.push(Number(maxWidth));
      enqueue({ o: "fillText", s: String(text), a });
    },
    strokeText(text: any, x: any, y: any, maxWidth?: any) {
      noteOutlineDemand();
      const a = [Number(x), Number(y)];
      if (maxWidth !== undefined) a.push(Number(maxWidth));
      enqueue({ o: "strokeText", s: String(text), a });
    },
    measureText(text: any) {
      const d = dom as any;
      let fontsReady = true;
      try {
        fontsReady = ksInternals.demandDeferredFonts?.() ?? true;
      } catch {
        fontsReady = true;
      }
      const fallback = {
        width: 0,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: 0,
        actualBoundingBoxAscent: 0,
        actualBoundingBoxDescent: 0,
        fontBoundingBoxAscent: 0,
        fontBoundingBoxDescent: 0,
      };
      if (!fontsReady || typeof d?.canvasMeasureText !== "function") return fallback;
      try {
        return JSON.parse(d.canvasMeasureText(String(text ?? ""), st.font));
      } catch {
        return fallback;
      }
    },

    createLinearGradient(x0: any, y0: any, x1: any, y1: any) {
      const v = [x0, y0, x1, y1].map(Number);
      if (v.some((n) => !Number.isFinite(n))) throw domExc("non-finite", "NotSupportedError");
      return new CanvasGradientShim(CANVAS_STYLE_TOKEN, { k: "linear", v, stops: [] });
    },
    createRadialGradient(x0: any, y0: any, r0: any, x1: any, y1: any, r1: any) {
      const v = [x0, y0, r0, x1, y1, r1].map(Number);
      if (v.some((n) => !Number.isFinite(n))) throw domExc("non-finite", "NotSupportedError");
      if (v[2] < 0 || v[5] < 0) throw domExc("negative radius", "IndexSizeError");
      return new CanvasGradientShim(CANVAS_STYLE_TOKEN, { k: "radial", v, stops: [] });
    },
    createConicGradient(startAngle: any, x: any, y: any) {
      const v = [startAngle, x, y].map(Number);
      if (v.some((n) => !Number.isFinite(n))) throw domExc("non-finite", "NotSupportedError");
      return new CanvasGradientShim(CANVAS_STYLE_TOKEN, { k: "conic", v, stops: [] });
    },
    createPattern(image: any, repetition: any) {
      const rep = repetition == null || repetition === "" ? "repeat" : String(repetition);
      if (["repeat", "repeat-x", "repeat-y", "no-repeat"].indexOf(rep) < 0) {
        throw domExc("invalid repetition", "SyntaxError");
      }
      const src = imageSource(image);
      if (!src) return null;
      if (src.kind === "canvas" && image && image.__ks2dCtx) {
        try {
          image.__ks2dCtx.__ksFlushForRead?.();
        } catch {}
      }
      if (src.kind === "img") {
        if (!image.complete) return null;
        if (!(Number(image.naturalWidth) > 0)) {
          throw domExc("broken image", "InvalidStateError");
        }
      }
      const spec: CanvasPatternSpec = { k: "pattern", id: src.id, rep: src.kind + ":" + rep };
      if (src.kind === "img" && !src.oc) spec.oc = false;
      return new CanvasPatternShim(CANVAS_STYLE_TOKEN, spec);
    },

    drawImage(img: any, ...args: any[]) {
      const src = imageSource(img);
      if (!src) return;
      let a: number[];
      if (args.length >= 8) {
        a = args.slice(0, 8).map(Number);
      } else if (args.length >= 4) {
        a = [0, 0, -1, -1, Number(args[0]), Number(args[1]), Number(args[2]), Number(args[3])];
      } else {
        a = [0, 0, -1, -1, Number(args[0]), Number(args[1]), -1, -1];
      }
      if (a.some((n) => !Number.isFinite(n))) return;
      if (src.kind === "canvas" && img && img.__ks2dCtx) {
        try {
          img.__ks2dCtx.__ksFlushForRead?.();
        } catch {}
      }
      const op: CanvasOp = { o: "drawImage", s: src.kind, id: src.id, a };
      if (src.kind === "img" && !src.oc) op.oc = false;
      enqueue(op);
      flushOps();
    },

    createImageData(a: any, b?: any) {
      if (typeof a === "object" && a && typeof a.width === "number") {
        return makeImageData(a.width, a.height);
      }
      return makeImageData(a, b);
    },

    putImageData(img: any, dx: number, dy: number) {
      if (!img || !img.data || !img.width || !img.height) return;
      const x0 = dx | 0;
      const y0 = dy | 0;
      const iw = img.width | 0;
      const ih = img.height | 0;
      if (x0 === 0 && y0 === 0 && iw === curW() && ih === curH()) {
        if (!isLive()) {
          dbg.last = "stale";
          return;
        }
        ensureSize();
        if (q.length > 0) {
          flushOps();
        }
        const byteLength = iw * ih * 4;
        const data = img.data;
        const tag = Object.prototype.toString.call(data);
        if (
          data.length === byteLength &&
          (tag === "[object Uint8ClampedArray]" || tag === "[object Uint8Array]")
        ) {
          if (putStaging?.length !== byteLength) putStaging = new Uint8ClampedArray(byteLength);
          putStaging.set(data);
          pendingFullPut = { w: iw, h: ih, data: putStaging };
        } else {
          pendingFullPut = { w: iw, h: ih, data: data.slice(0, byteLength) };
        }
        schedulePush();
        return;
      }
      if (!isLive()) {
        dbg.last = "stale";
        return;
      }
      ensureSize();
      flushOps();
      const d = dom as any;
      if (typeof d?.canvasPutImageData !== "function") {
        dbg.last = "no-wasm-entry";
        return;
      }
      try {
        const data: Uint8ClampedArray = img.data;
        const bytes = new Uint8Array(data.buffer, data.byteOffset, iw * ih * 4);
        d.canvasPutImageData(canvas._id, x0, y0, iw, ih, bytes);
      } catch (e) {
        dbg.last = "put threw: " + ((e as any)?.message ?? String(e));
      }
      schedulePush();
    },

    getImageData(sx: number, sy: number, sw: number, sh: number) {
      const w = sw | 0;
      const h = sh | 0;
      if (w <= 0 || h <= 0) throw domExc("zero-size", "IndexSizeError");
      if (!isLive()) return makeImageData(w, h);
      flushOps();
      const d = dom as any;
      if (typeof d?.canvasIsOriginClean === "function") {
        try {
          if (!d.canvasIsOriginClean(canvas._id)) {
            throw domExc("The canvas has been tainted by cross-origin data.", "SecurityError");
          }
        } catch (e) {
          if ((e as any)?.name === "SecurityError") throw e;
        }
      }
      const out = makeImageData(w, h);
      if (typeof d?.canvasGetImageData !== "function") return out;
      try {
        const bytes: Uint8Array = d.canvasGetImageData(canvas._id, sx | 0, sy | 0, w, h);
        if (bytes && bytes.length === w * h * 4) out.data.set(bytes);
      } catch (e) {
        dbg.last = "get threw: " + ((e as any)?.message ?? String(e));
      }
      return out;
    },

    __ksFlushForRead() {
      flushOps();
    },

    __ksConnectedPush() {
      pushNow();
    },
  };

  return ctx;
}

(function installContextForwarders(): void {
  const proto = CanvasRenderingContext2DImpl.prototype;
  const template = buildContextImpl({ _id: -1 });
  for (const key of Object.getOwnPropertyNames(template)) {
    const d = Object.getOwnPropertyDescriptor(template, key);
    if (!d) continue;
    const enumerable = !key.startsWith("__ks");
    if (typeof d.value === "function") {
      const forward = named(
        function (this: unknown) {
          const impl = implOf(this);
          const member = impl[key];
          if (typeof member !== "function") throw new TypeError("Illegal invocation");
          // eslint-disable-next-line prefer-rest-params
          return Reflect.apply(member, impl, arguments);
        },
        key,
        d.value.length,
      );
      Object.defineProperty(proto, key, {
        value: forward,
        writable: true,
        enumerable,
        configurable: true,
      });
    } else {
      const get = named(
        function (this: unknown) {
          return implOf(this)[key];
        },
        `get ${key}`,
        0,
      );
      const set = d.set
        ? named(
            function (this: unknown, value: unknown) {
              implOf(this)[key] = value;
            },
            `set ${key}`,
            1,
          )
        : undefined;
      Object.defineProperty(proto, key, { get, set, enumerable, configurable: true });
    }
  }
})();
