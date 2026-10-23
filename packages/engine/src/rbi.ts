// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Streams RBI scene frames and resources with acknowledgement-based backpressure. Clients get
// recorded vector scenes, not pixels, and rasterize them with the scene-host wasm. Each envelope
// below reaches CDP clients base64-encoded in a `Kitesurf.sceneFrame` event (cdp/scene-stream.ts).

import type { QueryDomResult } from "./cdp/page-session.ts";
import { traceSpan, type Tracer } from "./tracing.ts";

// Envelope byte 0. Info carries JSON: `sceneAlive` heartbeats and `sceneReset` on navigation.
const MSG_INFO = 2;
const MSG_SCENE = 3;
// A resource batch in the format rbi-protocol.ts describes, sent before the scene that needs it.
const MSG_RESOURCES = 4;
const MSG_PARTIAL = 5;
// Envelope byte 1; byte 2 holds flags and is always 0.
const CODEC_SCENE = 2;

// [type u8][codec u8][flags u8][seq u32 LE][width u16 LE][height u16 LE], then the payload.
const SCENE_ENVELOPE_HEADER_BYTES = 11;
const SCENE_ENVELOPE_SEQUENCE_OFFSET = 3;
const SCENE_ENVELOPE_WIDTH_OFFSET = 7;
const SCENE_ENVELOPE_HEIGHT_OFFSET = 9;
// A partial adds clip x/y/width/height and the base sequence as i32 LE after the header. The clip
// is in viewport space: the recorder reports document space and the sender subtracts the scroll,
// so the client keeps no scroll state. The client must have painted `baseSeq` to composite.
const PARTIAL_ENVELOPE_METADATA_BYTES = 20;
const PARTIAL_CLIP_X_OFFSET = 11;
const PARTIAL_CLIP_Y_OFFSET = 15;
const PARTIAL_CLIP_WIDTH_OFFSET = 19;
const PARTIAL_CLIP_HEIGHT_OFFSET = 23;
const PARTIAL_BASE_SEQUENCE_OFFSET = 27;
const PARTIAL_PAYLOAD_OFFSET = 31;

function infoEnvelope(obj: Record<string, unknown>): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  const out = new Uint8Array(SCENE_ENVELOPE_HEADER_BYTES + json.length);
  out[0] = MSG_INFO;
  out.set(json, SCENE_ENVELOPE_HEADER_BYTES);
  return out;
}

function sceneEnvelope(
  msgType: typeof MSG_SCENE | typeof MSG_RESOURCES,
  seq: number,
  w: number,
  h: number,
  payload: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(SCENE_ENVELOPE_HEADER_BYTES + payload.length);
  const dv = new DataView(out.buffer);
  out[0] = msgType;
  out[1] = CODEC_SCENE;
  out[2] = 0;
  dv.setUint32(SCENE_ENVELOPE_SEQUENCE_OFFSET, seq >>> 0, true);
  dv.setUint16(SCENE_ENVELOPE_WIDTH_OFFSET, w, true);
  dv.setUint16(SCENE_ENVELOPE_HEIGHT_OFFSET, h, true);
  out.set(payload, SCENE_ENVELOPE_HEADER_BYTES);
  return out;
}

function partialEnvelope(
  seq: number,
  clip: { x: number; y: number; w: number; h: number },
  baseSeq: number,
  payload: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(
    SCENE_ENVELOPE_HEADER_BYTES + PARTIAL_ENVELOPE_METADATA_BYTES + payload.length,
  );
  const dv = new DataView(out.buffer);
  out[0] = MSG_PARTIAL;
  out[1] = CODEC_SCENE;
  out[2] = 0;
  dv.setUint32(SCENE_ENVELOPE_SEQUENCE_OFFSET, seq >>> 0, true);
  dv.setUint16(SCENE_ENVELOPE_WIDTH_OFFSET, clip.w & 0xffff, true);
  dv.setUint16(SCENE_ENVELOPE_HEIGHT_OFFSET, clip.h & 0xffff, true);
  dv.setInt32(PARTIAL_CLIP_X_OFFSET, clip.x | 0, true);
  dv.setInt32(PARTIAL_CLIP_Y_OFFSET, clip.y | 0, true);
  dv.setInt32(PARTIAL_CLIP_WIDTH_OFFSET, clip.w | 0, true);
  dv.setInt32(PARTIAL_CLIP_HEIGHT_OFFSET, clip.h | 0, true);
  dv.setInt32(PARTIAL_BASE_SEQUENCE_OFFSET, baseSeq | 0, true);
  out.set(payload, PARTIAL_PAYLOAD_OFFSET);
  return out;
}

