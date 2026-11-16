// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Provides approximate block-flow geometry when full layout is disabled or unavailable.

import type { KsLayoutRect } from "../../../core/pkg/kitesurf_core";
import { dom, getRectByAuthId } from "../state.js";
import { getInternalState } from "../internal-state.js";
import {
  DEFAULT_VIEWPORT_HEIGHT_CSS_PX,
  DEFAULT_VIEWPORT_WIDTH_CSS_PX,
  TEXT_NODE,
  ELEMENT_NODE,
  DOCUMENT_NODE,
} from "../constants.js";
import { scrollOffset } from "./scroll.js";

const blockTags = new Set([
  "html",
  "body",
  "div",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "section",
  "article",
  "header",
  "footer",
  "nav",
  "main",
  "aside",
  "blockquote",
  "pre",
  "address",
  "figure",
  "figcaption",
  "hr",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "form",
  "fieldset",
  "details",
  "summary",
]);

const CHEAP_LINE_H = 16;
const CHEAP_CHAR_W = 8;
const CHEAP_IMG_W = 100;
const CHEAP_IMG_H = 100;

export const cheapRects = new Map<number, { x: number; y: number; w: number; h: number }>();
let cheapLayoutSeq = -1;

export function layoutMode(): "full" | "off" {
  try {
    const m = dom.layoutMode();
    return m === "off" ? "off" : "full";
  } catch {
    return "full";
  }
}

function cheapViewport(): { w: number; h: number } {
  try {
    const v = dom.viewportSize();
    if (v && v.length >= 2) {
      return {
        w: Number(v[0]) || DEFAULT_VIEWPORT_WIDTH_CSS_PX,
        h: Number(v[1]) || DEFAULT_VIEWPORT_HEIGHT_CSS_PX,
      };
    }
  } catch {}
  return {
    w: DEFAULT_VIEWPORT_WIDTH_CSS_PX,
    h: DEFAULT_VIEWPORT_HEIGHT_CSS_PX,
  };
}

function cheapChildIds(id: number): number[] {
  try {
    const ids = dom.childIds(id);
    return ids ? Array.from(ids) : [];
  } catch {
    return [];
  }
}

function cheapDisplayFromStyle(style: string) {
  const value = style.toLowerCase();
  if (value.includes("display:none") || value.includes("display: none")) return "none";
  if (value.includes("display:block") || value.includes("display: block")) return "block";
  if (value.includes("display:inline") || value.includes("display: inline")) return "inline";
  return null;
}

function cheapDimension(value: string) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function cheapInfo(id: number): {
  type: number;
  tag: string;
  text: string;
  display: "block" | "inline" | "none" | "";
  widthAttr: number;
  heightAttr: number;
} {
  try {
    const info = dom.nodeInfo(id);
    const type = (info?.nodeType ?? 0) | 0;
    const tag = info && typeof info.localName === "string" ? info.localName.toLowerCase() : "";
    const text = info && typeof info.nodeValue === "string" ? info.nodeValue : "";
    let display: "block" | "inline" | "none" | "" = "";
    let widthAttr = 0;
    let heightAttr = 0;
    const attrs = info && info.attributes;
    if (Array.isArray(attrs)) {
      for (let i = 0; i < attrs.length - 1; i += 2) {
        const k = attrs[i];
        const v = attrs[i + 1];
        if (typeof k !== "string" || typeof v !== "string") continue;
        if (k === "style") {
          display = cheapDisplayFromStyle(v) ?? display;
        } else if (k === "width") {
          widthAttr = cheapDimension(v) ?? widthAttr;
        } else if (k === "height") {
          heightAttr = cheapDimension(v) ?? heightAttr;
        }
      }
    }
    return { type, tag, text, display, widthAttr, heightAttr };
  } catch {
    return { type: 0, tag: "", text: "", display: "", widthAttr: 0, heightAttr: 0 };
  }
}

