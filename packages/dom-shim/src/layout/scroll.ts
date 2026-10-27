// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Handles document and element scroll offsets, wheel chaining, and trusted scroll events.

import { ksGlobal, dom, WINDOW_KEY, opts, nodeFor } from "../state.js";
import type { AuthScrollInfoSnapshot } from "../state.js";
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
import { ksInternals } from "../internals.js";

const WHEEL_SCROLL_REMAINDER_EPSILON_CSS_PX = 0.5;

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
function scrollOffset(): { x: number; y: number } {
  const offsetCb = getScrollOffsetCb();
  if (offsetCb) {
    try {
      const v = offsetCb();
      if (v) {
        return {
          x: Number(v.x) || 0,
          y: Number(v.y) || 0,
        };
      }
    } catch {}
  }
  return { x: localScrollX, y: localScrollY };
}

function nodeScrollInfoSafe(nodeId: number): AuthScrollInfoSnapshot | null {
  const scrollInfoCb = getScrollInfoByAuthIdCb();
  if (scrollInfoCb) {
    try {
      const layoutInfo = scrollInfoCb(nodeId);
      if (layoutInfo && typeof layoutInfo === "object") {
        let wasmInfo: any = null;
        try {
          wasmInfo = dom.nodeScrollInfo(nodeId);
        } catch {}
        return {
          scrollTop: wasmInfo?.scrollTop ?? layoutInfo.scrollTop ?? 0,
          scrollLeft: wasmInfo?.scrollLeft ?? layoutInfo.scrollLeft ?? 0,
          scrollWidth: layoutInfo.scrollWidth ?? 0,
          scrollHeight: layoutInfo.scrollHeight ?? 0,
          clientWidth: layoutInfo.clientWidth ?? 0,
          clientHeight: layoutInfo.clientHeight ?? 0,
          clientTop: layoutInfo.clientTop ?? 0,
          clientLeft: layoutInfo.clientLeft ?? 0,
          contentWidth: layoutInfo.contentWidth ?? layoutInfo.clientWidth ?? 0,
          contentHeight: layoutInfo.contentHeight ?? layoutInfo.clientHeight ?? 0,
          hasBox: layoutInfo.hasBox ?? false,
          overflowsX: !!layoutInfo.overflowsX,
          overflowsY: !!layoutInfo.overflowsY,
          userScrollableX: !!layoutInfo.userScrollableX,
          userScrollableY: !!layoutInfo.userScrollableY,
          stopScrollChainX: !!layoutInfo.stopScrollChainX,
          stopScrollChainY: !!layoutInfo.stopScrollChainY,
        };
      }
    } catch {}
  }
  try {
    const info = dom.nodeScrollInfo(nodeId);
    if (info && typeof info === "object") return info;
  } catch {}
  return null;
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
  if (info.userScrollableX && info.stopScrollChainX && state.remainingX !== 0) {
    state.remainingX = 0;
    state.handled = true;
  }
  if (info.userScrollableY && info.stopScrollChainY && state.remainingY !== 0) {
    state.remainingY = 0;
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
  const canX = info.userScrollableX && info.scrollWidth > 0;
  const canY = info.userScrollableY && info.scrollHeight > 0;
  if (!((canX && state.remainingX !== 0) || (canY && state.remainingY !== 0))) return false;

  const beforeX = info.scrollLeft;
  const beforeY = info.scrollTop;
  const targetX = canX ? wheelTarget(beforeX, state.remainingX, info.scrollWidth, cellX) : beforeX;
  const targetY = canY ? wheelTarget(beforeY, state.remainingY, info.scrollHeight, cellY) : beforeY;
  if (targetX === beforeX && targetY === beforeY) {
    stopWheelScrollChain(info, state);
    return false;
  }

  let offset: unknown = null;
  try {
    offset = dom.setNodeScrollOffset(nodeId, targetX, targetY);
  } catch {}
  if (!offset) {
    stopWheelScrollChain(info, state);
    return false;
  }

  state.handled = true;
  markDamageNode(nodeId);
  bumpMutationSeq("paint");
  try {
    const element = nodeFor(nodeId);
    if (element) fireElementScroll(element);
  } catch {}
  state.remainingX -= targetX - beforeX;
  state.remainingY -= targetY - beforeY;
  if (wheelRemainderIsSmall(state)) return true;
  stopWheelScrollChain(info, state);
  return false;
}

function scrollByWheel(hitNodeId: number, dx: number, dy: number): boolean {
  const state: WheelScrollState = { remainingX: dx, remainingY: dy, handled: false };
  const cellX = Math.max(0, Number(ksInternals.ttyCellWidth) || 0);
  const cellY = Math.max(0, Number(ksInternals.ttyCellHeight) || 0);
  const htmlId = dom.querySelector("html");
  let cur = hitNodeId;
  let safety = 0;
  while (cur != null && cur >= 0 && cur !== htmlId && safety < MAX_SCROLL_CHAIN_HOPS) {
    safety++;
    const info = nodeScrollInfoSafe(cur);
    if (info && scrollNodeByWheel(cur, info, state, cellX, cellY)) return state.handled;
    try {
      cur = dom.parentId(cur);
    } catch {
      break;
    }
  }
  if (
    Math.abs(state.remainingX) >= WHEEL_SCROLL_REMAINDER_EPSILON_CSS_PX ||
    Math.abs(state.remainingY) >= WHEEL_SCROLL_REMAINDER_EPSILON_CSS_PX
  ) {
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
ksInternals.scrollByWheel = scrollByWheel;

function setScrollOffset(
  x: unknown,
  y: unknown,
  fireEvent = true,
  setter = setScrollOffsetCb(),
): { x: number; y: number } {
  const before = scrollOffset();
  let after = { x: Math.max(0, Number(x) || 0), y: Math.max(0, Number(y) || 0) };
  if (setter) {
    try {
      const v = setter(after.x, after.y);
      if (v) {
        after = {
          x: Number(v.x) || 0,
          y: Number(v.y) || 0,
        };
      }
    } catch {}
  } else {
    setLocalScroll(after.x, after.y);
  }
  if (fireEvent && (before.x !== after.x || before.y !== after.y)) {
    try {
      let docKey: any = WINDOW_KEY;
      try {
        docKey = dom.documentNodeId();
      } catch {}
      const ev = new KsEvent("scroll", {
        bubbles: true,
        cancelable: false,
      });
      dispatchTrustedOnKey(docKey, ev);
    } catch {}

    const mySeq = bumpScrollendSeq();
    const scheduleScrollend = () => {
      if (mySeq !== scrollendSeq) return;
      try {
        let docKey: any = WINDOW_KEY;
        try {
          docKey = dom.documentNodeId();
        } catch {}
        const ev = new KsEvent("scrollend", {
          bubbles: true,
          cancelable: false,
        });
        dispatchTrustedOnKey(docKey, ev);
      } catch {}
    };
    const rAF = ksGlobal.requestAnimationFrame;
    if (typeof rAF === "function") {
      rAF(scheduleScrollend);
    } else {
      Promise.resolve().then(() => setTimeout(scheduleScrollend, 0));
    }
  }
  return after;
}

export { scrollOffset, setScrollOffset, scrollByWheel, fireElementScroll, nodeScrollInfoSafe };