export interface SceneFlow {
  sent: number;
  acked: number;
  outstanding: Map<number, number>;
  needFull: boolean;
  paintDirty?: boolean;
  wake?: () => void;
}

export function wakeSceneFlow(flow: SceneFlow): void {
  flow.paintDirty = true;
  flow.wake?.();
}

// Acks are claimed, not counted: the client is untrusted, so a forged or repeated ack must not
// push `sent - acked` negative and wedge the credit gate open. Recovery may resend a mutation
// sequence, so outstanding frames are a per-sequence count.
export function claimSceneAck(flow: SceneFlow, seq: unknown): boolean {
  if (!isSceneAckSequence(seq)) return false;
  const n = flow.outstanding.get(seq);
  if (!n) return false;
  if (n === 1) flow.outstanding.delete(seq);
  else flow.outstanding.set(seq, n - 1);
  flow.acked = Math.min(flow.acked + 1, flow.sent);
  flow.wake?.();
  return true;
}

function isSceneAckSequence(seq: unknown): seq is number {
  return typeof seq === "number" && Number.isFinite(seq);
}

function trackSceneSent(flow: SceneFlow, seq: number): void {
  flow.sent++;
  flow.outstanding.set(seq, (flow.outstanding.get(seq) ?? 0) + 1);
}

const MIN_FRAME_INTERVAL_MS = 16;
const MAX_FRAME_TRACE_SPANS = 600;
const PUMP_STATS_CALL_INTERVAL = 100;
// Sent as `sceneAlive` when nothing else went out, even while a record is pending or credits are
// exhausted. Heartbeats take no credit and no ack; they prove the stream is alive, not progress.
export const SCENE_HEARTBEAT_MS = 1_000;
const FRAME_WAIT_SLICE_MS = 8;
const SCENE_CREDIT_POLL_MS = 4;
const MILLISECONDS_PER_SECOND = 1_000;

// Two unacked frames overlap the server's record with the client's raster and the round trip;
// more adds latency, not frame rate.
const MAX_SCENES_IN_FLIGHT = 2;

type RecordSceneReply = QueryDomResult<"recordScene">;
type RecordScene = (args: {
  producer?: "client";
  sinceSeq: number;
  allowPartial: boolean;
  baseSeq: number;
  inlineResources: boolean;
  pumpRaf: boolean;
  frameIntervalMs: number;
  armWake: boolean;
  haveImages?: Uint8Array;
  haveFonts?: Uint8Array;
}) => Promise<RecordSceneReply>;

interface SceneLoopOptions {
  w: number;
  h: number;
  fps: number;
  text: boolean;
  allowPartial?: boolean;
  now?: () => number;
  canIdle?: () => boolean;
}

interface SceneLoopContext {
  recordScene: RecordScene;
  server: Pick<WebSocket, "send">;
  isClosed: () => boolean;
  flow: SceneFlow;
  opts: SceneLoopOptions;
  getGeneration: () => number;
  tracer: Tracer | undefined;
  clock: () => number;
}

interface PendingFrame {
  seq: number;
  bytes: Uint8Array;
  resBytes: Uint8Array | null;
  partial: boolean;
  clip: { x: number; y: number; w: number; h: number } | null;
  baseSeq: number;
  recordMs: number;
  tRecordDone: number;
  w: number;
  h: number;
}

interface PumpStats {
  calls: number;
  pumpMsTotal: number;
  byVal: Record<number, number>;
}

