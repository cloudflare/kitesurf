// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Handles document and element scroll offsets, wheel chaining, and trusted scroll events.

import { ksGlobal, dom, WINDOW_KEY, opts, nodeFor } from "../state.js";
import type { AuthScrollInfoSnapshot, BuildDocumentOpts } from "../state.js";
import {
  elementScrollendSeq,
  bumpScrollendSeq,
  scrollendSeq,
  localScrollX,
  localScrollY,
  setLocalScroll,
} from "../registries.js";
import { bumpMutationSeq, markDamageNode } from "../mutations/seq.js";
import { KsEvent } from "../events/event.js";
import { dispatchTrustedEvent, dispatchTrustedOnKey } from "../events/dispatch.js";
import { MAX_SCROLL_CHAIN_HOPS } from "../constants.js";

const WHEEL_SCROLL_REMAINDER_EPSILON_CSS_PX = 0.5;

type ScrollOffset = NonNullable<ReturnType<NonNullable<BuildDocumentOpts["getScrollOffset"]>>>;

function getScrollOffsetCb() {
  return opts && typeof opts.getScrollOffset === "function" ? opts.getScrollOffset : null;
}
function setScrollOffsetCb() {
  return opts && typeof opts.setScrollOffset === "function" ? opts.setScrollOffset : null;
}
function setWheelScrollOffsetCb() {
  return opts && typeof opts.setWheelScrollOffset === "function"
    ? opts.setWheelScrollOffset
    : setScrollOffsetCb();
}
function getScrollInfoByAuthIdCb() {
  return opts && typeof opts.getScrollInfoByAuthId === "function"
    ? opts.getScrollInfoByAuthId
    : null;
}
function scrollOffset(): ScrollOffset {
  const offsetCb = getScrollOffsetCb();
  if (offsetCb) {
    try {
      const v = offsetCb();
      if (v) return scrollOffsetFromValue(v);
    } catch {}
  }
  return { x: localScrollX, y: localScrollY };
}

function scrollOffsetFromValue(value: ScrollOffset): ScrollOffset {
  return { x: Number(value.x) || 0, y: Number(value.y) || 0 };
}

function nodeScrollInfoSafe(nodeId: number): AuthScrollInfoSnapshot | null {
  const scrollInfoCb = getScrollInfoByAuthIdCb();
  if (scrollInfoCb) {
    const layoutInfo = authScrollInfo(nodeId, scrollInfoCb);
    if (layoutInfo) return layoutInfo;
  }
  return wasmScrollInfoFallback(nodeId);
}

function authScrollInfo(
  nodeId: number,
  getScrollInfo: NonNullable<ReturnType<typeof getScrollInfoByAuthIdCb>>,
): AuthScrollInfoSnapshot | null {
  try {
    const layoutInfo = getScrollInfo(nodeId);
    if (!layoutInfo || typeof layoutInfo !== "object") return null;
    const wasmInfo = wasmScrollPositionInfo(nodeId);
    return mergeScrollInfo(layoutInfo, wasmInfo);
  } catch {
    return null;
  }
}

function wasmScrollPositionInfo(nodeId: number) {
  try {
    return (dom as any).nodeScrollInfo(nodeId);
  } catch {
    return null;
  }
}

function wasmScrollInfoFallback(nodeId: number): AuthScrollInfoSnapshot | null {
  try {
    const info = (dom as any).nodeScrollInfo(nodeId);
    if (info && typeof info === "object") return info;
  } catch {}
  return null;
}

function mergeScrollInfo(
  layoutInfo: AuthScrollInfoSnapshot,
  wasmInfo: ReturnType<typeof wasmScrollPositionInfo>,
): AuthScrollInfoSnapshot {
  const position = scrollPositionValues(layoutInfo, wasmInfo);
  const extents = scrollExtents(layoutInfo);
  const clients = clientMetrics(layoutInfo);
  const contents = contentMetrics(layoutInfo);
  const state = scrollState(layoutInfo);
  return { ...position, ...extents, ...clients, ...contents, ...state };
}

