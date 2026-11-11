// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Queues Canvas 2D operations in JavaScript and flushes them to wasm-backed canvas surfaces.

import type * as Idl from "./idl/types.generated.js";
import { ksGlobal, dom, getDocumentUrl } from "./state.js";
import { getInternalState } from "./internal-state.js";
import { canvas2dCache, postMutationHooks } from "./registries.js";
import { markBrandWrapped } from "./webidl.js";
import { ksInternals } from "./internals.js";
import { errorMessage } from "./util/strings.js";

// Origin checks must not read URL intrinsics after page code can replace them.
const CanvasURL = URL;
const canvasUrlGetter = (name: "href" | "origin" | "protocol"): ((this: URL) => string) => {
  const getter = Object.getOwnPropertyDescriptor(CanvasURL.prototype, name)?.get;
  if (typeof getter !== "function") throw new Error(`URL ${name} getter unavailable`);
  return getter;
};
const canvasUrlHref = canvasUrlGetter("href");
const canvasUrlOrigin = canvasUrlGetter("origin");
const canvasUrlProtocol = canvasUrlGetter("protocol");

// The taint decision parses page-written attribute text, so it must not call a
// String member the page can replace: a replaced `String` or `toLowerCase` can
// otherwise turn a cross-origin candidate into a same-origin one.
const nativeApply = Reflect.apply;
const nativeCall = Function.prototype.call;
const nativeBind = Function.prototype.bind;
// `bind.call(bind, call)` with all three intrinsics captured at module load: the
// result invokes a method with its first argument as `this` and allocates no
// argument list, so later page replacements cannot intercept the call.
const uncurriedBinder = nativeApply(nativeBind, nativeBind, [nativeCall]) as (
  fn: unknown,
) => unknown;
function bindMethod<T>(fn: unknown): T {
  return uncurriedBinder(fn) as T;
}
const CanvasString = String;
const stringToLowerCase = bindMethod<(s: string) => string>(String.prototype.toLowerCase);
const stringCharCodeAt = bindMethod<(s: string, i: number) => number>(String.prototype.charCodeAt);
const stringSlice = bindMethod<(s: string, a: number, b: number) => string>(String.prototype.slice);
const urlHref = bindMethod<(url: URL) => string>(canvasUrlHref);
const urlOrigin = bindMethod<(url: URL) => string>(canvasUrlOrigin);
const urlProtocol = bindMethod<(url: URL) => string>(canvasUrlProtocol);

class PinnedRef<T extends object> {
  private _v: T;
  constructor(v: T) {
    this._v = v;
  }
  deref(): T {
    return this._v;
  }
}
const CtxWeakRef: new <T extends object>(v: T) => { deref(): T | undefined } =
  ksGlobal.WeakRef ?? PinnedRef;

const detachedDirty = new Set<{ deref(): CanvasHost | undefined }>();
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
  let p: Promise<void> | null | undefined = null;
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
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
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

// What the context hands back: the page's ImageData, or this record where
// the global is missing.
type ImageDataLike = {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  readonly colorSpace?: string;
};

// ToInt32 on a page value with `|`, which throws a TypeError for a BigInt where Number()
// would convert it. The cast only satisfies the operator's operand type.
function toInt32(value: unknown): number {
  return (value as number) | 0;
}

function makeImageData(w: unknown, h: unknown, data?: Uint8ClampedArray): ImageDataLike {
  const width = Math.max(1, toInt32(w));
  const height = Math.max(1, toInt32(h));
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
    return Object.assign(new Error(message), { name });
  }
}

function serializeColor(v: unknown): string {
  try {
    return dom.canvasSerializeColor(String(v));
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

// Captured before page script runs, which can replace JSON.stringify or add toJSON, push or
// iterator methods to a prototype. Serialization walks these private copies, so a page hook
// never receives a queued operation.
const stringifyBatch = JSON.stringify;
const ownKeys = Object.keys;
const ownDescriptor = Object.getOwnPropertyDescriptor;
const createObject = Object.create;
const setPrototype = Object.setPrototypeOf;
const defineProperty = Object.defineProperty;
const isArray = Array.isArray;
const MAX_BATCH_DEPTH = 32;

function snapshotBatchValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_BATCH_DEPTH) throw new TypeError("canvas operation is too deep");
  // Both copies have a null prototype, so plain assignment cannot reach a page
  // setter on Object.prototype or Array.prototype.
  const copy = (isArray(value) ? setPrototype([], null) : createObject(null)) as Record<
    string,
    unknown
  >;
  const keys = ownKeys(value);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const descriptor = ownDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError("canvas operation contains an accessor");
    }
    // A function value could only be a page-installed hook such as toJSON.
    if (typeof descriptor.value === "function") continue;
    copy[key] = snapshotBatchValue(descriptor.value, depth + 1);
  }
  return copy;
}

