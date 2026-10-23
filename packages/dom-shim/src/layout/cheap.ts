// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Provides approximate block-flow geometry when full layout is disabled or unavailable.

import { dom, getRectByAuthId } from "../state.js";
import { getInternalState } from "../internal-state.js";
import type { AuthRectSnapshot } from "../state.js";
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
    const m = dom.layoutMode && dom.layoutMode();
    return m === "off" ? "off" : "full";
  } catch {
    return "full";
  }
}

function cheapViewport(): { w: number; h: number } {
  try {
    const v = dom.viewportSize && dom.viewportSize();
    if (v && v.length >= 2) {
      return viewportFromSize(v);
    }
  } catch {}
  return {
    w: DEFAULT_VIEWPORT_WIDTH_CSS_PX,
    h: DEFAULT_VIEWPORT_HEIGHT_CSS_PX,
  };
}

function viewportFromSize(size: ReturnType<typeof dom.viewportSize>): { w: number; h: number } {
  return {
    w: Number(size[0]) || DEFAULT_VIEWPORT_WIDTH_CSS_PX,
    h: Number(size[1]) || DEFAULT_VIEWPORT_HEIGHT_CSS_PX,
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
  if (includesStyleValue(value, "display:none", "display: none")) return "none";
  if (includesStyleValue(value, "display:block", "display: block")) return "block";
  if (includesStyleValue(value, "display:inline", "display: inline")) return "inline";
  return null;
}

function includesStyleValue(value: string, compact: string, spaced: string): boolean {
  return value.includes(compact) || value.includes(spaced);
}

function cheapDimension(value: string) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

interface CheapInfo {
  type: number;
  tag: string;
  text: string;
  display: "block" | "inline" | "none" | "";
  widthAttr: number;
  heightAttr: number;
}

function cheapInfo(id: number): CheapInfo {
  try {
    return cheapInfoFromNode(dom.nodeInfo(id));
  } catch {
    return emptyCheapInfo();
  }
}

function emptyCheapInfo(): CheapInfo {
  return { type: 0, tag: "", text: "", display: "", widthAttr: 0, heightAttr: 0 };
}

function cheapInfoFromNode(info: ReturnType<typeof dom.nodeInfo>): CheapInfo {
  const result: CheapInfo = {
    type: (info && info.nodeType) | 0,
    tag: nodeTag(info),
    text: nodeText(info),
    display: "",
    widthAttr: 0,
    heightAttr: 0,
  };
  const attrs = info && info.attributes;
  if (Array.isArray(attrs)) readCheapAttributes(result, attrs);
  return result;
}

function nodeTag(info: ReturnType<typeof dom.nodeInfo>): string {
  return info && typeof info.localName === "string" ? info.localName.toLowerCase() : "";
}

function nodeText(info: ReturnType<typeof dom.nodeInfo>): string {
  return info && typeof info.nodeValue === "string" ? info.nodeValue : "";
}

function readCheapAttributes(info: CheapInfo, attrs: unknown[]): void {
  for (let i = 0; i < attrs.length - 1; i += 2) {
    const name = attrs[i];
    const value = attrs[i + 1];
    if (typeof name !== "string" || typeof value !== "string") continue;
    applyCheapAttribute(info, name, value);
  }
}

function applyCheapAttribute(info: CheapInfo, name: string, value: string): void {
  switch (name) {
    case "style":
      info.display = cheapDisplayFromStyle(value) ?? info.display;
      break;
    case "width":
      info.widthAttr = cheapDimension(value) ?? info.widthAttr;
      break;
    case "height":
      info.heightAttr = cheapDimension(value) ?? info.heightAttr;
      break;
  }
}

function cheapLayoutOne(id: number, x: number, y: number, w: number): number {
  const info = cheapInfo(id);
  const childIds = cheapChildIds(id);

  if (info.type === TEXT_NODE) return layoutTextNode(id, info, x, y, w);
  if (!isElementOrDocument(info)) return layoutEmptyNode(id, x, y);
  const specialHeight = layoutHiddenOrImageNode(id, info, x, y);
  if (specialHeight !== null) return specialHeight;
  if (!isCheapBlock(info)) return layoutInlineContainer(id, childIds, x, y, w);
  return layoutBlockContainer(id, childIds, x, y, w);
}

function layoutHiddenOrImageNode(id: number, info: CheapInfo, x: number, y: number): number | null {
  if (info.display === "none") return layoutEmptyNode(id, x, y);
  if (info.tag === "img") return layoutImageNode(id, info, x, y);
  return null;
}

function isElementOrDocument(info: CheapInfo): boolean {
  return info.type === ELEMENT_NODE || info.type === DOCUMENT_NODE;
}

function layoutEmptyNode(id: number, x: number, y: number): number {
  cheapRects.set(id, { x, y, w: 0, h: 0 });
  return 0;
}

function layoutTextNode(id: number, info: CheapInfo, x: number, y: number, w: number): number {
  const textWidth = info.text.length * CHEAP_CHAR_W;
  const lines = w > 0 ? Math.max(1, Math.ceil(textWidth / Math.max(1, w))) : 1;
  const height = lines * CHEAP_LINE_H;
  cheapRects.set(id, { x, y, w: Math.min(textWidth, w), h: height });
  return height;
}

function isCheapBlock(info: CheapInfo): boolean {
  if (info.type === DOCUMENT_NODE) return true;
  if (info.display === "block") return true;
  if (info.display === "inline") return false;
  return blockTags.has(info.tag);
}

function layoutImageNode(id: number, info: CheapInfo, x: number, y: number): number {
  const width = info.widthAttr > 0 ? info.widthAttr : CHEAP_IMG_W;
  const height = info.heightAttr > 0 ? info.heightAttr : CHEAP_IMG_H;
  cheapRects.set(id, { x, y, w: width, h: height });
  return height;
}

interface InlineFlowState {
  lineX: number;
  lineMaxH: number;
  currentY: number;
  widest: number;
}

interface InlineChildLayout {
  info: CheapInfo;
  width: number;
  height: number;
}

function layoutInlineContainer(
  id: number,
  childIds: number[],
  x: number,
  y: number,
  width: number,
): number {
  const state: InlineFlowState = { lineX: 0, lineMaxH: CHEAP_LINE_H, currentY: y, widest: 0 };
  for (const childId of childIds) layoutInlineChild(childId, x, width, state);
  const height = state.currentY - y + state.lineMaxH;
  cheapRects.set(id, {
    x,
    y,
    w: Math.min(Math.max(state.widest, state.lineX), width),
    h: height,
  });
  return height;
}

function inlineChildLayout(
  childId: number,
  x: number,
  width: number,
  state: InlineFlowState,
): InlineChildLayout {
  const info = cheapInfo(childId);
  let childWidth = 0;
  let childHeight = CHEAP_LINE_H;
  if (info.type === TEXT_NODE) {
    childWidth = info.text.length * CHEAP_CHAR_W;
  } else if (info.tag === "img") {
    childWidth = CHEAP_IMG_W;
    childHeight = CHEAP_IMG_H;
  } else {
    childHeight = cheapLayoutOne(childId, x + state.lineX, state.currentY, width);
    childWidth = cheapChildRectWidth(childId);
  }
  return { info, width: childWidth, height: childHeight };
}

function layoutInlineChild(
  childId: number,
  x: number,
  width: number,
  state: InlineFlowState,
): void {
  const child = inlineChildLayout(childId, x, width, state);
  if (state.lineX + child.width > width && state.lineX > 0) {
    state.currentY += state.lineMaxH;
    state.lineX = 0;
    state.lineMaxH = CHEAP_LINE_H;
  }
  if (child.info.type === TEXT_NODE) {
    cheapRects.set(childId, {
      x: x + state.lineX,
      y: state.currentY,
      w: Math.min(child.width, width),
      h: child.height,
    });
  }
  state.lineX += child.width;
  updateInlineMaximums(child, state);
}

function updateInlineMaximums(child: InlineChildLayout, state: InlineFlowState): void {
  if (child.width > state.widest) state.widest = child.width;
  if (child.height > state.lineMaxH) state.lineMaxH = child.height;
}

interface BlockFlowState {
  cursorY: number;
  lineX: number;
  lineH: number;
}

function layoutBlockContainer(
  id: number,
  childIds: number[],
  x: number,
  y: number,
  width: number,
): number {
  const state: BlockFlowState = { cursorY: y, lineX: 0, lineH: 0 };
  for (const childId of childIds) applyBlockChild(childId, x, width, state);
  flushBlockInlineLine(state);
  const height = Math.max(state.cursorY - y, CHEAP_LINE_H);
  cheapRects.set(id, { x, y, w: width, h: height });
  return height;
}

function applyBlockChild(childId: number, x: number, width: number, state: BlockFlowState): void {
  const info = cheapInfo(childId);
  if (info.type === ELEMENT_NODE && blockTags.has(info.tag)) {
    flushBlockInlineLine(state);
    state.cursorY += cheapLayoutOne(childId, x, state.cursorY, width);
    return;
  }
  if (info.type === TEXT_NODE) {
    layoutBlockTextChild(childId, info, x, width, state);
    return;
  }
  if (info.type === ELEMENT_NODE) layoutBlockElementChild(childId, x, width, state);
}

function layoutBlockTextChild(
  childId: number,
  info: CheapInfo,
  x: number,
  width: number,
  state: BlockFlowState,
): void {
  const textWidth = info.text.length * CHEAP_CHAR_W;
  if (state.lineX + textWidth > width && state.lineX > 0) {
    state.cursorY += CHEAP_LINE_H;
    state.lineX = 0;
  }
  cheapRects.set(childId, {
    x: x + state.lineX,
    y: state.cursorY,
    w: Math.min(textWidth, width),
    h: CHEAP_LINE_H,
  });
  state.lineX += textWidth;
  if (CHEAP_LINE_H > state.lineH) state.lineH = CHEAP_LINE_H;
  if (state.lineX >= width) {
    state.cursorY += CHEAP_LINE_H;
    state.lineX = 0;
    state.lineH = 0;
  }
}

function layoutBlockElementChild(
  childId: number,
  x: number,
  width: number,
  state: BlockFlowState,
): void {
  const height = cheapLayoutOne(childId, x + state.lineX, state.cursorY, width - state.lineX);
  const childWidth = cheapChildRectWidth(childId);
  if (state.lineX + childWidth > width && state.lineX > 0) {
    flushBlockInlineLine(state);
    cheapLayoutOne(childId, x, state.cursorY, width);
    state.lineX += cheapChildRectWidth(childId);
    increaseBlockLineHeight(state, height);
  } else {
    state.lineX += childWidth;
    increaseBlockLineHeight(state, height);
  }
}

function cheapChildRectWidth(childId: number): number {
  const rect = cheapRects.get(childId);
  return rect ? rect.w : 0;
}

function increaseBlockLineHeight(state: BlockFlowState, height: number): void {
  if (height > state.lineH) state.lineH = height;
}

function flushBlockInlineLine(state: BlockFlowState): void {
  if (state.lineX > 0 || state.lineH > 0) {
    state.cursorY += state.lineH || CHEAP_LINE_H;
    state.lineX = 0;
    state.lineH = 0;
  }
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
    if (!containsCheapPoint(r, x, y)) return;
    if (!hasPositiveCheapArea(r)) return;
    const info = cheapInfo(id);
    if (!isElementOrDocument(info)) return;
    const area = r.w * r.h;
    if (area < bestArea) {
      bestArea = area;
      bestId = id;
    }
  });
  return bestId;
}

