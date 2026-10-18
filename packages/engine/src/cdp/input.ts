// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Mouse and keyboard events enter PageScript; other Input methods are no-ops.
// Hit-testing is partial, and the DOM shim does not implement KeyboardEvent.

import type { CdpRequest, TargetState } from "./types.ts";
import type { DispatchCtx } from "./dispatch.ts";
import { makeFrameInfo, makeMainFrameState } from "./frames.ts";
import type { MouseEventInit } from "@kitesurf/jsrpc-types/page-script";
import type { ConsoleEntry } from "@kitesurf/jsrpc-types/shared";
import { consoleEntryToCdpEvent } from "../eval/page-script.ts";
import { emitMutations } from "./dom.ts";
import { terminalSceneWheelQueue } from "./scene-stream.ts";
import {
  fenceWheelQueues,
  flushWheelQueues,
  waitForWheelHandoffDrain,
  type WheelBatch,
  type WheelQueue,
} from "./wheel-queue.ts";

const MOUSE_MOVE_THROTTLE_MS = 33;

interface PendingMove {
  init: MouseEventInit;
  sessionId: string | undefined;
}

interface MouseMoveDebounce {
  lastDispatchAt: number;
  pending: PendingMove | null;
  timerHandle: ReturnType<typeof setTimeout> | 0;
}

const mouseMoveDebounce = new Map<string, MouseMoveDebounce>();

function currentWheelState(
  ctx: DispatchCtx,
  target: TargetState,
  queue: WheelQueue,
  generation: number,
  pageScript: NonNullable<TargetState["pageScript"]>,
): boolean {
  return (
    !queue.isCancelled &&
    !ctx.browser.wsClosing &&
    target.wheelTeardownDepth === 0 &&
    target.navigateGeneration === generation &&
    target.pageScript === pageScript
  );
}

function configureWheelDispatch(
  ctx: DispatchCtx,
  target: TargetState,
  sessionId: string | undefined,
  queue: WheelQueue,
): void {
  const generation = target.navigateGeneration;
  queue.configure(async (batch: WheelBatch, currentQueue) => {
    const pageScript = target.pageScript;
    const init = {
      ...batch.init,
      deltaX: batch.deltaX,
      deltaY: batch.deltaY,
    };
    try {
      if (pageScript && currentWheelState(ctx, target, currentQueue, generation, pageScript)) {
        const result = await pageScript.dispatchMouseEvent("wheel", init);
        if (currentWheelState(ctx, target, currentQueue, generation, pageScript)) {
          emitConsole(ctx, result.console, sessionId);
          emitMutations(ctx, target, result.cdpMutations);
        }
      }
    } catch {
    } finally {
      for (const resolve of batch.pending) resolve();
    }
  });
}