function scrollPositionValues(
  layoutInfo: AuthScrollInfoSnapshot,
  wasmInfo: ReturnType<typeof wasmScrollPositionInfo>,
): Pick<AuthScrollInfoSnapshot, "scrollTop" | "scrollLeft"> {
  return {
    scrollTop: scrollTopValue(layoutInfo, wasmInfo),
    scrollLeft: scrollLeftValue(layoutInfo, wasmInfo),
  };
}

function scrollTopValue(
  layoutInfo: AuthScrollInfoSnapshot,
  wasmInfo: ReturnType<typeof wasmScrollPositionInfo>,
): number {
  return wasmInfo?.scrollTop ?? layoutInfo.scrollTop ?? 0;
}

function scrollLeftValue(
  layoutInfo: AuthScrollInfoSnapshot,
  wasmInfo: ReturnType<typeof wasmScrollPositionInfo>,
): number {
  return wasmInfo?.scrollLeft ?? layoutInfo.scrollLeft ?? 0;
}

function scrollExtents(
  info: AuthScrollInfoSnapshot,
): Pick<AuthScrollInfoSnapshot, "scrollWidth" | "scrollHeight"> {
  return { scrollWidth: info.scrollWidth ?? 0, scrollHeight: info.scrollHeight ?? 0 };
}

function clientMetrics(
  info: AuthScrollInfoSnapshot,
): Pick<AuthScrollInfoSnapshot, "clientWidth" | "clientHeight" | "clientTop" | "clientLeft"> {
  return {
    clientWidth: info.clientWidth ?? 0,
    clientHeight: info.clientHeight ?? 0,
    clientTop: info.clientTop ?? 0,
    clientLeft: info.clientLeft ?? 0,
  };
}

function contentMetrics(
  info: AuthScrollInfoSnapshot,
): Pick<AuthScrollInfoSnapshot, "contentWidth" | "contentHeight"> {
  return {
    contentWidth: info.contentWidth ?? info.clientWidth ?? 0,
    contentHeight: info.contentHeight ?? info.clientHeight ?? 0,
  };
}

function scrollState(
  info: AuthScrollInfoSnapshot,
): Pick<
  AuthScrollInfoSnapshot,
  | "hasBox"
  | "overflowsX"
  | "overflowsY"
  | "userScrollableX"
  | "userScrollableY"
  | "stopScrollChainX"
  | "stopScrollChainY"
> {
  return {
    hasBox: info.hasBox ?? false,
    overflowsX: !!info.overflowsX,
    overflowsY: !!info.overflowsY,
    userScrollableX: !!info.userScrollableX,
    userScrollableY: !!info.userScrollableY,
    stopScrollChainX: !!info.stopScrollChainX,
    stopScrollChainY: !!info.stopScrollChainY,
  };
}

function fireElementScroll(el: any): void {
  const id: number = el._id;
  if (id == null) return;
  try {
    const ev = new KsEvent("scroll", {
      bubbles: false,
      cancelable: false,
    });
    dispatchTrustedEvent(el, ev);
  } catch {}
  const cur = (elementScrollendSeq.get(id) ?? 0) + 1;
  elementScrollendSeq.set(id, cur);
  const fire = () => {
    if (elementScrollendSeq.get(id) !== cur) return;
    try {
      const ev = new KsEvent("scrollend", {
        bubbles: false,
        cancelable: false,
      });
      dispatchTrustedEvent(el, ev);
    } catch {}
  };
  const rAF = ksGlobal.requestAnimationFrame;
  if (typeof rAF === "function") rAF(fire);
  else Promise.resolve().then(() => setTimeout(fire, 0));
}

function wheelTarget(before: number, delta: number, maximum: number, cell: number): number {
  let movement = Math.max(-before, Math.min(delta, maximum - before));
  if (cell > 0) movement = Math.trunc(movement / cell) * cell;
  return before + movement;
}

interface WheelScrollState {
  remainingX: number;
  remainingY: number;
  handled: boolean;
}

function wheelRemainderIsSmall(state: WheelScrollState) {
  return (
    Math.abs(state.remainingX) < WHEEL_SCROLL_REMAINDER_EPSILON_CSS_PX &&
    Math.abs(state.remainingY) < WHEEL_SCROLL_REMAINDER_EPSILON_CSS_PX
  );
}