function containsCheapPoint(
  rect: { x: number; y: number; w: number; h: number },
  x: number,
  y: number,
): boolean {
  return !(x < rect.x || x >= rect.x + rect.w || y < rect.y || y >= rect.y + rect.h);
}

function hasPositiveCheapArea(rect: { w: number; h: number }): boolean {
  return rect.w > 0 && rect.h > 0;
}

export function hasLayoutBox(nodeId: number): boolean {
  if (isInvalidLayoutNodeId(nodeId)) return true;
  try {
    const rect = readLayoutRect(nodeId, getRectByAuthId);
    if (hasNegativeRect(rect)) return false;
  } catch {}
  return true;
}

type AuthRect = AuthRectSnapshot | null | undefined;
type RectCallback = NonNullable<typeof getRectByAuthId>;
type ViewportRect = { x: number; y: number; width: number; height: number };
type ScrollOffset = { x: number; y: number };

interface WasmRectLike {
  x: number | null | undefined;
  y: number | null | undefined;
  width: number | null | undefined;
  height: number | null | undefined;
}

function isInvalidLayoutNodeId(nodeId: number): boolean {
  return typeof nodeId !== "number" || nodeId < 0;
}

function readLayoutRect(nodeId: number, getAuthRect: typeof getRectByAuthId): AuthRect {
  return getAuthRect ? getAuthRect(nodeId) : (dom as any).getBoundingClientRect(nodeId);
}