interface SceneLoopState {
  period: number;
  generation: number;
  wireBase: number;
  maxWireSeq: number;
  lastSeq: number;
  paintedSeq: number;
  lastFullScene: {
    bytes: Uint8Array;
    resources?: Uint8Array;
    scrollX: number;
    scrollY: number;
  } | null;
  due: number;
  idleUntil: number;
  creditWaitMs: number;
  fpsWaitMs: number;
  lastSendAt: number;
  lastWireAt: number;
  spanBudget: number;
  pumpStats: PumpStats;
  pending: PendingFrame | null;
  forceFull: boolean;
}

type SceneLoopStep = "continue" | "stop";
type SceneReadyStep = SceneLoopStep | "record";

interface RecordRequest {
  kind: "record";
  promise: Promise<RecordSceneReply>;
}

interface StopRecordRequest {
  kind: "stop";
}

type RecordRequestStart = RecordRequest | StopRecordRequest;

interface RecordAwaitResult {
  reply: RecordSceneReply;
  heartbeatFailed: boolean;
}

interface RecordSceneCompletion {
  reply: RecordSceneReply;
  forceFull: boolean;
  tRecordStart: number;
  tRecordDone: number;
  recordedW: number;
  recordedH: number;
}

function createSceneLoopState(context: SceneLoopContext): SceneLoopState {
  return {
    period: Math.max(MIN_FRAME_INTERVAL_MS, Math.floor(MILLISECONDS_PER_SECOND / context.opts.fps)),
    generation: context.getGeneration(),
    wireBase: 0,
    maxWireSeq: -1,
    lastSeq: -1,
    paintedSeq: -1,
    lastFullScene: null,
    due: 0,
    idleUntil: 0,
    creditWaitMs: 0,
    fpsWaitMs: 0,
    lastSendAt: 0,
    lastWireAt: 0,
    spanBudget: MAX_FRAME_TRACE_SPANS,
    pumpStats: { calls: 0, pumpMsTotal: 0, byVal: {} },
    pending: null,
    forceFull: false,
  };
}

function sleepWithSceneWake(flow: SceneFlow, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      if (flow.wake === wake) flow.wake = undefined;
      resolve();
    };
    let timer = setTimeout(done, ms);
    const wake = () => {
      clearTimeout(timer);
      // Yield through a timer even for ACKs, so a fast client cannot starve other work.
      timer = setTimeout(done, 0);
    };
    flow.wake = wake;
  });
}

function resetSceneGeneration(context: SceneLoopContext, state: SceneLoopState): boolean {
  const current = context.getGeneration();
  if (current === state.generation) return false;
  state.generation = current;
  state.pending = null;
  state.lastSeq = -1;
  state.paintedSeq = -1;
  state.lastFullScene = null;
  state.idleUntil = 0;
  state.due = 0;
  // Wire sequences stay monotonic although PageScript sequences reset on navigation.
  state.wireBase = state.maxWireSeq + 1;
  context.flow.sent = 0;
  context.flow.acked = 0;
  context.flow.outstanding.clear();
  context.flow.needFull = false;
  context.server.send(infoEnvelope({ t: "sceneReset" }));
  return true;
}

function sendSceneHeartbeat(context: SceneLoopContext, state: SceneLoopState): boolean {
  if (context.clock() - state.lastWireAt < SCENE_HEARTBEAT_MS) return true;
  // A heartbeat proves stream liveness; it does not finish the pending record.
  try {
    context.server.send(infoEnvelope({ t: "sceneAlive" }));
  } catch {
    return false;
  }
  state.lastWireAt = context.clock();
  return true;
}

function sendPendingFrame(context: SceneLoopContext, frame: PendingFrame): boolean {
  try {
    if (frame.resBytes) {
      context.server.send(sceneEnvelope(MSG_RESOURCES, 0, frame.w, frame.h, frame.resBytes));
    }
    if (frame.partial && frame.clip) {
      context.server.send(partialEnvelope(frame.seq, frame.clip, frame.baseSeq, frame.bytes));
    } else {
      context.server.send(sceneEnvelope(MSG_SCENE, frame.seq, frame.w, frame.h, frame.bytes));
    }
  } catch {
    return false;
  }
  return true;
}

