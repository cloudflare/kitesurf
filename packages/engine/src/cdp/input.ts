// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Mouse and keyboard events enter PageScript; other Input methods are no-ops.
// Hit-testing is partial, and the DOM shim does not implement KeyboardEvent.

import type { BrowserState, CdpRequest, TargetState } from "./types.ts";
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

type MouseInputRequest = Extract<CdpRequest, { method: "Input.dispatchMouseEvent" }>;
type KeyInputRequest = Extract<CdpRequest, { method: "Input.dispatchKeyEvent" }>;
type InsertTextRequest = Extract<CdpRequest, { method: "Input.insertText" }>;
type MouseInputParams = NonNullable<MouseInputRequest["params"]>;
type KeyInputParams = NonNullable<KeyInputRequest["params"]>;
type ExpectedInputTarget = { targetId: string; generation: number };
type PageInputTarget = TargetState & { pageScript: NonNullable<TargetState["pageScript"]> };
type ExpectedTargetCheck = (target: TargetState | undefined) => void;
type ScreencastState = NonNullable<ReturnType<BrowserState["screencasts"]["get"]>>;

interface WheelFenceState {
  releases: Array<() => void>;
}

type DispatchMouseResult = Awaited<
  ReturnType<NonNullable<TargetState["pageScript"]>["dispatchMouseEvent"]>
>;

interface MouseInputContext {
  ctx: DispatchCtx;
  target: PageInputTarget;
  params: MouseInputParams;
  eventType: string;
  init: MouseEventInit;
  expected: ExpectedInputTarget | undefined;
  assertExpected: ExpectedTargetCheck;
  sessionId: string | undefined;
  fences: WheelFenceState;
}

const MOUSE_INPUT_NOT_HANDLED = Symbol("mouse-input-not-handled");
const MOUSE_BUTTON_INDEX: Record<string, number> = {
  left: 0,
  right: 2,
  middle: 1,
  back: 3,
  forward: 4,
};
const MOUSE_BUTTON_MASK: Record<string, number> = {
  left: 1,
  right: 2,
  middle: 4,
  back: 8,
  forward: 16,
};

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
    try {
      await dispatchQueuedWheel(ctx, target, currentQueue, generation, sessionId, batch);
    } catch {
    } finally {
      settleWheelBatch(batch);
    }
  });
}

async function dispatchQueuedWheel(
  ctx: DispatchCtx,
  target: TargetState,
  queue: WheelQueue,
  generation: number,
  sessionId: string | undefined,
  batch: WheelBatch,
): Promise<void> {
  const pageScript = target.pageScript;
  if (!pageScript || !currentWheelState(ctx, target, queue, generation, pageScript)) return;
  const init = { ...batch.init, deltaX: batch.deltaX, deltaY: batch.deltaY };
  const result = await pageScript.dispatchMouseEvent("wheel", init);
  if (!currentWheelState(ctx, target, queue, generation, pageScript)) return;
  emitConsole(ctx, result.console, sessionId);
  emitMutations(ctx, target, result.cdpMutations);
}

function settleWheelBatch(batch: WheelBatch): void {
  for (const resolve of batch.pending) resolve();
}

export async function handleInput(
  ctx: DispatchCtx,
  req: CdpRequest,
  expected?: ExpectedInputTarget,
): Promise<unknown> {
  const assertExpected = expectedTargetCheck(ctx, req.sessionId, expected);
  if (expected) assertExpected(pickTarget(ctx, req.sessionId));
  if (req.method === "Input.dispatchMouseEvent") {
    return handleMouseInput(ctx, req, expected, assertExpected);
  }
  if (req.method === "Input.dispatchKeyEvent") {
    return handleKeyInput(ctx, req, assertExpected);
  }
  if (req.method === "Input.insertText") return handleInsertText(ctx, req, assertExpected);
  return {};
}