export async function handleInput(
  ctx: DispatchCtx,
  req: CdpRequest,
  expected?: { targetId: string; generation: number },
): Promise<unknown> {
  const expectedStub = expected ? pickTarget(ctx, req.sessionId)?.pageScript : undefined;
  const assertExpected = (target: TargetState | undefined): void => {
    if (
      expected &&
      (!target ||
        target.targetId !== expected.targetId ||
        target.navigateGeneration !== expected.generation ||
        target.pageScript !== expectedStub ||
        !expectedStub)
    ) {
      throw new Error("the observed document retired before input");
    }
  };
  if (expected) assertExpected(pickTarget(ctx, req.sessionId));
  // The method union keeps each Input command's params tied to its protocol shape.
  switch (req.method) {
    case "Input.dispatchMouseEvent": {
      const target = pickTarget(ctx, req.sessionId);
      if (!target || !target.pageScript) {
        return {};
      }
      const p = req.params!;
      const evType = mapMouseType(p.type);
      if (!evType) return {};
      const buttonInt =
        p.button === "left"
          ? 0
          : p.button === "right"
            ? 2
            : p.button === "middle"
              ? 1
              : p.button === "back"
                ? 3
                : p.button === "forward"
                  ? 4
                  : 0;
      const buttonFlag =
        p.button === "left"
          ? 1
          : p.button === "right"
            ? 2
            : p.button === "middle"
              ? 4
              : p.button === "back"
                ? 8
                : p.button === "forward"
                  ? 16
                  : 0;
      const buttons =
        evType === "mouseup" ? (p.buttons ?? 0) & ~buttonFlag : (p.buttons ?? 0) | buttonFlag;
      const init = {
        bubbles: true,
        cancelable: true,
        clientX: p.x,
        clientY: p.y,
        button: buttonInt,
        buttons,
        detail: p.clickCount ?? 1,
        altKey: hasModifier(p.modifiers, 1),
        ctrlKey: hasModifier(p.modifiers, 2),
        metaKey: hasModifier(p.modifiers, 4),
        shiftKey: hasModifier(p.modifiers, 8),
        deltaX: p.deltaX ?? 0,
        deltaY: p.deltaY ?? 0,
        deltaZ: 0,
        deltaMode: 0,
      };

      let releaseWheelFences: Array<() => void> = [];
      const releaseWheelFencesNow = () => {
        for (const release of releaseWheelFences) release();
        releaseWheelFences = [];
      };
      if (evType === "mousemove") {
        await waitForWheelHandoffDrain(ctx.browser, target.targetId, req.sessionId);
        const moveFenceReleases = await fenceWheelQueues(
          ctx.browser,
          target.targetId,
          req.sessionId,
        );
        if (!moveFenceReleases) return {};
        try {
          // This private flag is not declared by the standard mouse-event protocol shape.
          const syncMove =
            Reflect.get(p, "_kitesurfSyncMove") === true ||
            ((p.buttons ?? 0) & 1) !== 0 ||
            expected !== undefined;
          assertExpected(target);
          if (!syncMove) {
            scheduleMouseMove(ctx, target, init, req.sessionId);
            return {};
          }
          await flushPendingMove(ctx, target);
          assertExpected(target);
          await dispatchMouseMove(ctx, target, init, req.sessionId);
          return {};
        } finally {
          for (const release of moveFenceReleases) release();
        }
      }

      if (evType === "wheel") {
        await flushPendingMove(ctx, target);
        const stream = ctx.browser.screencasts.get(target.targetId);
        const ownerScreencast =
          stream?.ownerSessionId === (req.sessionId || undefined) ? stream : null;
        const queue =
          ownerScreencast?.wheelQueue ??
          terminalSceneWheelQueue(ctx.browser, target.targetId, req.sessionId);
        if (queue) {
          await waitForWheelHandoffDrain(ctx.browser, target.targetId, req.sessionId);
          await flushWheelQueues(ctx.browser, target.targetId, req.sessionId, queue);
          if (
            (ownerScreencast
              ? ownerScreencast.wheelQueue === queue &&
                ownerScreencast.ownerSessionId === (req.sessionId || undefined)
              : terminalSceneWheelQueue(ctx.browser, target.targetId, req.sessionId) === queue) &&
            queue.isAccepting &&
            target.wheelTeardownDepth === 0
          ) {
            assertExpected(target);
            configureWheelDispatch(ctx, target, req.sessionId, queue);
            return await queue.enqueue(init);
          }
        }
        await waitForWheelHandoffDrain(ctx.browser, target.targetId, req.sessionId);
        await flushWheelQueues(ctx.browser, target.targetId, req.sessionId);
        if (target.wheelTeardownDepth > 0) return {};
      } else {
        await waitForWheelHandoffDrain(ctx.browser, target.targetId, req.sessionId);
        const fences = await fenceWheelQueues(ctx.browser, target.targetId, req.sessionId);
        if (!fences) return {};
        releaseWheelFences = fences;
        await flushPendingMove(ctx, target);
      }

      try {
        assertExpected(target);
        const result = await target.pageScript.dispatchMouseEvent(evType, init);
        emitConsole(ctx, result.console, req.sessionId);
        emitMutations(ctx, target, result.cdpMutations);
        if (p.type !== "mouseReleased") {
          releaseWheelFencesNow();
          await maybeFollowAnchor(ctx, result, req.sessionId);
        }
        if (p.type === "mousePressed" && p.button === "right") {
          assertExpected(target);
          const menuResult = await target.pageScript.dispatchMouseEvent("contextmenu", init);
          emitConsole(ctx, menuResult.console, req.sessionId);
          emitMutations(ctx, target, menuResult.cdpMutations);
        }
        if (p.type === "mouseReleased") {
          const clickCount = (p.clickCount ?? 0) > 0 ? p.clickCount! : 1;
          const clickInit = { ...init, detail: clickCount };
          const primary = p.button === "left" || p.button === undefined;
          const evName = primary ? "click" : "auxclick";
          assertExpected(target);
          const clickResult = await target.pageScript.dispatchMouseEvent(evName, clickInit);
          emitConsole(ctx, clickResult.console, req.sessionId);
          emitMutations(ctx, target, clickResult.cdpMutations);
          if (primary && clickCount === 2) {
            assertExpected(target);
            const dblResult = await target.pageScript.dispatchMouseEvent("dblclick", clickInit);
            emitConsole(ctx, dblResult.console, req.sessionId);
            emitMutations(ctx, target, dblResult.cdpMutations);
          }
          releaseWheelFencesNow();
          const navigationResult =
            clickResult.navigatePost || clickResult.navigateTo || clickResult.hashNavigateTo
              ? clickResult
              : result;
          await maybeFollowAnchor(ctx, navigationResult, req.sessionId);
        }
        return {};
      } catch (err) {
        assertExpected(target);
        console.warn(
          "kitesurf: Input.dispatchMouseEvent forward failed:",
          err instanceof Error ? err.message : String(err),
        );
        return {};
      } finally {
        releaseWheelFencesNow();
      }
    }

    case "Input.dispatchKeyEvent": {
      const target = pickTarget(ctx, req.sessionId);
      if (!target || !target.pageScript) return {};
      await waitForWheelHandoffDrain(ctx.browser, target.targetId, req.sessionId);
      const p = req.params!;
      const evType = mapKeyType(p.type);
      if (!evType) return {};
      const init = {
        bubbles: true,
        cancelable: true,
        key: p.key ?? "",
        code: p.code ?? "",
        keyCode: p.windowsVirtualKeyCode ?? 0,
        text: p.text ?? "",
        altKey: hasModifier(p.modifiers, 1),
        ctrlKey: hasModifier(p.modifiers, 2),
        metaKey: hasModifier(p.modifiers, 4),
        shiftKey: hasModifier(p.modifiers, 8),
        location: p.location ?? 0,
        repeat: p.autoRepeat === true,
        ttyKeyboard: ctx.browser.ttyKeyboard || !!ctx.browser.ttyUaCss,
      };
      const releaseWheelFences = await fenceWheelQueues(
        ctx.browser,
        target.targetId,
        req.sessionId,
      );
      if (!releaseWheelFences) return {};
      try {
        assertExpected(target);
        const result = await target.pageScript.dispatchKeyEvent(evType, init);
        emitConsole(ctx, result.console, req.sessionId);
        emitMutations(ctx, target, result.cdpMutations);
        for (const release of releaseWheelFences) release();
        await maybeFollowAnchor(ctx, result, req.sessionId);
        return {};
      } catch (err) {
        assertExpected(target);
        console.warn(
          "kitesurf: Input.dispatchKeyEvent forward failed:",
          err instanceof Error ? err.message : String(err),
        );
        return {};
      } finally {
        for (const release of releaseWheelFences) release();
      }
    }

    case "Input.insertText": {
      const target = pickTarget(ctx, req.sessionId);
      if (!target || !target.pageScript) return {};
      await waitForWheelHandoffDrain(ctx.browser, target.targetId, req.sessionId);
      const text = req.params!.text;
      if (!text) return {};
      const releaseWheelFences = await fenceWheelQueues(
        ctx.browser,
        target.targetId,
        req.sessionId,
      );
      if (!releaseWheelFences) return {};
      try {
        assertExpected(target);
        const result = await target.pageScript.dispatchKeyEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "",
          code: "",
          text,
        });
        emitConsole(ctx, result.console, req.sessionId);
        emitMutations(ctx, target, result.cdpMutations);
      } catch (err) {
        assertExpected(target);
        console.warn(
          "kitesurf: Input.insertText forward failed:",
          err instanceof Error ? err.message : String(err),
        );
      } finally {
        for (const release of releaseWheelFences) release();
      }
      return {};
    }

    case "Input.setIgnoreInputEvents":
    case "Input.imeSetComposition":
    case "Input.dispatchTouchEvent":
    case "Input.dispatchDragEvent":
    case "Input.synthesizePinchGesture":
    case "Input.synthesizeScrollGesture":
    case "Input.synthesizeTapGesture":
      return {};

    default:
      return {};
  }
}