function hasNegativeRect(rect: AuthRect): boolean {
  return !!rect && (rect.width < 0 || rect.height < 0);
}

function hasAuthRectBox(rect: AuthRect): rect is AuthRectSnapshot {
  return !!rect && (rect.hasBox === true || rect.width > 0 || rect.height > 0);
}

function emptyRect(): ViewportRect {
  return { x: 0, y: 0, width: 0, height: 0 };
}

function normalizeAuthRect(rect: AuthRectSnapshot): ViewportRect {
  return {
    x: rect.x ?? 0,
    y: rect.y ?? 0,
    width: rect.width ?? 0,
    height: rect.height ?? 0,
  };
}

function normalizeWasmRect(rect: WasmRectLike): ViewportRect {
  return {
    x: rect.x ?? 0,
    y: rect.y ?? 0,
    width: rect.width ?? 0,
    height: rect.height ?? 0,
  };
}

function viewportRect(rect: ViewportRect, scroll: ScrollOffset): ViewportRect {
  return {
    x: rect.x - scroll.x,
    y: rect.y - scroll.y,
    width: rect.width,
    height: rect.height,
  };
}

function readAuthorizedRect(nodeId: number, getAuthRect: RectCallback): ViewportRect | null {
  try {
    const rect = getAuthRect(nodeId);
    if (hasNegativeRect(rect)) return emptyRect();
    if (hasAuthRectBox(rect)) return normalizeAuthRect(rect);
  } catch {}
  return null;
}