function expectedTargetCheck(
  ctx: DispatchCtx,
  sessionId: string | undefined,
  expected: ExpectedInputTarget | undefined,
): ExpectedTargetCheck {
  const expectedStub = expected ? pickTarget(ctx, sessionId)?.pageScript : undefined;
  return (target) => {
    if (!matchesExpectedTarget(target, expected, expectedStub)) {
      throw new Error("the observed document retired before input");
    }
  };
}

function matchesExpectedTarget(
  target: TargetState | undefined,
  expected: ExpectedInputTarget | undefined,
  expectedStub: TargetState["pageScript"] | undefined,
): boolean {
  if (!expected) return true;
  if (!target) return false;
  return (
    targetIdentityMatches(target, expected) &&
    target.pageScript === expectedStub &&
    expectedStub !== undefined
  );
}

function targetIdentityMatches(target: TargetState, expected: ExpectedInputTarget): boolean {
  return target.targetId === expected.targetId && target.navigateGeneration === expected.generation;
}

function handleInputParams<P>(params: P | undefined, method: string): P {
  if (params === undefined) throw new Error(`${method} requires parameters`);
  return params;
}

async function handleMouseInput(
  ctx: DispatchCtx,
  req: MouseInputRequest,
  expected: ExpectedInputTarget | undefined,
  assertExpected: ExpectedTargetCheck,
): Promise<unknown> {
  const target = pageInputTarget(ctx, req.sessionId);
  if (!target) return {};
  const params = handleInputParams(req.params, req.method);
  const eventType = mapMouseType(params.type);
  if (!eventType) return {};
  const init = mouseEventInit(params, eventType);
  return routeMouseInput({
    ctx,
    target,
    params,
    eventType,
    init,
    expected,
    assertExpected,
    sessionId: req.sessionId,
    fences: { releases: [] },
  });
}

async function routeMouseInput(input: MouseInputContext): Promise<unknown> {
  if (input.eventType === "mousemove") return handleMouseMove(input);
  if (input.eventType === "wheel") {
    const result = await handleWheelInput(input);
    if (result !== MOUSE_INPUT_NOT_HANDLED) return result;
    return dispatchMouseWithFences(input);
  }
  return dispatchNonWheelMouse(input);
}

function pageInputTarget(
  ctx: DispatchCtx,
  sessionId: string | undefined,
): PageInputTarget | undefined {
  const target = pickTarget(ctx, sessionId);
  if (isPageInputTarget(target)) return target;
  return undefined;
}

function isPageInputTarget(target: TargetState | undefined): target is PageInputTarget {
  return !!target?.pageScript;
}

function mouseEventInit(params: MouseInputParams, eventType: string): MouseEventInit {
  return {
    bubbles: true,
    cancelable: true,
    clientX: params.x,
    clientY: params.y,
    button: mouseButtonIndex(params.button),
    buttons: mouseButtonsForEvent(params, eventType),
    detail: params.clickCount ?? 1,
    altKey: hasModifier(params.modifiers, 1),
    ctrlKey: hasModifier(params.modifiers, 2),
    metaKey: hasModifier(params.modifiers, 4),
    shiftKey: hasModifier(params.modifiers, 8),
    deltaX: params.deltaX ?? 0,
    deltaY: params.deltaY ?? 0,
    deltaZ: 0,
    deltaMode: 0,
  };
}

function mouseButtonIndex(button: MouseInputParams["button"]): number {
  return MOUSE_BUTTON_INDEX[button ?? ""] ?? 0;
}

function mouseButtonMask(button: MouseInputParams["button"]): number {
  return MOUSE_BUTTON_MASK[button ?? ""] ?? 0;
}

function mouseButtonsForEvent(params: MouseInputParams, eventType: string): number {
  const buttons = params.buttons ?? 0;
  const buttonMask = mouseButtonMask(params.button);
  return eventType === "mouseup" ? buttons & ~buttonMask : buttons | buttonMask;
}

