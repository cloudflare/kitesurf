// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements DOMRect, DOMRectReadOnly, and DOMRectList wrappers for geometry results.

import type * as Idl from "../idl/types.generated.js";

type RectState = { x: number; y: number; width: number; height: number };
const rectStates = new WeakMap<object, RectState>();
function rectState(rect: object): RectState {
  const state = rectStates.get(rect);
  if (!state) throw new TypeError("Illegal invocation");
  return state;
}
type RectInit = { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
type RectInitValues = [x: unknown, y: unknown, width: unknown, height: unknown];

function rectInitValues(other?: RectInit | null): RectInitValues {
  const position = rectPositionValues(other);
  const size = rectSizeValues(other);
  return [position[0], position[1], size[0], size[1]];
}

function rectPositionValues(other?: RectInit | null): [x: unknown, y: unknown] {
  return [other?.x ?? 0, other?.y ?? 0];
}

function rectSizeValues(other?: RectInit | null): [width: unknown, height: unknown] {
  return [other?.width ?? 0, other?.height ?? 0];
}

export class DOMRectReadOnly implements Idl.DOMRectReadOnly {
  constructor(x: unknown = 0, y: unknown = 0, width: unknown = 0, height: unknown = 0) {
    rectStates.set(this, {
      x: Number(x),
      y: Number(y),
      width: Number(width),
      height: Number(height),
    });
  }
  static fromRect(other?: RectInit | null): DOMRectReadOnly {
    return new this(...rectInitValues(other));
  }
  get x() {
    return rectState(this).x;
  }
  get y() {
    return rectState(this).y;
  }
  get width() {
    return rectState(this).width;
  }
  get height() {
    return rectState(this).height;
  }
  get top() {
    const s = rectState(this);
    return Math.min(s.y, s.y + s.height);
  }
  get right() {
    const s = rectState(this);
    return Math.max(s.x, s.x + s.width);
  }
  get bottom() {
    const s = rectState(this);
    return Math.max(s.y, s.y + s.height);
  }
  get left() {
    const s = rectState(this);
    return Math.min(s.x, s.x + s.width);
  }
  toJSON() {
    return {
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
      top: this.top,
      right: this.right,
      bottom: this.bottom,
      left: this.left,
    };
  }
}
export class DOMRect extends DOMRectReadOnly implements Idl.DOMRect {
  static fromRect(other?: RectInit | null): DOMRect {
    return new this(...rectInitValues(other));
  }
  get x() {
    return rectState(this).x;
  }
  set x(v: number) {
    rectState(this).x = Number(v);
  }
  get y() {
    return rectState(this).y;
  }
  set y(v: number) {
    rectState(this).y = Number(v);
  }
  get width() {
    return rectState(this).width;
  }
  set width(v: number) {
    rectState(this).width = Number(v);
  }
  get height() {
    return rectState(this).height;
  }
  set height(v: number) {
    rectState(this).height = Number(v);
  }
}
function makeDomRect(x: number, y: number, w: number, h: number): DOMRect {
  return new DOMRect(x, y, w, h);
}

const DOMRectListToken = Symbol("kitesurfDOMRectList");
export class DOMRectList implements Idl.DOMRectList {
  readonly [index: number]: Idl.DOMRect | null;
  readonly #rects: readonly Idl.DOMRect[];
  constructor(rects: readonly Idl.DOMRect[], token?: symbol) {
    if (token !== DOMRectListToken) throw new TypeError("Illegal constructor");
    this.#rects = rects;
    for (let i = 0; i < rects.length; i++) {
      Object.defineProperty(this, i, {
        value: rects[i],
        writable: false,
        enumerable: true,
        configurable: true,
      });
    }
  }
  get length() {
    return this.#rects.length;
  }
  item(index: number) {
    return this.#rects[index] ?? null;
  }
  *[Symbol.iterator](): IterableIterator<Idl.DOMRect> {
    yield* this.#rects;
  }
}
function makeDomRectList(rects: readonly Idl.DOMRect[]): DOMRectList {
  return new DOMRectList(rects, DOMRectListToken);
}

export { makeDomRect, makeDomRectList };