function tracePendingFrame(
  context: SceneLoopContext,
  state: SceneLoopState,
  frame: PendingFrame,
  sentAt: number,
): void {
  if (!context.tracer || state.spanBudget <= 0) return;
  state.spanBudget--;
  traceSpan(context.tracer, "rbi.frame", () => {}, {
    seq: frame.seq,
    partial: frame.partial,
    sceneBytes: frame.bytes.length,
    resBytes: frame.resBytes ? frame.resBytes.length : 0,
    recordMs: frame.recordMs,
    sendLagMs: sentAt - frame.tRecordDone,
    creditWaitMs: state.creditWaitMs,
    fpsWaitMs: state.fpsWaitMs,
    interFrameMs: state.lastSendAt > 0 ? sentAt - state.lastSendAt : 0,
    inFlight: context.flow.sent - context.flow.acked,
  });
}

function flushPendingFrame(context: SceneLoopContext, state: SceneLoopState): boolean {
  const frame = state.pending;
  if (!frame) return true;
  state.pending = null;
  if (!sendPendingFrame(context, frame)) return false;
  const sentAt = context.clock();
  tracePendingFrame(context, state, frame, sentAt);
  state.lastSendAt = sentAt;
  state.lastWireAt = sentAt;
  state.creditWaitMs = 0;
  state.fpsWaitMs = 0;
  return true;
}

function canWaitForIdle(context: SceneLoopContext, state: SceneLoopState, now: number): boolean {
  return (
    state.idleUntil > now &&
    !context.flow.paintDirty &&
    !context.flow.needFull &&
    context.opts.canIdle?.() !== false
  );
}

async function waitInIdleWindow(
  context: SceneLoopContext,
  state: SceneLoopState,
  now: number,
): Promise<boolean> {
  if (!flushPendingFrame(context, state) || !sendSceneHeartbeat(context, state)) return false;
  if (context.flow.paintDirty || context.flow.needFull) return true;
  await sleepWithSceneWake(
    context.flow,
    Math.min(state.idleUntil - now, SCENE_HEARTBEAT_MS - (context.clock() - state.lastWireAt)),
  );
  return true;
}

async function waitForFramePeriod(
  context: SceneLoopContext,
  state: SceneLoopState,
  now: number,
): Promise<boolean> {
  if (!flushPendingFrame(context, state)) return false;
  const startedAt = context.clock();
  await sleepWithSceneWake(context.flow, Math.min(state.due - now, FRAME_WAIT_SLICE_MS));
  state.fpsWaitMs += context.clock() - startedAt;
  return true;
}

async function waitForSceneCredit(
  context: SceneLoopContext,
  state: SceneLoopState,
): Promise<boolean> {
  if (!flushPendingFrame(context, state)) return false;
  if (!sendSceneHeartbeat(context, state)) return false;
  const startedAt = context.clock();
  await sleepWithSceneWake(context.flow, SCENE_CREDIT_POLL_MS);
  state.creditWaitMs += context.clock() - startedAt;
  return true;
}

async function waitForIdleIfNeeded(
  context: SceneLoopContext,
  state: SceneLoopState,
  now: number,
): Promise<SceneLoopStep | null> {
  if (!canWaitForIdle(context, state, now)) return null;
  return (await waitInIdleWindow(context, state, now)) ? "continue" : "stop";
}

async function waitForFramePeriodIfNeeded(
  context: SceneLoopContext,
  state: SceneLoopState,
  now: number,
): Promise<SceneLoopStep | null> {
  if (now >= state.due) return null;
  return (await waitForFramePeriod(context, state, now)) ? "continue" : "stop";
}

async function waitForCreditIfNeeded(
  context: SceneLoopContext,
  state: SceneLoopState,
): Promise<SceneLoopStep | null> {
  if (context.flow.sent - context.flow.acked < MAX_SCENES_IN_FLIGHT) return null;
  return (await waitForSceneCredit(context, state)) ? "continue" : "stop";
}

function beginSceneFrame(context: SceneLoopContext, state: SceneLoopState, now: number): void {
  state.due = now + state.period;
  state.forceFull = context.flow.needFull;
  if (state.forceFull) {
    context.flow.needFull = false;
    state.paintedSeq = -1;
    state.lastFullScene = null;
    state.lastSeq = -1;
  }
}