function stopWheelScrollChain(info: AuthScrollInfoSnapshot, state: WheelScrollState) {
  stopWheelAxis(info.userScrollableX, info.stopScrollChainX, state, "remainingX");
  stopWheelAxis(info.userScrollableY, info.stopScrollChainY, state, "remainingY");
}

function stopWheelAxis(
  userScrollable: boolean,
  stopChain: boolean,
  state: WheelScrollState,
  remainder: "remainingX" | "remainingY",
): void {
  if (userScrollable && stopChain && state[remainder] !== 0) {
    state[remainder] = 0;
    state.handled = true;
  }
}

function scrollNodeByWheel(
  nodeId: number,
  info: AuthScrollInfoSnapshot,
  state: WheelScrollState,
  cellX: number,
  cellY: number,
) {
  const canX = canWheelAxisScroll(info.userScrollableX, info.scrollWidth);
  const canY = canWheelAxisScroll(info.userScrollableY, info.scrollHeight);
  if (!hasWheelMovement(canX, canY, state)) return false;

  const beforeX = info.scrollLeft;
  const beforeY = info.scrollTop;
  const targetX = wheelTargetOnAxis(canX, beforeX, state.remainingX, info.scrollWidth, cellX);
  const targetY = wheelTargetOnAxis(canY, beforeY, state.remainingY, info.scrollHeight, cellY);
  if (wheelTargetsUnchanged(targetX, targetY, beforeX, beforeY)) {
    stopWheelScrollChain(info, state);
    return false;
  }

  const offset = setNodeScrollOffset(nodeId, targetX, targetY);
  if (!offset) {
    stopWheelScrollChain(info, state);
    return false;
  }

  state.handled = true;
  markDamageNode(nodeId);
  bumpMutationSeq("paint");
  fireScrollForNode(nodeId);
  state.remainingX -= targetX - beforeX;
  state.remainingY -= targetY - beforeY;
  if (wheelRemainderIsSmall(state)) return true;
  stopWheelScrollChain(info, state);
  return false;
}

function canWheelAxisScroll(userScrollable: boolean, scrollWidth: number): boolean {
  return userScrollable && scrollWidth > 0;
}

function hasWheelMovement(canX: boolean, canY: boolean, state: WheelScrollState): boolean {
  return (canX && state.remainingX !== 0) || (canY && state.remainingY !== 0);
}

function wheelTargetOnAxis(
  canScroll: boolean,
  before: number,
  remaining: number,
  maximum: number,
  cell: number,
): number {
  return canScroll ? wheelTarget(before, remaining, maximum, cell) : before;
}

function wheelTargetsUnchanged(
  targetX: number,
  targetY: number,
  beforeX: number,
  beforeY: number,
): boolean {
  return targetX === beforeX && targetY === beforeY;
}

function setNodeScrollOffset(nodeId: number, x: number, y: number): unknown {
  try {
    return dom.setNodeScrollOffset(nodeId, x, y);
  } catch {
    return null;
  }
}

function fireScrollForNode(nodeId: number): void {
  try {
    const element = nodeFor(nodeId);
    if (element) fireElementScroll(element);
  } catch {}
}

function scrollByWheel(hitNodeId: number, dx: number, dy: number): boolean {
  const state: WheelScrollState = { remainingX: dx, remainingY: dy, handled: false };
  const cellX = Math.max(0, Number(ksGlobal.__ks_tty_cell_w) || 0);
  const cellY = Math.max(0, Number(ksGlobal.__ks_tty_cell_h) || 0);
  const htmlId = dom.querySelector("html");
  walkScrollChain(hitNodeId, htmlId, state, cellX, cellY);
  if (hasWheelRemainder(state)) {
    const offs = scrollOffset();
    setScrollOffset(
      offs.x + state.remainingX,
      offs.y + state.remainingY,
      true,
      setWheelScrollOffsetCb(),
    );
    state.handled = true;
  }
  return state.handled;
}