async function handleMouseMove(input: MouseInputContext): Promise<Record<string, never>> {
  await waitForWheelHandoffDrain(input.ctx.browser, input.target.targetId, input.sessionId);
  const releases = await fenceWheelQueues(
    input.ctx.browser,
    input.target.targetId,
    input.sessionId,
  );
  if (!releases) return {};
  try {
    await dispatchFencedMouseMove(input);
    return {};
  } finally {
    releaseWheelFences(releases);
  }
}

async function dispatchFencedMouseMove(input: MouseInputContext): Promise<void> {
  input.assertExpected(input.target);
  if (!isSynchronousMouseMove(input.params, input.expected)) {
    scheduleMouseMove(input.ctx, input.target, input.init, input.sessionId);
    return;
  }
  await flushPendingMove(input.ctx, input.target);
  input.assertExpected(input.target);
  await dispatchMouseMove(input.ctx, input.target, input.init, input.sessionId);
}

function isSynchronousMouseMove(
  params: MouseInputParams,
  expected: ExpectedInputTarget | undefined,
): boolean {
  return (
    Reflect.get(params, "_kitesurfSyncMove") === true ||
    ((params.buttons ?? 0) & 1) !== 0 ||
    expected !== undefined
  );
}

async function handleWheelInput(
  input: MouseInputContext,
): Promise<unknown | typeof MOUSE_INPUT_NOT_HANDLED> {
  await flushPendingMove(input.ctx, input.target);
  const route = wheelQueueForInput(input);
  if (route) {
    const result = await enqueueWheelInput(input, route);
    if (result !== MOUSE_INPUT_NOT_HANDLED) return result;
  }
  return flushUnqueuedWheel(input);
}

interface WheelQueueRoute {
  ownerScreencast: ScreencastState | null;
  queue: WheelQueue;
}

function wheelQueueForInput(input: MouseInputContext): WheelQueueRoute | null {
  const stream = input.ctx.browser.screencasts.get(input.target.targetId);
  const ownerScreencast = ownedScreencast(stream, input.sessionId);
  const queue =
    ownerScreencast?.wheelQueue ??
    terminalSceneWheelQueue(input.ctx.browser, input.target.targetId, input.sessionId);
  return queue ? { ownerScreencast, queue } : null;
}

async function enqueueWheelInput(
  input: MouseInputContext,
  route: WheelQueueRoute,
): Promise<unknown | typeof MOUSE_INPUT_NOT_HANDLED> {
  await waitForWheelHandoffDrain(input.ctx.browser, input.target.targetId, input.sessionId);
  await flushWheelQueues(input.ctx.browser, input.target.targetId, input.sessionId, route.queue);
  if (!canDispatchQueuedWheel(input, route)) return MOUSE_INPUT_NOT_HANDLED;
  input.assertExpected(input.target);
  configureWheelDispatch(input.ctx, input.target, input.sessionId, route.queue);
  return route.queue.enqueue(input.init);
}

function canDispatchQueuedWheel(input: MouseInputContext, route: WheelQueueRoute): boolean {
  return (
    currentWheelQueueOwner(input, route) &&
    route.queue.isAccepting &&
    input.target.wheelTeardownDepth === 0
  );
}

function currentWheelQueueOwner(input: MouseInputContext, route: WheelQueueRoute): boolean {
  return route.ownerScreencast
    ? ownerScreencastQueueMatches(route.ownerScreencast, route.queue, input.sessionId)
    : terminalSceneWheelQueue(input.ctx.browser, input.target.targetId, input.sessionId) ===
        route.queue;
}

async function flushUnqueuedWheel(
  input: MouseInputContext,
): Promise<unknown | typeof MOUSE_INPUT_NOT_HANDLED> {
  await waitForWheelHandoffDrain(input.ctx.browser, input.target.targetId, input.sessionId);
  await flushWheelQueues(input.ctx.browser, input.target.targetId, input.sessionId);
  if (input.target.wheelTeardownDepth > 0) return {};
  return MOUSE_INPUT_NOT_HANDLED;
}