async function waitForSceneFrame(
  context: SceneLoopContext,
  state: SceneLoopState,
): Promise<SceneReadyStep> {
  const now = context.clock();
  const idle = await waitForIdleIfNeeded(context, state, now);
  if (idle !== null) return idle;
  state.idleUntil = 0;
  const period = await waitForFramePeriodIfNeeded(context, state, now);
  if (period !== null) return period;
  const credit = await waitForCreditIfNeeded(context, state);
  if (credit !== null) return credit;
  beginSceneFrame(context, state, now);
  return "record";
}

function recordSceneArguments(context: SceneLoopContext, state: SceneLoopState) {
  return {
    ...(context.opts.text ? { producer: "client" as const } : {}),
    sinceSeq: state.lastSeq,
    allowPartial: !context.opts.text && context.opts.allowPartial !== false,
    baseSeq: state.paintedSeq < 0 ? -1 : state.paintedSeq - state.wireBase,
    inlineResources: true,
    // Deployed isolates can defer timer wakes under CPU load, so each record also runs
    // overdue rAF callbacks and timers; the scene stream doubles as the page's vsync.
    pumpRaf: true,
    frameIntervalMs: state.period,
    armWake: context.opts.canIdle?.() !== false,
  };
}

function startSceneRecord(context: SceneLoopContext, state: SceneLoopState): RecordRequestStart {
  const promise = context.recordScene(recordSceneArguments(context, state));
  if (resetSceneGeneration(context, state)) return { kind: "record", promise };
  if (!flushPendingFrame(context, state)) return { kind: "stop" };
  return { kind: "record", promise };
}

async function awaitSceneRecord(
  context: SceneLoopContext,
  state: SceneLoopState,
  promise: Promise<RecordSceneReply>,
): Promise<RecordAwaitResult> {
  let heartbeatFailed = false;
  const heartbeat = setInterval(() => {
    if (context.isClosed() || !sendSceneHeartbeat(context, state)) {
      heartbeatFailed = true;
      clearInterval(heartbeat);
    }
  }, SCENE_HEARTBEAT_MS);
  try {
    const reply = await promise;
    return { reply, heartbeatFailed };
  } finally {
    clearInterval(heartbeat);
  }
}

function shouldMarkSceneIdle(reply: RecordSceneReply, flow: SceneFlow): boolean {
  return reply.idle === true && !reply.error && !flow.paintDirty && hasIdleSceneContent(reply);
}

function hasIdleSceneContent(reply: RecordSceneReply): boolean {
  return Boolean(reply.unchanged || reply.scene?.length);
}

function applySceneReplyTiming(
  context: SceneLoopContext,
  state: SceneLoopState,
  reply: RecordSceneReply,
  tRecordDone: number,
): void {
  if (reply.nextRafDelayMs !== undefined && reply.nextRafDelayMs > 0) {
    state.due = Math.min(state.due, tRecordDone + reply.nextRafDelayMs);
  }
  if (shouldMarkSceneIdle(reply, context.flow)) {
    state.idleUntil = tRecordDone + SCENE_HEARTBEAT_MS;
  }
}

function updatePumpStats(
  context: SceneLoopContext,
  state: SceneLoopState,
  reply: RecordSceneReply,
): void {
  const { pumpStats } = state;
  pumpStats.calls++;
  const pumped = typeof reply.pumped === "number" ? reply.pumped : -1;
  pumpStats.byVal[pumped] = (pumpStats.byVal[pumped] ?? 0) + 1;
  pumpStats.pumpMsTotal += reply.pumpMs ?? 0;
  if (pumpStats.calls % PUMP_STATS_CALL_INTERVAL === 0) sendPumpStats(context, pumpStats);
}

function sendPumpStats(context: SceneLoopContext, pumpStats: PumpStats): void {
  try {
    context.server.send(
      infoEnvelope({
        t: "pumpStats",
        pumpMsTotal: pumpStats.pumpMsTotal,
        ...pumpStats.byVal,
      }),
    );
  } catch {}
}