// Sets a flag as an own data property, so an Object.prototype setter for the
// name cannot receive the operation or swallow the flag.
function defineFlag<T extends object>(target: T, name: string, value: boolean): T {
  defineProperty(target, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return target;
}

// Appends without Array.prototype.push, which a page can replace and observe the private array.
function appendPrivate<T>(array: T[], value: T): void {
  defineProperty(array, array.length, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

// Keep operation metadata private so page properties cannot forge renderer input.
const gradientSpecs = new WeakMap<object, CanvasGradientSpec>();
const gradientGet = gradientSpecs.get.bind(gradientSpecs);
const gradientSet = gradientSpecs.set.bind(gradientSpecs);
const patternSpecs = new WeakMap<object, CanvasPatternSpec>();
const patternGet = patternSpecs.get.bind(patternSpecs);
const patternSet = patternSpecs.set.bind(patternSpecs);

// Neither interface has a constructor; the context passes this.
const CANVAS_STYLE_TOKEN = Symbol("kitesurfCanvasStyle");

export class CanvasGradientShim implements Idl.CanvasGradient {
  constructor(token: symbol, spec: CanvasGradientSpec) {
    if (token !== CANVAS_STYLE_TOKEN) throw new TypeError("Illegal constructor");
    gradientSet(this, spec);
  }
  addColorStop(offset: number, color: string): void {
    const off = Number(offset);
    if (!(off >= 0 && off <= 1)) {
      throw domExc("offset out of range", "IndexSizeError");
    }
    const css = serializeColor(color);
    if (!css) throw domExc("invalid color", "SyntaxError");
    const spec = gradientGet(this);
    if (!spec) throw new TypeError("Illegal invocation");
    appendPrivate(spec.stops, [off, css]);
  }
}

export class CanvasPatternShim implements Idl.CanvasPattern {
  constructor(token: symbol, spec: CanvasPatternSpec) {
    if (token !== CANVAS_STYLE_TOKEN) throw new TypeError("Illegal constructor");
    patternSet(this, spec);
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
    moveTo(x: number, y: number) {
      emit({ o: "moveTo", a: [Number(x), Number(y)] });
    },
    lineTo(x: number, y: number) {
      emit({ o: "lineTo", a: [Number(x), Number(y)] });
    },
    quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
      emit({ o: "quad", a: [Number(cx), Number(cy), Number(x), Number(y)] });
    },
    bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number) {
      emit({ o: "bezier", a: [c1x, c1y, c2x, c2y, x, y].map(Number) });
    },
    arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean) {
      const rr = Number(r);
      if (rr < 0) throw domExc("negative radius", "IndexSizeError");
      emit({ o: "arc", a: [Number(x), Number(y), rr, Number(a0), Number(a1), ccw ? 1 : 0] });
    },
    arcTo(x1: number, y1: number, x2: number, y2: number, r: number) {
      const rr = Number(r);
      if (rr < 0) throw domExc("negative radius", "IndexSizeError");
      emit({ o: "arcTo", a: [Number(x1), Number(y1), Number(x2), Number(y2), rr] });
    },
    // eslint-disable-next-line max-params -- Canvas ellipse keeps its WebIDL signature.
    ellipse(
      x: number,
      y: number,
      rx: number,
      ry: number,
      rot: number,
      a0: number,
      a1: number,
      ccw?: boolean,
    ) {
      if (Number(rx) < 0 || Number(ry) < 0) throw domExc("negative radius", "IndexSizeError");
      emit({ o: "ellipse", a: [x, y, rx, ry, rot, a0, a1, ccw ? 1 : 0].map(Number) });
    },
    rect(x: number, y: number, w: number, h: number) {
      emit({ o: "rect", a: [Number(x), Number(y), Number(w), Number(h)] });
    },
    roundRect(
      x: number,
      y: number,
      w: number,
      h: number,
      radii?: number | Idl.DOMPointInit | (number | Idl.DOMPointInit)[],
    ) {
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
const path2dGet = path2dOps.get.bind(path2dOps);
const path2dSet = path2dOps.set.bind(path2dOps);

function opsOf(path: Path2D, method: string): CanvasOp[] {
  const ops = path2dGet(path);
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
  constructor(init?: Path2D | string) {
    const ops: CanvasOp[] = [];
    path2dSet(this, ops);
    if (init instanceof Path2D) {
      const added = opsOf(init, "constructor");
      for (let i = 0; i < added.length; i++) appendPrivate(ops, added[i]);
    } else if (init !== undefined) {
      appendPrivate(ops, { o: "svgPath", s: String(init) });
    }
  }

  addPath(path: Idl.Path2D, transform?: Idl.DOMMatrix2DInit): void {
    if (!(path instanceof Path2D)) throw new TypeError("Path2D.addPath: argument is not a Path2D");
    const added = opsOf(path, "addPath");
    const ops = opsOf(this, "addPath");
    const t = matrixOps(transform);
    if (t === null) return;
    const addedLength = added.length;
    if (t.length) appendPrivate(ops, { o: "save" });
    for (let i = 0; i < t.length; i++) appendPrivate(ops, t[i]);
    for (let i = 0; i < addedLength; i++) appendPrivate(ops, added[i]);
    if (t.length) appendPrivate(ops, { o: "restore" });
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
      const builders = pathBuilders((op) => appendPrivate(ops, op));
      return Reflect.apply(builders[name], builders, args);
    },
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

const CONTEXT_IMPL = Symbol("kitesurfCanvasContextImpl");

type CanvasHost = {
  _id: number;
  width?: number;
  height?: number;
  isConnected?: boolean;
  __ks2dCtx?: CanvasRenderingContext2DImpl;
};
// A drawImage or createPattern source as the page passes it. Not
// brand-checked: imageSource resolves it through its node id, and the
// other members are read as the element wrappers carry them.
type SourceWrapper = {
  _id?: unknown;
  __ks2dCtx?: { __ksFlushForRead?(): void };
  complete?: boolean;
  naturalWidth?: unknown;
};
// putImageData's argument, read the same way: width, height and data.
type ImageDataInput = { width?: unknown; height?: unknown; data?: Uint8ClampedArray };
// setTransform's matrix argument: a DOMMatrix2DInit, or a DOMMatrix with
// the m11..m42 aliases.
type MatrixInput = Idl.DOMMatrix2DInit & {
  m11?: number;
  m12?: number;
  m21?: number;
  m22?: number;
  m41?: number;
  m42?: number;
};

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

// Keyed by member name, for the forwarders.
function implOf(self: unknown): Record<string, unknown> {
  const impl: unknown =
    typeof self === "object" && self !== null ? Reflect.get(self, CONTEXT_IMPL) : undefined;
  if (!isRecord(impl)) throw new TypeError("Illegal invocation");
  return impl;
}

function named<F extends Function>(fn: F, name: string, length: number): F {
  Object.defineProperty(fn, "name", { value: name, configurable: true });
  Object.defineProperty(fn, "length", { value: length, configurable: true });
  markBrandWrapped(fn);
  return fn;
}
export function makeCanvas2DContext(canvas: CanvasHost): CanvasRenderingContext2DImpl {
  noteOutlineDemand();
  // installContextForwarders builds this prototype; the symbol binds per-canvas state.
  const ctx = Object.create(CanvasRenderingContext2DImpl.prototype) as CanvasRenderingContext2DImpl;
  Object.defineProperty(ctx, CONTEXT_IMPL, { value: buildContextImpl(canvas) });
  return ctx;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function buildContextImpl(canvas: CanvasHost) {
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
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;
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
    try {
      const bytes = new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.byteLength);
      dom.canvasPutImageData(canvas._id, 0, 0, p.w, p.h, bytes);
    } catch (e) {
      dbg.last = "put threw: " + errorMessage(e);
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
    try {
      const rc = dom.canvasApplyOps(canvas._id, stringifyBatch(snapshotBatchValue(batch)));
      dbg.opsSent += batch.length;
      dbg.last = "ops rc=" + rc;
    } catch (e) {
      dbg.last = "ops threw: " + errorMessage(e);
    }
  }

  function ensureSize(): void {
    if (!sizeSent) {
      sizeSent = true;
      appendPrivate(q, { o: "resize", a: [curW(), curH()] });
    }
  }

  function enqueue(op: CanvasOp): void {
    if (!isLive()) {
      dbg.last = "stale";
      return;
    }
    sendPendingPut();
    ensureSize();
    appendPrivate(q, op);
    if (q.length >= OP_QUEUE_HIGH_WATER) {
      flushOps();
    }
    schedulePush();
  }

  function withPath2D(path: Path2D, op: CanvasOp): void {
    enqueue({ o: "pathPush" });
    const ops = opsOf(path, op.o);
    for (let i = 0; i < ops.length; i++) enqueue(ops[i]);
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
    try {
      const rc = dom.canvasFlush(canvas._id);
      dbg.last = "flush rc=" + rc;
      if (rc >= 0 && rc !== 2) {
        dbg.pushes++;
        bumpPaintNeutral(canvas._id);
      }
    } catch (e) {
      dbg.last = "flush threw: " + errorMessage(e);
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
    appendPrivate(q, { o: "resize", a: [curW(), curH()] });
    schedulePush();
  }
  for (const prop of ["width", "height"]) {
    let proto = canvas;
    let desc: PropertyDescriptor | undefined;
    while (proto && !desc) {
      desc = Object.getOwnPropertyDescriptor(proto, prop);
      proto = Object.getPrototypeOf(proto);
    }
    const setter = desc?.set;
    if (desc && setter) {
      try {
        Object.defineProperty(canvas, prop, {
          configurable: true,
          enumerable: true,
          get: desc.get,
          set(v: unknown) {
            setter.call(this, v);
            resetAll();
          },
        });
      } catch {}
    }
  }

  for (const meth of ["setAttribute", "removeAttribute", "toggleAttribute"]) {
    const originalMethod: unknown = Reflect.get(canvas, meth);
    if (typeof originalMethod !== "function") continue;
    try {
      Object.defineProperty(canvas, meth, {
        configurable: true,
        writable: true,
        enumerable: false,
        value: function (this: unknown, name: unknown, ...rest: unknown[]) {
          const result: unknown = originalMethod.call(this, name, ...rest);
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
      const g = gradientGet(v);
      if (!g) return null;
      const stops: CanvasGradientSpec["stops"] = [];
      for (let i = 0; i < g.stops.length; i++) appendPrivate(stops, g.stops[i]);
      return { ...g, stops };
    }
    if (v instanceof CanvasPatternShim) {
      const p = patternGet(v);
      return p ? { ...p } : null;
    }
    return null;
  }

  function setStyle(which: "fillStyle" | "strokeStyle", v: unknown): void {
    if (typeof v === "string") {
      const css = serializeColor(v);
      if (!css) return;
      st[which] = css;
      enqueue({ o: which, g: { k: "color", c: css } });
      return;
    }
    if (!(v instanceof CanvasGradientShim) && !(v instanceof CanvasPatternShim)) return;
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

  function imageSource(img: SourceWrapper | null | undefined): CanvasImageSource | null {
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
      return { id, kind: "img", oc: isImgOriginClean(id, info.src) };
    }
    return null;
  }

  let imageOrigin: {
    seq: number;
    id: number;
    src: string;
    baseHref: string;
    loaderHref: string;
    docOrigin: string;
    clean: boolean;
  } | null = null;
  // The document base URL comes from the shim's own DOM and captured URL
  // intrinsics: page code can replace globalThis.location, document and URL,
  // and it can override element getters, so none of those answer here.
  let documentBaseMemo: {
    seq: number;
    fallback: string;
    href: string;
    origin: string;
  } | null = null;
  function nodeAttributes(id: number): string[] {
    try {
      const info = dom.nodeInfo(id);
      return (info && info.attributes) || [];
    } catch {
      return [];
    }
  }
  function nodeLocalName(id: number): string {
    try {
      const info = dom.nodeInfo(id);
      return info && typeof info.localName === "string" ? stringToLowerCase(info.localName) : "";
    } catch {
      return "";
    }
  }
  function nodeAttr(id: number, name: string): string | null {
    const attrs = nodeAttributes(id);
    for (let i = 0; i + 1 < attrs.length; i += 2) {
      if (stringToLowerCase(CanvasString(attrs[i])) === name) return CanvasString(attrs[i + 1]);
    }
    return null;
  }
  function resolveDocumentBaseHref(fallback: string): string {
    try {
      const baseId = dom.querySelector("base[href]");
      if (baseId <= 0) return fallback;
      const attrs = nodeAttributes(baseId);
      for (let i = 0; i + 1 < attrs.length; i += 2) {
        if (stringToLowerCase(CanvasString(attrs[i])) !== "href") continue;
        const href = CanvasString(attrs[i + 1]);
        return href === "" ? fallback : urlHref(new CanvasURL(href, fallback));
      }
    } catch {}
    return fallback;
  }
  function documentBase(): { href: string; origin: string } {
    // The committed document URL is not page-writable.
    const fallback = getDocumentUrl();
    const seq = getInternalState().mutationSeq | 0;
    if (
      documentBaseMemo &&
      documentBaseMemo.seq === seq &&
      documentBaseMemo.fallback === fallback
    ) {
      return documentBaseMemo;
    }
    let origin = "";
    try {
      const parsed = urlOrigin(new CanvasURL(fallback));
      if (parsed !== "null") origin = parsed;
    } catch {}
    documentBaseMemo = {
      seq,
      fallback,
      href: resolveDocumentBaseHref(fallback),
      origin,
    };
    return documentBaseMemo;
  }
  // Mirrors the loader's whitespace-anchored srcset scan (blitz
  // pick_srcset_candidate): skip separators, read a non-whitespace URL token,
  // strip a trailing comma, then skip the descriptor up to the next comma.
  function forEachSrcsetCandidate(srcset: string, visit: (url: string) => void): void {
    const len = srcset.length;
    let i = 0;
    while (i < len) {
      let c = 0;
      while (i < len) {
        c = stringCharCodeAt(srcset, i);
        if (c === 44 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32) i++;
        else break;
      }
      if (i >= len) break;
      const start = i;
      while (i < len) {
        c = stringCharCodeAt(srcset, i);
        if (c === 9 || c === 10 || c === 12 || c === 13 || c === 32) break;
        i++;
      }
      let end = i;
      if (end > start && stringCharCodeAt(srcset, end - 1) === 44) end--;
      if (end > start) visit(stringSlice(srcset, start, end));
      while (i < len && stringCharCodeAt(srcset, i) !== 44) i++;
    }
  }
  function isCandidateClean(url: string, baseHref: string, docOrigin: string): boolean {
    try {
      const abs = new CanvasURL(url, baseHref);
      const protocol = urlProtocol(abs);
      if (protocol === "data:" || protocol === "blob:") return true;
      return docOrigin !== "" && urlOrigin(abs) === docOrigin;
    } catch {
      return false;
    }
  }
  function isImgOriginClean(id: number, src: string): boolean {
    const seq = getInternalState().mutationSeq | 0;
    const base = documentBase();
    const loaderHref = getDocumentUrl();
    if (
      imageOrigin &&
      imageOrigin.seq === seq &&
      imageOrigin.id === id &&
      imageOrigin.src === src &&
      imageOrigin.baseHref === base.href &&
      imageOrigin.loaderHref === loaderHref &&
      imageOrigin.docOrigin === base.origin
    ) {
      return imageOrigin.clean;
    }
    // Every URL the loader can fetch for this <img>: its src, its srcset
    // candidates, and the srcset candidates of the <picture> sources before it
    // (blitz select_image_url). Deciding from the src attribute alone misses the
    // URL the pixels came from.
    let clean = true;
    const visit = (url: string): void => {
      if (!clean) return;
      // The loader resolves against the document URL and ignores <base>, so that
      // resolution decides; <base> stays a second, conservative input.
      if (
        !isCandidateClean(url, loaderHref, base.origin) ||
        (base.href !== loaderHref && !isCandidateClean(url, base.href, base.origin))
      ) {
        clean = false;
      }
    };
    if (src) visit(src);
    forEachSrcsetCandidate(nodeAttr(id, "srcset") ?? "", visit);
    let parent = -1;
    try {
      parent = dom.parentId(id);
    } catch {}
    if (parent > 0 && nodeLocalName(parent) === "picture") {
      try {
        const children = dom.childIds(parent);
        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          if (typeof child !== "number") continue;
          if (child === id) break;
          if (nodeLocalName(child) !== "source") continue;
          forEachSrcsetCandidate(nodeAttr(child, "srcset") ?? "", visit);
        }
      } catch {}
    }
    imageOrigin = {
      seq,
      id,
      src,
      baseHref: base.href,
      loaderHref,
      docOrigin: base.origin,
      clean,
    };
    return clean;
  }

  const ctx = {
    canvas,
    __ksDbg: dbg,

    get fillStyle() {
      return st.fillStyle;
    },
    set fillStyle(v: string | Idl.CanvasGradient | Idl.CanvasPattern) {
      setStyle("fillStyle", v);
    },
    get strokeStyle() {
      return st.strokeStyle;
    },
    set strokeStyle(v: string | Idl.CanvasGradient | Idl.CanvasPattern) {
      setStyle("strokeStyle", v);
    },

    get globalAlpha() {
      return st.globalAlpha;
    },
    set globalAlpha(v: number) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0 && n <= 1) {
        st.globalAlpha = n;
        enqueue({ o: "alpha", a: [n] });
      }
    },
    get globalCompositeOperation() {
      return st.globalCompositeOperation;
    },
    set globalCompositeOperation(v: string) {
      const s = String(v);
      if (COMPOSITES.indexOf(s) >= 0) {
        st.globalCompositeOperation = s;
        enqueue({ o: "composite", s });
      }
    },

    get lineWidth() {
      return st.lineWidth;
    },
    set lineWidth(v: number) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) {
        st.lineWidth = n;
        enqueue({ o: "lineWidth", a: [n] });
      }
    },
    // The enum setters take the IDL enum; the state keeps the keyword they
    // validated as a string.
    get lineCap(): string {
      return st.lineCap;
    },
    set lineCap(v: Idl.CanvasLineCap) {
      const s = String(v);
      if (LINE_CAPS.indexOf(s) >= 0) {
        st.lineCap = s;
        enqueue({ o: "lineCap", s });
      }
    },
    get lineJoin(): string {
      return st.lineJoin;
    },
    set lineJoin(v: Idl.CanvasLineJoin) {
      const s = String(v);
      if (LINE_JOINS.indexOf(s) >= 0) {
        st.lineJoin = s;
        enqueue({ o: "lineJoin", s });
      }
    },
    get miterLimit() {
      return st.miterLimit;
    },
    set miterLimit(v: number) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) {
        st.miterLimit = n;
        enqueue({ o: "miterLimit", a: [n] });
      }
    },
    setLineDash(segments: number[]) {
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
    set lineDashOffset(v: number) {
      const n = Number(v);
      if (Number.isFinite(n)) {
        st.lineDashOffset = n;
        enqueue({ o: "lineDashOffset", a: [n] });
      }
    },

    get font() {
      return st.font;
    },
    set font(v: string) {
      const s = String(v);
      if (s) {
        st.font = s;
        enqueue({ o: "font", s });
      }
    },
    get textAlign(): string {
      return st.textAlign;
    },
    set textAlign(v: Idl.CanvasTextAlign) {
      const s = String(v);
      if (TEXT_ALIGNS.indexOf(s) >= 0) {
        st.textAlign = s;
        enqueue({ o: "textAlign", s });
      }
    },
    get textBaseline(): string {
      return st.textBaseline;
    },
    set textBaseline(v: Idl.CanvasTextBaseline) {
      const s = String(v);
      if (TEXT_BASELINES.indexOf(s) >= 0) {
        st.textBaseline = s;
        enqueue({ o: "textBaseline", s });
      }
    },
    get imageSmoothingEnabled() {
      return st.imageSmoothingEnabled;
    },
    set imageSmoothingEnabled(v: boolean) {
      st.imageSmoothingEnabled = !!v;
      enqueue({ o: "smoothing", a: [v ? 1 : 0] });
    },
    get imageSmoothingQuality(): string {
      return st.imageSmoothingQuality;
    },
    set imageSmoothingQuality(v: Idl.ImageSmoothingQuality) {
      const s = String(v);
      if (["low", "medium", "high"].indexOf(s) >= 0) st.imageSmoothingQuality = s;
    },

    get letterSpacing() {
      return st.letterSpacing;
    },
    set letterSpacing(v: string) {
      const s = parseCssSpacing(v);
      if (s !== null) st.letterSpacing = s;
    },
    get wordSpacing() {
      return st.wordSpacing;
    },
    set wordSpacing(v: string) {
      const s = parseCssSpacing(v);
      if (s !== null) st.wordSpacing = s;
    },
    get fontKerning(): string {
      return st.fontKerning;
    },
    set fontKerning(v: Idl.CanvasFontKerning) {
      const s = String(v);
      if (["auto", "normal", "none"].indexOf(s) >= 0) st.fontKerning = s;
    },
    get fontStretch(): string {
      return st.fontStretch;
    },
    set fontStretch(v: Idl.CanvasFontStretch) {
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
    get fontVariantCaps(): string {
      return st.fontVariantCaps;
    },
    set fontVariantCaps(v: Idl.CanvasFontVariantCaps) {
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
    get textRendering(): string {
      return st.textRendering;
    },
    set textRendering(v: Idl.CanvasTextRendering) {
      const s = String(v);
      if (["auto", "optimizeSpeed", "optimizeLegibility", "geometricPrecision"].indexOf(s) >= 0)
        st.textRendering = s;
    },
    get direction(): string {
      return st.direction;
    },
    set direction(v: Idl.CanvasDirection) {
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

    setTransform(
      a?: MatrixInput | number,
      b?: number,
      c?: number,
      d?: number,
      e?: number,
      f?: number,
    ) {
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
    transform(a: number, b: number, c: number, d: number, e: number, f: number) {
      const m = [a, b, c, d, e, f].map(Number);
      if (m.some((v) => !Number.isFinite(v))) return;
      st.transform = matMul(mat(), m);
      enqueue({ o: "transform", a: m });
    },
    resetTransform() {
      st.transform = [1, 0, 0, 1, 0, 0];
      enqueue({ o: "resetTransform" });
    },
    translate(x: number, y: number) {
      const m = [Number(x), Number(y)];
      if (m.some((v) => !Number.isFinite(v))) return;
      st.transform = matMul(mat(), [1, 0, 0, 1, m[0], m[1]]);
      enqueue({ o: "translate", a: m });
    },
    scale(x: number, y: number) {
      const m = [Number(x), Number(y)];
      if (m.some((v) => !Number.isFinite(v))) return;
      st.transform = matMul(mat(), [m[0], 0, 0, m[1], 0, 0]);
      enqueue({ o: "scale", a: m });
    },
    rotate(angle: number) {
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

    fillRect(x: number, y: number, w: number, h: number) {
      enqueue({ o: "fillRect", a: [Number(x), Number(y), Number(w), Number(h)] });
    },
    strokeRect(x: number, y: number, w: number, h: number) {
      enqueue({ o: "strokeRect", a: [Number(x), Number(y), Number(w), Number(h)] });
    },
    clearRect(x: number, y: number, w: number, h: number) {
      enqueue({ o: "clearRect", a: [Number(x), Number(y), Number(w), Number(h)] });
    },

    beginPath() {
      enqueue({ o: "beginPath" });
    },
    ...pathBuilders(enqueue),
    fill(pathOrRule?: Idl.Path2D | Idl.CanvasFillRule, rule?: Idl.CanvasFillRule) {
      if (pathOrRule instanceof Path2D) withPath2D(pathOrRule, { o: "fill", s: fillRule(rule) });
      else enqueue({ o: "fill", s: fillRule(pathOrRule) });
    },
    stroke(path?: Idl.Path2D) {
      if (path instanceof Path2D) withPath2D(path, { o: "stroke" });
      else enqueue({ o: "stroke" });
    },
    clip(pathOrRule?: Idl.Path2D | Idl.CanvasFillRule, rule?: Idl.CanvasFillRule) {
      if (pathOrRule instanceof Path2D) withPath2D(pathOrRule, { o: "clip", s: fillRule(rule) });
      else enqueue({ o: "clip", s: fillRule(pathOrRule) });
    },
    isPointInPath(
      pathOrX: Idl.Path2D | number,
      xOrY?: number,
      yOrRule?: number | Idl.CanvasFillRule,
      maybeRule?: Idl.CanvasFillRule,
    ) {
      const path = pathOrX instanceof Path2D ? pathOrX : null;
      const [x, y, rule] = path ? [xOrY, yOrRule, maybeRule] : [pathOrX, xOrY, yOrRule];
      if (path) {
        enqueue({ o: "pathPush" });
        const pathOps = opsOf(path, "isPointInPath");
        for (let i = 0; i < pathOps.length; i++) enqueue(pathOps[i]);
      }
      flushOps();
      try {
        return !!dom.canvasIsPointInPath(
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
    isPointInStroke(_pathOrX: Idl.Path2D | number, _xOrY: number) {
      return false;
    },

    fillText(text: string, x: number, y: number, maxWidth?: number) {
      noteOutlineDemand();
      const a = [Number(x), Number(y)];
      if (maxWidth !== undefined) a.push(Number(maxWidth));
      enqueue({ o: "fillText", s: String(text), a });
    },
    strokeText(text: string, x: number, y: number, maxWidth?: number) {
      noteOutlineDemand();
      const a = [Number(x), Number(y)];
      if (maxWidth !== undefined) a.push(Number(maxWidth));
      enqueue({ o: "strokeText", s: String(text), a });
    },
    measureText(text: string) {
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
      if (!fontsReady) return fallback;
      try {
        // canvasMeasureText serializes the same fields as the fallback above.
        const metrics: typeof fallback = JSON.parse(
          dom.canvasMeasureText(String(text ?? ""), st.font),
        );
        return metrics;
      } catch {
        return fallback;
      }
    },

    createLinearGradient(x0: number, y0: number, x1: number, y1: number) {
      const v = [x0, y0, x1, y1].map(Number);
      if (v.some((n) => !Number.isFinite(n))) throw domExc("non-finite", "NotSupportedError");
      return new CanvasGradientShim(CANVAS_STYLE_TOKEN, { k: "linear", v, stops: [] });
    },
    createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number) {
      const v = [x0, y0, r0, x1, y1, r1].map(Number);
      if (v.some((n) => !Number.isFinite(n))) throw domExc("non-finite", "NotSupportedError");
      if (v[2] < 0 || v[5] < 0) throw domExc("negative radius", "IndexSizeError");
      return new CanvasGradientShim(CANVAS_STYLE_TOKEN, { k: "radial", v, stops: [] });
    },
    createConicGradient(startAngle: number, x: number, y: number) {
      const v = [startAngle, x, y].map(Number);
      if (v.some((n) => !Number.isFinite(n))) throw domExc("non-finite", "NotSupportedError");
      return new CanvasGradientShim(CANVAS_STYLE_TOKEN, { k: "conic", v, stops: [] });
    },
    createPattern(image: SourceWrapper | null | undefined, repetition: string) {
      const rep = repetition == null || repetition === "" ? "repeat" : String(repetition);
      if (["repeat", "repeat-x", "repeat-y", "no-repeat"].indexOf(rep) < 0) {
        throw domExc("invalid repetition", "SyntaxError");
      }
      const src = imageSource(image);
      // imageSource answers null for a missing image.
      if (!src || !image) return null;
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
      if (src.kind === "img" && !src.oc) defineFlag(spec, "oc", false);
      return new CanvasPatternShim(CANVAS_STYLE_TOKEN, spec);
    },

    drawImage(img: SourceWrapper | null | undefined, ...args: number[]) {
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
      if (src.kind === "img" && !src.oc) defineFlag(op, "oc", false);
      enqueue(op);
      flushOps();
    },

    createImageData(a: ImageDataInput | number | null | undefined, b?: number) {
      if (typeof a === "object" && a && typeof a.width === "number") {
        return makeImageData(a.width, a.height);
      }
      return makeImageData(a, b);
    },

    putImageData(img: ImageDataInput | null | undefined, dx: number, dy: number) {
      if (!img || !img.data || !img.width || !img.height) return;
      const x0 = dx | 0;
      const y0 = dy | 0;
      const iw = toInt32(img.width);
      const ih = toInt32(img.height);
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
      try {
        const data: Uint8ClampedArray = img.data;
        const bytes = new Uint8Array(data.buffer, data.byteOffset, iw * ih * 4);
        dom.canvasPutImageData(canvas._id, x0, y0, iw, ih, bytes);
      } catch (e) {
        dbg.last = "put threw: " + errorMessage(e);
      }
      schedulePush();
    },

    getImageData(sx: number, sy: number, sw: number, sh: number) {
      const w = sw | 0;
      const h = sh | 0;
      if (w <= 0 || h <= 0) throw domExc("zero-size", "IndexSizeError");
      if (!isLive()) return makeImageData(w, h);
      flushOps();
      try {
        if (!dom.canvasIsOriginClean(canvas._id)) {
          throw domExc("The canvas has been tainted by cross-origin data.", "SecurityError");
        }
      } catch (e) {
        if (e != null && Reflect.get(Object(e), "name") === "SecurityError") throw e;
        // Bridge failure — fall through to the (fail-closed)
        // wasm read; if the surface is tainted the pixels
        // still won't leak.
      }
      const out = makeImageData(w, h);
      try {
        const bytes: Uint8Array = dom.canvasGetImageData(canvas._id, sx | 0, sy | 0, w, h);
        if (bytes && bytes.length === w * h * 4) out.data.set(bytes);
      } catch (e) {
        dbg.last = "get threw: " + errorMessage(e);
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