function ownedScreencast(
  stream: ScreencastState | undefined,
  sessionId: string | undefined,
): ScreencastState | null {
  if (stream && stream.ownerSessionId === (sessionId || undefined)) return stream;
  return null;
}

function ownerScreencastQueueMatches(
  stream: ScreencastState,
  queue: WheelQueue,
  sessionId: string | undefined,
): boolean {
  return stream.wheelQueue === queue && stream.ownerSessionId === (sessionId || undefined);
}

async function dispatchNonWheelMouse(input: MouseInputContext): Promise<unknown> {
  const releases = await prepareNonWheelMouse(input);
  if (!releases) return {};
  input.fences.releases = releases;
  await flushPendingMove(input.ctx, input.target);
  return dispatchMouseWithFences(input);
}

async function prepareNonWheelMouse(input: MouseInputContext): Promise<Array<() => void> | null> {
  await waitForWheelHandoffDrain(input.ctx.browser, input.target.targetId, input.sessionId);
  return fenceWheelQueues(input.ctx.browser, input.target.targetId, input.sessionId);
}

async function dispatchMouseWithFences(input: MouseInputContext): Promise<Record<string, never>> {
  try {
    await dispatchMouseSequence(input);
    return {};
  } catch (err) {
    input.assertExpected(input.target);
    console.warn("kitesurf: Input.dispatchMouseEvent forward failed:", inputErrorMessage(err));
    return {};
  } finally {
    releaseWheelFenceState(input.fences);
  }
}

async function dispatchMouseSequence(input: MouseInputContext): Promise<void> {
  input.assertExpected(input.target);
  const result = await input.target.pageScript.dispatchMouseEvent(input.eventType, input.init);
  emitConsole(input.ctx, result.console, input.sessionId);
  emitMutations(input.ctx, input.target, result.cdpMutations);
  if (input.params.type !== "mouseReleased") {
    releaseWheelFenceState(input.fences);
    await maybeFollowAnchor(input.ctx, result, input.sessionId);
  }
  if (isContextMenuPress(input.params)) {
    await dispatchContextMenu(input);
  }
  if (input.params.type === "mouseReleased") {
    await dispatchReleasedClick(input, result);
  }
}

function isContextMenuPress(params: MouseInputParams): boolean {
  return params.type === "mousePressed" && params.button === "right";
}

async function dispatchContextMenu(input: MouseInputContext): Promise<void> {
  input.assertExpected(input.target);
  const result = await input.target.pageScript.dispatchMouseEvent("contextmenu", input.init);
  emitConsole(input.ctx, result.console, input.sessionId);
  emitMutations(input.ctx, input.target, result.cdpMutations);
}

async function dispatchReleasedClick(
  input: MouseInputContext,
  mouseResult: DispatchMouseResult,
): Promise<void> {
  const clickCount = mouseClickCount(input.params);
  const primary = isPrimaryClick(input.params);
  const clickInit = { ...input.init, detail: clickCount };
  const clickResult = await dispatchClick(input, clickInit, primary);
  if (primary && clickCount === 2) {
    await dispatchDoubleClick(input, clickInit);
  }
  releaseWheelFenceState(input.fences);
  await maybeFollowAnchor(
    input.ctx,
    clickNavigationResult(mouseResult, clickResult),
    input.sessionId,
  );
}

function mouseClickCount(params: MouseInputParams): number {
  const count = params.clickCount ?? 0;
  return count > 0 ? count : 1;
}

function isPrimaryClick(params: MouseInputParams): boolean {
  return params.button === "left" || params.button === undefined;
}

async function dispatchClick(
  input: MouseInputContext,
  init: MouseEventInit,
  primary: boolean,
): Promise<DispatchMouseResult> {
  input.assertExpected(input.target);
  const eventType = primary ? "click" : "auxclick";
  const result = await input.target.pageScript.dispatchMouseEvent(eventType, init);
  emitConsole(input.ctx, result.console, input.sessionId);
  emitMutations(input.ctx, input.target, result.cdpMutations);
  return result;
}