function authorizedRectOrFallback(nodeId: number, getAuthRect: RectCallback): ViewportRect {
  const rect = readAuthorizedRect(nodeId, getAuthRect);
  if (rect) return rect;
  return cheapRectOrEmpty(nodeId);
}

function readCheapRect(nodeId: number): ViewportRect | null {
  cheapLayoutEnsure();
  const rect = cheapRects.get(nodeId);
  if (!rect) return null;
  return { x: rect.x, y: rect.y, width: rect.w, height: rect.h };
}

function cheapRectOrEmpty(nodeId: number): ViewportRect {
  try {
    const rect = readCheapRect(nodeId);
    if (rect) return rect;
  } catch {}
  return emptyRect();
}

function cheapViewportRect(nodeId: number, scroll: ScrollOffset): ViewportRect {
  const rect = readCheapRect(nodeId);
  return rect ? viewportRect(rect, scroll) : emptyRect();
}

function cheapViewportRectOrEmpty(nodeId: number, scroll: ScrollOffset): ViewportRect {
  try {
    return cheapViewportRect(nodeId, scroll);
  } catch {
    return emptyRect();
  }
}

function localRect(nodeId: number): ViewportRect {
  const scroll = scrollOffset();
  if (layoutMode() === "off") return cheapViewportRect(nodeId, scroll);
  return wasmRectOrFallback(nodeId, scroll);
}

function wasmRectOrFallback(nodeId: number, scroll: ScrollOffset): ViewportRect {
  try {
    const rect = (dom as any).getBoundingClientRect(nodeId);
    if (hasNegativeRect(rect)) return emptyRect();
    return viewportRect(normalizeWasmRect(rect), scroll);
  } catch {
    return cheapViewportRectOrEmpty(nodeId, scroll);
  }
}

export function getRect(nodeId: number): ViewportRect {
  if (isInvalidLayoutNodeId(nodeId)) return emptyRect();
  if (getRectByAuthId) return authorizedRectOrFallback(nodeId, getRectByAuthId);
  return localRect(nodeId);
}