function scheduleMouseMove(
  ctx: DispatchCtx,
  target: TargetState,
  init: MouseEventInit,
  sessionId: string | undefined,
): void {
  const targetId = target.targetId;
  let state = mouseMoveDebounce.get(targetId);
  if (!state) {
    state = { lastDispatchAt: 0, pending: null, timerHandle: 0 };
    mouseMoveDebounce.set(targetId, state);
  }

  const now = Date.now();
  const sinceLast = now - state.lastDispatchAt;

  if (sinceLast >= MOUSE_MOVE_THROTTLE_MS && state.pending === null) {
    if (state.timerHandle) {
      clearTimeout(state.timerHandle);
      state.timerHandle = 0;
    }
    state.lastDispatchAt = now;
    void dispatchMouseMove(ctx, target, init, sessionId);
    return;
  }

  state.pending = { init, sessionId };
  if (state.timerHandle === 0) {
    const wait = Math.max(1, MOUSE_MOVE_THROTTLE_MS - sinceLast);
    state.timerHandle = setTimeout(() => {
      void flushPendingMove(ctx, target);
    }, wait);
  }
}

async function flushPendingMove(ctx: DispatchCtx, target: TargetState): Promise<void> {
  const state = mouseMoveDebounce.get(target.targetId);
  if (!state) return;
  if (state.timerHandle) {
    clearTimeout(state.timerHandle);
    state.timerHandle = 0;
  }
  const pending = state.pending;
  state.pending = null;
  if (!pending) return;
  state.lastDispatchAt = Date.now();
  await dispatchMouseMove(ctx, target, pending.init, pending.sessionId);
}