async function dispatchDoubleClick(input: MouseInputContext, init: MouseEventInit): Promise<void> {
  input.assertExpected(input.target);
  const result = await input.target.pageScript.dispatchMouseEvent("dblclick", init);
  emitConsole(input.ctx, result.console, input.sessionId);
  emitMutations(input.ctx, input.target, result.cdpMutations);
}

function clickNavigationResult(
  mouseResult: DispatchMouseResult,
  clickResult: DispatchMouseResult,
): typeof mouseResult {
  return hasNavigationResult(clickResult) ? clickResult : mouseResult;
}

function hasNavigationResult(result: DispatchMouseResult): boolean {
  return Boolean(result.navigatePost || result.navigateTo || result.hashNavigateTo);
}

function releaseWheelFences(releases: Array<() => void>): void {
  for (const release of releases) release();
}

function releaseWheelFenceState(fences: WheelFenceState): void {
  releaseWheelFences(fences.releases);
  fences.releases = [];
}

function inputErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function handleKeyInput(
  ctx: DispatchCtx,
  req: KeyInputRequest,
  assertExpected: ExpectedTargetCheck,
): Promise<Record<string, never>> {
  const target = pageInputTarget(ctx, req.sessionId);
  if (!target) return {};
  await waitForWheelHandoffDrain(ctx.browser, target.targetId, req.sessionId);
  const params = handleInputParams(req.params, req.method);
  const eventType = mapKeyType(params.type);
  if (!eventType) return {};
  const init = keyEventInit(ctx, params);
  const releases = await fenceWheelQueues(ctx.browser, target.targetId, req.sessionId);
  if (!releases) return {};
  return dispatchKeyInput(ctx, target, eventType, init, releases, assertExpected, req.sessionId);
}

async function dispatchKeyInput(
  ctx: DispatchCtx,
  target: PageInputTarget,
  eventType: string,
  init: ReturnType<typeof keyEventInit>,
  releases: Array<() => void>,
  assertExpected: ExpectedTargetCheck,
  sessionId: string | undefined,
): Promise<Record<string, never>> {
  try {
    assertExpected(target);
    const result = await target.pageScript.dispatchKeyEvent(eventType, init);
    emitConsole(ctx, result.console, sessionId);
    emitMutations(ctx, target, result.cdpMutations);
    releaseWheelFences(releases);
    await maybeFollowAnchor(ctx, result, sessionId);
    return {};
  } catch (err) {
    assertExpected(target);
    console.warn("kitesurf: Input.dispatchKeyEvent forward failed:", inputErrorMessage(err));
    return {};
  } finally {
    releaseWheelFences(releases);
  }
}

function keyEventInit(ctx: DispatchCtx, params: KeyInputParams) {
  return {
    bubbles: true,
    cancelable: true,
    ...keyIdentity(params),
    ...keyValueFields(params),
    altKey: hasModifier(params.modifiers, 1),
    ctrlKey: hasModifier(params.modifiers, 2),
    metaKey: hasModifier(params.modifiers, 4),
    shiftKey: hasModifier(params.modifiers, 8),
    ...keyEventState(ctx, params),
  };
}

function keyIdentity(params: KeyInputParams): { key: string; code: string } {
  return { key: params.key ?? "", code: params.code ?? "" };
}

function keyValueFields(params: KeyInputParams): { keyCode: number; text: string } {
  return { keyCode: params.windowsVirtualKeyCode ?? 0, text: params.text ?? "" };
}

function keyEventState(
  ctx: DispatchCtx,
  params: KeyInputParams,
): { location: number; repeat: boolean; ttyKeyboard: boolean } {
  return {
    location: params.location ?? 0,
    repeat: params.autoRepeat === true,
    ttyKeyboard: ctx.browser.ttyKeyboard || !!ctx.browser.ttyUaCss,
  };
}