function cheapLayoutOne(id: number, x: number, y: number, w: number): number {
  const info = cheapInfo(id);
  const childIds = cheapChildIds(id);

  if (info.type === TEXT_NODE) {
    const tw = info.text.length * CHEAP_CHAR_W;
    const lines = w > 0 ? Math.max(1, Math.ceil(tw / Math.max(1, w))) : 1;
    const h = lines * CHEAP_LINE_H;
    cheapRects.set(id, { x, y, w: Math.min(tw, w), h });
    return h;
  }

  if (info.type !== ELEMENT_NODE && info.type !== DOCUMENT_NODE) {
    cheapRects.set(id, { x, y, w: 0, h: 0 });
    return 0;
  }

  // The page parses with scripting on, so a noscript holds its fallback as raw text that the
  // full layout's UA rule hides; laying that text out here would give it a box.
  if (info.display === "none" || info.tag === "noscript") {
    cheapRects.set(id, { x, y, w: 0, h: 0 });
    return 0;
  }

  let isBlock: boolean;
  if (info.type === DOCUMENT_NODE) {
    isBlock = true;
  } else if (info.display === "block") {
    isBlock = true;
  } else if (info.display === "inline") {
    isBlock = false;
  } else {
    isBlock = blockTags.has(info.tag);
  }

  if (info.tag === "img") {
    const iw = info.widthAttr > 0 ? info.widthAttr : CHEAP_IMG_W;
    const ih = info.heightAttr > 0 ? info.heightAttr : CHEAP_IMG_H;
    cheapRects.set(id, { x, y, w: iw, h: ih });
    return ih;
  }

  if (!isBlock) {
    let lineX = 0;
    let lineMaxH = CHEAP_LINE_H;
    let curY = y;
    let widest = 0;
    for (const childId of childIds) {
      const childInfo = cheapInfo(childId);
      let childW = 0;
      let childH = CHEAP_LINE_H;
      if (childInfo.type === TEXT_NODE) {
        childW = childInfo.text.length * CHEAP_CHAR_W;
      } else if (childInfo.tag === "img") {
        childW = CHEAP_IMG_W;
        childH = CHEAP_IMG_H;
      } else {
        childH = cheapLayoutOne(childId, x + lineX, curY, w);
        const childRect = cheapRects.get(childId);
        childW = childRect ? childRect.w : 0;
      }
      if (lineX + childW > w && lineX > 0) {
        curY += lineMaxH;
        lineX = 0;
        lineMaxH = CHEAP_LINE_H;
      }
      if (childInfo.type === TEXT_NODE) {
        cheapRects.set(childId, {
          x: x + lineX,
          y: curY,
          w: Math.min(childW, w),
          h: childH,
        });
      }
      lineX += childW;
      if (childW > widest) widest = childW;
      if (childH > lineMaxH) lineMaxH = childH;
    }
    const totalH = curY - y + lineMaxH;
    cheapRects.set(id, {
      x,
      y,
      w: Math.min(Math.max(widest, lineX), w),
      h: totalH,
    });
    return totalH;
  }

  let cursorY = y;
  let lineX = 0;
  let lineH = 0;
  const flushInlineLine = () => {
    if (lineX > 0 || lineH > 0) {
      cursorY += lineH || CHEAP_LINE_H;
      lineX = 0;
      lineH = 0;
    }
  };
  for (const childId of childIds) {
    const childInfo = cheapInfo(childId);
    const childIsBlock = childInfo.type === ELEMENT_NODE && blockTags.has(childInfo.tag);
    if (childIsBlock) {
      flushInlineLine();
      const ch = cheapLayoutOne(childId, x, cursorY, w);
      cursorY += ch;
    } else if (childInfo.type === TEXT_NODE) {
      const tw = childInfo.text.length * CHEAP_CHAR_W;
      if (lineX + tw > w && lineX > 0) {
        cursorY += CHEAP_LINE_H;
        lineX = 0;
      }
      cheapRects.set(childId, {
        x: x + lineX,
        y: cursorY,
        w: Math.min(tw, w),
        h: CHEAP_LINE_H,
      });
      lineX += tw;
      if (CHEAP_LINE_H > lineH) lineH = CHEAP_LINE_H;
      if (lineX >= w) {
        cursorY += CHEAP_LINE_H;
        lineX = 0;
        lineH = 0;
      }
    } else if (childInfo.type === ELEMENT_NODE) {
      const ch = cheapLayoutOne(childId, x + lineX, cursorY, w - lineX);
      const childRect = cheapRects.get(childId);
      const cw = childRect ? childRect.w : 0;
      if (lineX + cw > w && lineX > 0) {
        cursorY += lineH || CHEAP_LINE_H;
        lineX = 0;
        lineH = 0;
        cheapLayoutOne(childId, x, cursorY, w);
        const r2 = cheapRects.get(childId);
        const cw2 = r2 ? r2.w : 0;
        lineX += cw2;
        if (ch > lineH) lineH = ch;
      } else {
        lineX += cw;
        if (ch > lineH) lineH = ch;
      }
    }
  }
  flushInlineLine();
  const totalH = Math.max(cursorY - y, CHEAP_LINE_H);
  cheapRects.set(id, { x, y, w, h: totalH });
  return totalH;
}