async function dispatchMouseMove(
  ctx: DispatchCtx,
  target: TargetState,
  init: MouseEventInit,
  sessionId: string | undefined,
): Promise<void> {
  if (!target.pageScript) return;
  try {
    const result = await target.pageScript.dispatchMouseEvent("mousemove", init);
    emitConsole(ctx, result.console, sessionId);
    emitMutations(ctx, target, result.cdpMutations);
  } catch {}
}

function pickTarget(ctx: DispatchCtx, sessionId: string | undefined): TargetState | undefined {
  if (sessionId) {
    for (const t of ctx.browser.targets.values()) {
      if (t.sessions.has(sessionId)) return t;
    }
  }
  for (const t of ctx.browser.targets.values()) {
    if (t.type === "page") return t;
  }
  return undefined;
}

function mapMouseType(cdp: string): string | null {
  switch (cdp) {
    case "mousePressed":
      return "mousedown";
    case "mouseReleased":
      return "mouseup";
    case "mouseMoved":
      return "mousemove";
    case "mouseWheel":
      return "wheel";
    case "click":
      return "click";
    default:
      return null;
  }
}

function mapKeyType(cdp: string): string | null {
  switch (cdp) {
    case "keyDown":
      return "keydown";
    case "keyUp":
      return "keyup";
    case "rawKeyDown":
      return "keydown";
    case "char":
      return "keypress";
    default:
      return null;
  }
}

function hasModifier(mods: number | undefined, bit: number): boolean {
  return typeof mods === "number" && (mods & bit) !== 0;
}

function emitConsole(
  ctx: DispatchCtx,
  entries: ConsoleEntry[] | undefined,
  sessionId: string | undefined,
): void {
  if (!entries || entries.length === 0) return;
  const target = pickTarget(ctx, sessionId);
  const ctxId = target?.defaultContextId || 1;
  for (const e of entries) {
    const ev = consoleEntryToCdpEvent(e, ctxId);
    ctx.emit({ method: ev.method, params: ev.params, sessionId });
  }
}

async function maybeFollowAnchor(
  ctx: DispatchCtx,
  result:
    | {
        navigateTo?: string | null;
        hashNavigateTo?: string | null;
        navigatePost?: {
          url: string;
          postData?: string;
          postContentType?: string;
        } | null;
      }
    | null
    | undefined,
  sessionId: string | undefined,
): Promise<void> {
  const navigateTo = result?.navigateTo;
  const hashNavigateTo = result?.hashNavigateTo;
  const navigatePost = result?.navigatePost;
  if (navigatePost && typeof navigatePost.url === "string") {
    const { dispatch } = await import("./dispatch.ts");
    try {
      await dispatch(ctx, {
        id: -1,
        method: "Page.navigate",
        params: {
          url: navigatePost.url,
          _kitesurfInternal: true,
          _kitesurfPostData: navigatePost.postData ?? "",
          _kitesurfPostContentType:
            navigatePost.postContentType ?? "application/x-www-form-urlencoded",
        },
        sessionId,
      });
    } catch (err) {
      console.warn(
        "kitesurf: form-POST Page.navigate failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
    return;
  }
  if (typeof navigateTo === "string" && navigateTo.length > 0) {
    const { dispatch } = await import("./dispatch.ts");
    try {
      await dispatch(ctx, {
        id: -1,
        method: "Page.navigate",
        params: { url: navigateTo, _kitesurfInternal: true },
        sessionId,
      });
    } catch (err) {
      console.warn(
        "kitesurf: anchor-follow Page.navigate failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
    return;
  }
  if (typeof hashNavigateTo === "string" && hashNavigateTo.length > 0) {
    const target = pickTarget(ctx, sessionId);
    if (!target) return;
    target.url = hashNavigateTo;
    const main = target.frames.get(target.frameId);
    if (main) {
      main.url = target.url;
      main.securityOrigin = originOfUrl(target.url);
    }
    const frame =
      main ??
      makeMainFrameState({
        frameId: target.frameId,
        loaderId: target.loaderId,
        url: target.url,
      });
    ctx.emit({
      method: "Page.frameNavigated",
      params: {
        frame: makeFrameInfo(frame),
        type: "Navigation",
      },
      sessionId,
    });
  }
}

function originOfUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}