async function handleInsertText(
  ctx: DispatchCtx,
  req: InsertTextRequest,
  assertExpected: ExpectedTargetCheck,
): Promise<Record<string, never>> {
  const target = pageInputTarget(ctx, req.sessionId);
  if (!target) return {};
  await waitForWheelHandoffDrain(ctx.browser, target.targetId, req.sessionId);
  const text = handleInputParams(req.params, req.method).text;
  if (!text) return {};
  const releases = await fenceWheelQueues(ctx.browser, target.targetId, req.sessionId);
  if (!releases) return {};
  return dispatchInsertedText(ctx, target, text, releases, assertExpected, req.sessionId);
}

async function dispatchInsertedText(
  ctx: DispatchCtx,
  target: PageInputTarget,
  text: string,
  releases: Array<() => void>,
  assertExpected: ExpectedTargetCheck,
  sessionId: string | undefined,
): Promise<Record<string, never>> {
  try {
    assertExpected(target);
    const result = await target.pageScript.dispatchKeyEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "",
      code: "",
      text,
    });
    emitConsole(ctx, result.console, sessionId);
    emitMutations(ctx, target, result.cdpMutations);
  } catch (err) {
    assertExpected(target);
    console.warn("kitesurf: Input.insertText forward failed:", inputErrorMessage(err));
  } finally {
    releaseWheelFences(releases);
  }
  return {};
}

function scheduleMouseMove(
  ctx: DispatchCtx,
  target: TargetState,
  init: MouseEventInit,
  sessionId: string | undefined,
): void {
  const targetId = target.targetId;
  const state = mouseMoveStateFor(targetId);
  const now = Date.now();
  const sinceLast = now - state.lastDispatchAt;
  if (canDispatchMouseMoveNow(state, sinceLast)) {
    dispatchImmediateMouseMove(ctx, target, state, init, sessionId, now);
    return;
  }
  schedulePendingMouseMove(ctx, target, state, init, sessionId, sinceLast);
}

function mouseMoveStateFor(targetId: string): MouseMoveDebounce {
  let state = mouseMoveDebounce.get(targetId);
  if (!state) {
    state = { lastDispatchAt: 0, pending: null, timerHandle: 0 };
    mouseMoveDebounce.set(targetId, state);
  }
  return state;
}

function canDispatchMouseMoveNow(state: MouseMoveDebounce, sinceLast: number): boolean {
  return sinceLast >= MOUSE_MOVE_THROTTLE_MS && state.pending === null;
}

function dispatchImmediateMouseMove(
  ctx: DispatchCtx,
  target: TargetState,
  state: MouseMoveDebounce,
  init: MouseEventInit,
  sessionId: string | undefined,
  now: number,
): void {
  if (state.timerHandle) {
    clearTimeout(state.timerHandle);
    state.timerHandle = 0;
  }
  state.lastDispatchAt = now;
  void dispatchMouseMove(ctx, target, init, sessionId);
}

function schedulePendingMouseMove(
  ctx: DispatchCtx,
  target: TargetState,
  state: MouseMoveDebounce,
  init: MouseEventInit,
  sessionId: string | undefined,
  sinceLast: number,
): void {
  state.pending = { init, sessionId };
  if (state.timerHandle !== 0) return;
  const wait = Math.max(1, MOUSE_MOVE_THROTTLE_MS - sinceLast);
  state.timerHandle = setTimeout(() => {
    void flushPendingMove(ctx, target);
  }, wait);
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
    const matched = targetForSession(ctx, sessionId);
    if (matched) return matched;
  }
  return firstPageTarget(ctx);
}

function targetForSession(ctx: DispatchCtx, sessionId: string): TargetState | undefined {
  for (const target of ctx.browser.targets.values()) {
    if (target.sessions.has(sessionId)) return target;
  }
  return undefined;
}

function firstPageTarget(ctx: DispatchCtx): TargetState | undefined {
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
  emitConsoleEntries(ctx, entries, ctxId, sessionId);
}

