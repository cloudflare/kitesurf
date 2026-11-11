// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Mouse and keyboard events enter PageScript; other Input methods are no-ops.
// Hit-testing is partial, and the DOM shim does not implement KeyboardEvent.

import { makeTargetId, type CdpRequest, type TargetState } from "./types.ts";
import type { DispatchCtx } from "./dispatch.ts";
import { makeFrameInfo, makeMainFrameState } from "./frames.ts";
import type { MouseEventInit } from "@kitesurf/jsrpc-types/page-script";
import type { ConsoleEntry, JsWindowDrain } from "@kitesurf/jsrpc-types/shared";
import { consoleEntryToCdpEvent } from "../eval/page-script.ts";
import { emitMutations } from "./dom.ts";
import {
  canRewriteDocumentUrl,
  emitInputNavigationStarted,
  formPostContentType,
  initiatorOriginOf,
} from "./page.ts";
import { applyCookieWrites } from "./runtime.ts";
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
          applyReply(ctx, target, pageScript, result, sessionId);
        }
      }
    } catch {
    } finally {
      for (const resolve of batch.pending) resolve();
    }
  });
}

export interface HandleInputOptions {
  // Chrome replies once the input is dispatched and reports a navigation it starts through Page
  // events. The CDP router asks for that; an embedder judging a click by its page leaves it off.
  replyOnDispatch?: boolean;
}