function sceneReplyBytes(reply: RecordSceneReply): Uint8Array | null {
  if (reply.error || reply.unchanged || !reply.scene || reply.scene.length === 0) return null;
  return reply.scene;
}

function handleUnpaintableSceneReply(
  context: SceneLoopContext,
  state: SceneLoopState,
  reply: RecordSceneReply,
): SceneLoopStep {
  if (typeof reply.seq === "number") state.lastSeq = reply.seq;
  if (reply.error) return "continue";
  return sendSceneHeartbeat(context, state) ? "continue" : "stop";
}

function sameSceneBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  return (
    a === b ||
    (a !== undefined &&
      b !== undefined &&
      a.length === b.length &&
      a.every((value, index) => value === b[index]))
  );
}

function sameSceneViewport(
  previous: NonNullable<SceneLoopState["lastFullScene"]>,
  reply: RecordSceneReply,
): boolean {
  return previous.scrollX === (reply.scrollX ?? 0) && previous.scrollY === (reply.scrollY ?? 0);
}

function sameScenePayload(
  previous: NonNullable<SceneLoopState["lastFullScene"]>,
  resources: Uint8Array | undefined,
  bytes: Uint8Array,
): boolean {
  return sameSceneBytes(previous.resources, resources) && sameSceneBytes(previous.bytes, bytes);
}

function isDuplicateFullScene(
  state: SceneLoopState,
  forceFull: boolean,
  reply: RecordSceneReply,
  full: boolean,
  resources: Uint8Array | undefined,
  bytes: Uint8Array,
): boolean {
  if (!full) return false;
  if (forceFull) return false;
  const previous = state.lastFullScene;
  if (!previous) return false;
  return sameSceneViewport(previous, reply) && sameScenePayload(previous, resources, bytes);
}

function duplicateSceneStep(
  context: SceneLoopContext,
  state: SceneLoopState,
  forceFull: boolean,
  reply: RecordSceneReply,
  full: boolean,
  resources: Uint8Array | undefined,
  bytes: Uint8Array,
): SceneLoopStep | null {
  if (!isDuplicateFullScene(state, forceFull, reply, full, resources, bytes)) return null;
  return sendSceneHeartbeat(context, state) ? "continue" : "stop";
}

function updateLastFullScene(
  state: SceneLoopState,
  reply: RecordSceneReply,
  full: boolean,
  resources: Uint8Array | undefined,
  bytes: Uint8Array,
): void {
  state.lastFullScene = full
    ? {
        bytes,
        resources,
        scrollX: reply.scrollX ?? 0,
        scrollY: reply.scrollY ?? 0,
      }
    : null;
}

function replyResources(reply: RecordSceneReply): Uint8Array | undefined {
  return reply.resourceBatch?.length ? reply.resourceBatch : undefined;
}

function pendingFrameClip(
  reply: RecordSceneReply,
): { x: number; y: number; w: number; h: number } | null {
  return reply.clip
    ? {
        x: reply.clip.x - (reply.scrollX ?? 0),
        y: reply.clip.y - (reply.scrollY ?? 0),
        w: reply.clip.w,
        h: reply.clip.h,
      }
    : null;
}

function pendingFrameIsPartial(reply: RecordSceneReply): boolean {
  return !!(reply.partial && reply.clip);
}

function pendingFrameBaseSequence(reply: RecordSceneReply, wireBase: number): number {
  return reply.baseSeq === undefined ? -1 : reply.baseSeq + wireBase;
}

function createPendingFrame(
  completion: RecordSceneCompletion,
  seq: number,
  resources: Uint8Array | undefined,
  bytes: Uint8Array,
  wireBase: number,
): PendingFrame {
  const { reply } = completion;
  return {
    seq,
    bytes,
    resBytes: resources ?? null,
    partial: pendingFrameIsPartial(reply),
    clip: pendingFrameClip(reply),
    baseSeq: pendingFrameBaseSequence(reply, wireBase),
    recordMs: completion.tRecordDone - completion.tRecordStart,
    tRecordDone: completion.tRecordDone,
    w: completion.recordedW,
    h: completion.recordedH,
  };
}