function emitConsoleEntries(
  ctx: DispatchCtx,
  entries: ConsoleEntry[],
  contextId: number,
  sessionId: string | undefined,
): void {
  for (const entry of entries) {
    const ev = consoleEntryToCdpEvent(entry, contextId);
    ctx.emit({ method: ev.method, params: ev.params, sessionId });
  }
}

type InternalNavigateRequest = Extract<CdpRequest, { method: "Page.navigate" }>;
type InternalNavigateParams = NonNullable<InternalNavigateRequest["params"]>;
type PostNavigation = NonNullable<DispatchMouseResult["navigatePost"]>;

async function maybeFollowAnchor(
  ctx: DispatchCtx,
  result: DispatchMouseResult | null | undefined,
  sessionId: string | undefined,
): Promise<void> {
  const post = postNavigation(result);
  if (post) {
    await followPostNavigation(ctx, post, sessionId);
    return;
  }
  const url = anchorNavigation(result);
  if (url) {
    await followUrlNavigation(ctx, url, sessionId);
    return;
  }
  await followHashNavigation(ctx, hashNavigation(result), sessionId);
}

function postNavigation(result: DispatchMouseResult | null | undefined): PostNavigation | null {
  const post = result?.navigatePost;
  if (!post || typeof post.url !== "string") return null;
  return post;
}

function anchorNavigation(result: DispatchMouseResult | null | undefined): string | null {
  const url = result?.navigateTo;
  if (typeof url === "string" && url.length > 0) return url;
  return null;
}

function hashNavigation(result: DispatchMouseResult | null | undefined): string | null {
  const url = result?.hashNavigateTo;
  if (typeof url === "string" && url.length > 0) return url;
  return null;
}

async function followPostNavigation(
  ctx: DispatchCtx,
  post: PostNavigation,
  sessionId: string | undefined,
): Promise<void> {
  const params: InternalNavigateParams = {
    url: post.url,
    _kitesurfInternal: true,
    _kitesurfPostData: post.postData ?? "",
    _kitesurfPostContentType: post.postContentType ?? "application/x-www-form-urlencoded",
  };
  await dispatchInternalNavigate(
    ctx,
    params,
    sessionId,
    "kitesurf: form-POST Page.navigate failed:",
  );
}

async function followUrlNavigation(
  ctx: DispatchCtx,
  url: string,
  sessionId: string | undefined,
): Promise<void> {
  const params: InternalNavigateParams = { url, _kitesurfInternal: true };
  await dispatchInternalNavigate(
    ctx,
    params,
    sessionId,
    "kitesurf: anchor-follow Page.navigate failed:",
  );
}

async function dispatchInternalNavigate(
  ctx: DispatchCtx,
  params: InternalNavigateParams,
  sessionId: string | undefined,
  warning: string,
): Promise<void> {
  const { dispatch } = await import("./dispatch.ts");
  try {
    await dispatch(ctx, { id: -1, method: "Page.navigate", params, sessionId });
  } catch (err) {
    console.warn(warning, inputErrorMessage(err));
  }
}

function followHashNavigation(
  ctx: DispatchCtx,
  url: string | null,
  sessionId: string | undefined,
): void {
  if (!url) return;
  const target = pickTarget(ctx, sessionId);
  if (!target) return;
  target.url = url;
  const frame = updateHashFrame(target);
  ctx.emit({
    method: "Page.frameNavigated",
    params: { frame: makeFrameInfo(frame), type: "Navigation" },
    sessionId,
  });
}

function updateHashFrame(target: TargetState) {
  const main = target.frames.get(target.frameId);
  if (main) {
    main.url = target.url;
    main.securityOrigin = originOfUrl(target.url);
  }
  return (
    main ??
    makeMainFrameState({
      frameId: target.frameId,
      loaderId: target.loaderId,
      url: target.url,
    })
  );
}

function originOfUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}