export async function handleInput(
  ctx: DispatchCtx,
  req: CdpRequest,
  expected?: { targetId: string; generation: number },
  { replyOnDispatch = false }: HandleInputOptions = {},
): Promise<unknown> {
  const pendingNavigation = pickTarget(ctx, req.sessionId)?.inputNavigation;
  if (pendingNavigation) await pendingNavigation;
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
        const inputPageScript = target.pageScript;
        const inputPageScriptUrl = target.pageScriptUrl;
        if (!inputPageScript) return {};
        const result = await inputPageScript.dispatchMouseEvent(evType, init);
        applyReply(ctx, target, inputPageScript, result, req.sessionId);
        if (p.type !== "mouseReleased") {
          releaseWheelFencesNow();
          if (
            target.pageScript !== inputPageScript ||
            target.pageScriptUrl !== inputPageScriptUrl
          ) {
            return {};
          }
          await followNavigation(
            ctx,
            target,
            result,
            req.sessionId,
            !replyOnDispatch,
            initiatorOriginOf(inputPageScriptUrl) ?? "null",
          );
        }
        if (p.type === "mousePressed" && p.button === "right") {
          assertExpected(target);
          const menuResult = await inputPageScript.dispatchMouseEvent("contextmenu", init);
          applyReply(ctx, target, inputPageScript, menuResult, req.sessionId);
        }
        if (p.type === "mouseReleased") {
          const clickCount = (p.clickCount ?? 0) > 0 ? p.clickCount! : 1;
          const clickInit = { ...init, detail: clickCount };
          const primary = p.button === "left" || p.button === undefined;
          const evName = primary ? "click" : "auxclick";
          assertExpected(target);
          const clickResult = await inputPageScript.dispatchMouseEvent(evName, clickInit);
          applyReply(ctx, target, inputPageScript, clickResult, req.sessionId);
          if (primary && clickCount === 2) {
            assertExpected(target);
            const dblResult = await inputPageScript.dispatchMouseEvent("dblclick", clickInit);
            applyReply(ctx, target, inputPageScript, dblResult, req.sessionId);
          }
          releaseWheelFencesNow();
          if (
            target.pageScript !== inputPageScript ||
            target.pageScriptUrl !== inputPageScriptUrl
          ) {
            return {};
          }
          const navigationResult =
            clickResult.navigatePost || clickResult.navigateTo || clickResult.hashNavigateTo
              ? clickResult
              : result;
          await followNavigation(
            ctx,
            target,
            navigationResult,
            req.sessionId,
            !replyOnDispatch,
            initiatorOriginOf(inputPageScriptUrl) ?? "null",
          );
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
        const inputPageScript = target.pageScript;
        const inputPageScriptUrl = target.pageScriptUrl;
        if (!inputPageScript) return {};
        const result = await inputPageScript.dispatchKeyEvent(evType, init);
        applyReply(ctx, target, inputPageScript, result, req.sessionId);
        for (const release of releaseWheelFences) release();
        if (target.pageScript !== inputPageScript || target.pageScriptUrl !== inputPageScriptUrl) {
          return {};
        }
        await followNavigation(
          ctx,
          target,
          result,
          req.sessionId,
          !replyOnDispatch,
          initiatorOriginOf(inputPageScriptUrl) ?? "null",
        );
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
        // Chrome commits this text as an IME would, with no key events, so a page's key handlers
        // never see it and a keydown's preventDefault cannot drop it.
        const inputPageScript = target.pageScript;
        const inputPageScriptUrl = target.pageScriptUrl;
        if (!inputPageScript) return {};
        const result = await inputPageScript.insertText(text);
        applyReply(ctx, target, inputPageScript, result, req.sessionId);
        for (const release of releaseWheelFences) release();
        if (target.pageScript !== inputPageScript || target.pageScriptUrl !== inputPageScriptUrl) {
          return {};
        }
        await followNavigation(
          ctx,
          target,
          result,
          req.sessionId,
          !replyOnDispatch,
          initiatorOriginOf(inputPageScriptUrl) ?? "null",
        );
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
    const pageScript = target.pageScript;
    const result = await pageScript.dispatchMouseEvent("mousemove", init);
    applyReply(ctx, target, pageScript, result, sessionId);
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

// A handler's document.cookie write comes back on its event's reply. Dropped here, it never
// reached the jar: not the navigation the event started, nor any request after it.
function applyReply(
  ctx: DispatchCtx,
  target: TargetState,
  pageScript: NonNullable<TargetState["pageScript"]>,
  result: JsWindowDrain,
  sessionId: string | undefined,
): void {
  emitConsole(ctx, result.console, sessionId);
  emitMutations(ctx, target, result.cdpMutations);
  applyCookieWrites(ctx, target, result.cookieWrites, pageScript, null);
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

type NavigationResult = Parameters<typeof maybeFollowAnchor>[1];

interface FormPost {
  url: string;
  postData: string;
  postContentType: string;
}

// The reply comes from the page realm, so only the enctypes a real form can produce may become a
// document POST.
function formPost(result: NavigationResult): FormPost | null {
  const post = result?.navigatePost;
  if (typeof post?.url !== "string") return null;
  const postContentType = formPostContentType(post.postContentType);
  if (postContentType === null) return null;
  return {
    url: post.url,
    postData: typeof post.postData === "string" ? post.postData : "",
    postContentType,
  };
}

function startsNavigation(result: NavigationResult): boolean {
  return !!result && (formPost(result) !== null || !!result.navigateTo || !!result.hashNavigateTo);
}

// Page.navigate replies once the new document has loaded, which held a link click's mouseup for
// seconds: puppeteer's locator timed out on clicks that had in fact navigated.
async function followNavigation(
  ctx: DispatchCtx,
  target: TargetState,
  result: NavigationResult,
  sessionId: string | undefined,
  wait: boolean,
  initiatorOrigin: string,
): Promise<void> {
  if (!startsNavigation(result)) return;
  const loaderId = announceNavigation(ctx, target, result, sessionId);
  const navigation = maybeFollowAnchor(ctx, result, sessionId, loaderId, initiatorOrigin);
  if (wait) return navigation;
  const pending: Promise<void> = navigation
    .catch((err: unknown) =>
      console.warn("kitesurf: input-started navigation failed", {
        targetId: target.targetId,
        sessionId,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      }),
    )
    .finally(() => {
      if (target.inputNavigation === pending) target.inputNavigation = undefined;
    });
  target.inputNavigation = pending;
}

// A new document's navigation is announced before its input replies, under the loader id the
// Page.navigate that loads it adopts; a fragment change stays within the document.
function announceNavigation(
  ctx: DispatchCtx,
  target: TargetState,
  result: NavigationResult,
  sessionId: string | undefined,
): string | undefined {
  const post = formPost(result);
  const url = post?.url ?? result?.navigateTo;
  if (!url) return undefined;
  const loaderId = makeTargetId();
  const reason = post ? "formSubmissionPost" : "other";
  emitInputNavigationStarted(ctx, target, { url, loaderId, reason }, sessionId);
  return loaderId;
}

async function maybeFollowAnchor(
  ctx: DispatchCtx,
  result:
    | {
        navigateTo?: string | null;
        navigateReferrerPolicy?: string;
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
  loaderId: string | undefined,
  initiatorOrigin: string,
): Promise<void> {
  const announced = loaderId ? { _kitesurfLoaderId: loaderId } : {};
  const navigateTo = result?.navigateTo;
  const hashNavigateTo = result?.hashNavigateTo;
  const navigatePost = formPost(result);
  if (navigatePost) {
    const { dispatch } = await import("./dispatch.ts");
    try {
      await dispatch(ctx, {
        id: -1,
        method: "Page.navigate",
        params: {
          url: navigatePost.url,
          _kitesurfInternal: true,
          _kitesurfPostData: navigatePost.postData,
          _kitesurfPostContentType: navigatePost.postContentType,
          _kitesurfInitiatorOrigin: initiatorOrigin,
          ...announced,
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
        params: {
          url: navigateTo,
          _kitesurfInternal: true,
          _kitesurfInitiatorOrigin: initiatorOrigin,
          _kitesurfReferrerPolicy: result?.navigateReferrerPolicy || undefined,
          ...announced,
        },
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
    if (!target || !isFragmentChange(target, hashNavigateTo)) return;
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
        frame: makeFrameInfo(frame, target.frames),
        type: "Navigation",
      },
      sessionId,
    });
  }
}

// The reply comes from the page realm, so check the move here: only target.url's fragment may
// change, and the url must stay one the isolate's sealed document can take without a navigation.
function isFragmentChange(target: TargetState, url: string): boolean {
  if (!url.includes("#")) return false;
  if (!target.pageScriptUrl || !canRewriteDocumentUrl(target.pageScriptUrl, url)) return false;
  try {
    const current = new URL(target.url);
    const next = new URL(url);
    current.hash = "";
    next.hash = "";
    return current.href === next.href;
  } catch {
    return false;
  }
}

function originOfUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}