export function cheapLayoutEnsure(): void {
  const seq = getInternalState().mutationSeq | 0;
  if (seq === cheapLayoutSeq && cheapRects.size > 0) return;
  cheapRects.clear();
  const vp = cheapViewport();
  const docId = (() => {
    try {
      return dom.documentNodeId() | 0;
    } catch {
      return 0;
    }
  })();
  cheapRects.set(docId, { x: 0, y: 0, w: vp.w, h: vp.h });
  const rootKids = cheapChildIds(docId);
  let cursorY = 0;
  for (const kid of rootKids) {
    const kh = cheapLayoutOne(kid, 0, cursorY, vp.w);
    cursorY += kh;
  }
  cheapLayoutSeq = seq;
}

export function cheapHit(x: number, y: number): number {
  cheapLayoutEnsure();
  let bestId = -1;
  let bestArea = Infinity;
  cheapRects.forEach((r, id) => {
    if (x < r.x || x >= r.x + r.w || y < r.y || y >= r.y + r.h) return;
    if (r.w <= 0 || r.h <= 0) return;
    const info = cheapInfo(id);
    if (info.type !== ELEMENT_NODE && info.type !== DOCUMENT_NODE) return;
    const area = r.w * r.h;
    if (area < bestArea) {
      bestArea = area;
      bestId = id;
    }
  });
  return bestId;
}

export function hasLayoutBox(nodeId: number): boolean {
  if (typeof nodeId !== "number" || nodeId < 0) return true;
  try {
    const rect = getRectByAuthId ? getRectByAuthId(nodeId) : dom.getBoundingClientRect(nodeId);
    if (rect && (rect.width < 0 || rect.height < 0)) return false;
  } catch {}
  return true;
}

export function getRect(nodeId: number): { x: number; y: number; width: number; height: number } {
  if (typeof nodeId !== "number" || nodeId < 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  if (getRectByAuthId) {
    try {
      const rect = getRectByAuthId(nodeId);
      if (rect && (rect.width < 0 || rect.height < 0)) {
        return { x: 0, y: 0, width: 0, height: 0 };
      }
      if (rect && (rect.hasBox === true || rect.width > 0 || rect.height > 0)) {
        return {
          x: rect.x ?? 0,
          y: rect.y ?? 0,
          width: rect.width ?? 0,
          height: rect.height ?? 0,
        };
      }
    } catch {}
    try {
      cheapLayoutEnsure();
      const rect = cheapRects.get(nodeId);
      if (rect) return { x: rect.x, y: rect.y, width: rect.w, height: rect.h };
    } catch {}
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const scroll = scrollOffset();
  const toViewport = (rect: { x: number; y: number; width: number; height: number }) => ({
    x: rect.x - scroll.x,
    y: rect.y - scroll.y,
    width: rect.width,
    height: rect.height,
  });
  if (layoutMode() === "off") {
    cheapLayoutEnsure();
    const rect = cheapRects.get(nodeId);
    if (rect) return toViewport({ x: rect.x, y: rect.y, width: rect.w, height: rect.h });
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  let rect: KsLayoutRect | null = null;
  try {
    rect = dom.getBoundingClientRect(nodeId);
  } catch {}
  if (rect) {
    if (rect.width < 0 || rect.height < 0) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    return toViewport({
      x: rect.x ?? 0,
      y: rect.y ?? 0,
      width: rect.width ?? 0,
      height: rect.height ?? 0,
    });
  }
  // Serve from the cheap cache if the wasm layout query throws, or
  // returns null because the document is borrowed.
  try {
    cheapLayoutEnsure();
    const cheap = cheapRects.get(nodeId);
    if (cheap) return toViewport({ x: cheap.x, y: cheap.y, width: cheap.w, height: cheap.h });
  } catch {}
  return { x: 0, y: 0, width: 0, height: 0 };
}