function walkScrollChain(
  hitNodeId: number,
  htmlId: number,
  state: WheelScrollState,
  cellX: number,
  cellY: number,
): void {
  let cur = hitNodeId;
  let safety = 0;
  while (isScrollChainNode(cur, htmlId, safety)) {
    safety++;
    const step = scrollChainStep(cur, state, cellX, cellY);
    if (step.finished) return;
    const parentId = step.parentId;
    if (parentId === null) return;
    cur = parentId;
  }
}

function isScrollChainNode(cur: number | null, htmlId: number, safety: number): cur is number {
  return cur != null && cur >= 0 && cur !== htmlId && safety < MAX_SCROLL_CHAIN_HOPS;
}

interface ScrollChainStep {
  finished: boolean;
  parentId: number | null;
}

function scrollChainStep(
  nodeId: number,
  state: WheelScrollState,
  cellX: number,
  cellY: number,
): ScrollChainStep {
  const info = nodeScrollInfoSafe(nodeId);
  if (info && scrollNodeByWheel(nodeId, info, state, cellX, cellY)) {
    return { finished: true, parentId: null };
  }
  try {
    return { finished: false, parentId: dom.parentId(nodeId) };
  } catch {
    return { finished: true, parentId: null };
  }
}

function hasWheelRemainder(state: WheelScrollState): boolean {
  return (
    Math.abs(state.remainingX) >= WHEEL_SCROLL_REMAINDER_EPSILON_CSS_PX ||
    Math.abs(state.remainingY) >= WHEEL_SCROLL_REMAINDER_EPSILON_CSS_PX
  );
}
ksGlobal.__ks_scrollByWheel = scrollByWheel;

function setScrollOffset(
  x: unknown,
  y: unknown,
  fireEvent = true,
  setter = setScrollOffsetCb(),
): { x: number; y: number } {
  const before = scrollOffset();
  const requested = { x: Math.max(0, Number(x) || 0), y: Math.max(0, Number(y) || 0) };
  const after = applyScrollOffsetSetter(requested, setter);
  dispatchScrollEventsIfChanged(fireEvent, before, after);
  return after;
}

function dispatchScrollEventsIfChanged(
  fireEvent: boolean,
  before: { x: number; y: number },
  after: { x: number; y: number },
): void {
  if (shouldDispatchScrollEvents(fireEvent, before, after)) dispatchScrollEvents();
}

function applyScrollOffsetSetter(
  after: { x: number; y: number },
  setter: ((x: number, y: number) => { x: number; y: number } | null) | null,
): { x: number; y: number } {
  if (setter) {
    try {
      const v = setter(after.x, after.y);
      if (v) return scrollOffsetFromValue(v);
    } catch {}
  } else {
    setLocalScroll(after.x, after.y);
  }
  return after;
}

function shouldDispatchScrollEvents(
  fireEvent: boolean,
  before: { x: number; y: number },
  after: { x: number; y: number },
): boolean {
  return fireEvent && (before.x !== after.x || before.y !== after.y);
}

function dispatchScrollEvents(): void {
  dispatchDocumentScrollEvent("scroll");
  const sequence = bumpScrollendSeq();
  scheduleFrameOrTimeout(() => dispatchScrollendIfCurrent(sequence));
}

function dispatchScrollendIfCurrent(sequence: number): void {
  if (sequence !== scrollendSeq) return;
  dispatchDocumentScrollEvent("scrollend");
}

function dispatchDocumentScrollEvent(type: "scroll" | "scrollend"): void {
  try {
    const key = documentScrollKey();
    const ev = new KsEvent(type, {
      bubbles: true,
      cancelable: false,
    });
    dispatchTrustedOnKey(key, ev);
  } catch {}
}

function documentScrollKey(): typeof WINDOW_KEY | number {
  try {
    return dom.documentNodeId();
  } catch {
    return WINDOW_KEY;
  }
}

function scheduleFrameOrTimeout(callback: () => void): void {
  const rAF = ksGlobal.requestAnimationFrame;
  if (typeof rAF === "function") rAF(callback);
  else Promise.resolve().then(() => setTimeout(callback, 0));
}

export { scrollOffset, setScrollOffset, scrollByWheel, fireElementScroll, nodeScrollInfoSafe };