function queueSceneFrame(
  context: SceneLoopContext,
  state: SceneLoopState,
  completion: RecordSceneCompletion,
  seq: number,
  full: boolean,
  resources: Uint8Array | undefined,
  bytes: Uint8Array,
): void {
  const { reply } = completion;
  updateLastFullScene(state, reply, full, resources, bytes);
  state.paintedSeq = seq;
  trackSceneSent(context.flow, seq);
  state.pending = createPendingFrame(completion, seq, resources, bytes, state.wireBase);
}

function handleSceneRecordReply(
  context: SceneLoopContext,
  state: SceneLoopState,
  completion: RecordSceneCompletion,
): SceneLoopStep {
  const { reply } = completion;
  applySceneReplyTiming(context, state, reply, completion.tRecordDone);
  updatePumpStats(context, state, reply);
  const bytes = sceneReplyBytes(reply);
  if (bytes === null) return handleUnpaintableSceneReply(context, state, reply);
  return handlePaintableSceneReply(context, state, completion, reply, bytes);
}

function handlePaintableSceneReply(
  context: SceneLoopContext,
  state: SceneLoopState,
  completion: RecordSceneCompletion,
  reply: RecordSceneReply,
  bytes: Uint8Array,
): SceneLoopStep {
  state.lastSeq = reply.seq ?? 0;
  const seq = state.lastSeq + state.wireBase;
  state.maxWireSeq = Math.max(state.maxWireSeq, seq);
  const full = !(reply.partial && reply.clip);
  const resources = replyResources(reply);
  const duplicate = duplicateSceneStep(
    context,
    state,
    completion.forceFull,
    reply,
    full,
    resources,
    bytes,
  );
  if (duplicate !== null) return duplicate;
  queueSceneFrame(context, state, completion, seq, full, resources, bytes);
  return "continue";
}

type SceneRecordAttempt =
  | { kind: "record"; reply: RecordSceneReply }
  | { kind: "continue" }
  | { kind: "stop" };

async function performSceneRecord(
  context: SceneLoopContext,
  state: SceneLoopState,
): Promise<SceneRecordAttempt> {
  try {
    const started = startSceneRecord(context, state);
    if (started.kind === "stop") return { kind: "stop" };
    const awaited = await awaitSceneRecord(context, state, started.promise);
    if (awaited.heartbeatFailed || context.isClosed()) return { kind: "stop" };
    return { kind: "record", reply: awaited.reply };
  } catch {
    return { kind: "continue" };
  }
}

async function recordSceneFrame(
  context: SceneLoopContext,
  state: SceneLoopState,
): Promise<SceneLoopStep> {
  const tRecordStart = context.clock();
  const recordedW = context.opts.w;
  const recordedH = context.opts.h;
  const forceFull = state.forceFull;
  context.flow.paintDirty = false;
  const attempt = await performSceneRecord(context, state);
  if (attempt.kind !== "record") return attempt.kind;
  if (resetSceneGeneration(context, state)) return "continue";
  const tRecordDone = context.clock();
  return handleSceneRecordReply(context, state, {
    reply: attempt.reply,
    forceFull,
    tRecordStart,
    tRecordDone,
    recordedW,
    recordedH,
  });
}

async function runSceneIteration(
  context: SceneLoopContext,
  state: SceneLoopState,
): Promise<SceneLoopStep> {
  resetSceneGeneration(context, state);
  const ready = await waitForSceneFrame(context, state);
  if (ready === "stop") return "stop";
  if (ready === "continue") return "continue";
  return recordSceneFrame(context, state);
}

export async function runSceneLoop(
  recordScene: RecordScene,
  server: Pick<WebSocket, "send">,
  isClosed: () => boolean,
  flow: SceneFlow,
  opts: SceneLoopOptions,
  getGeneration: () => number,
  tracer?: Tracer,
): Promise<void> {
  const context: SceneLoopContext = {
    recordScene,
    server,
    isClosed,
    flow,
    opts,
    getGeneration,
    tracer,
    clock: opts.now ?? Date.now,
  };
  const state = createSceneLoopState(context);
  while (!isClosed()) {
    const step = await runSceneIteration(context, state);
    if (step === "stop") return;
  }
  state.pending = null;
}
