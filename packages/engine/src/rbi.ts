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
  if (typeof seq !== "number" || !Number.isFinite(seq)) return false;
  const n = flow.outstanding.get(seq);
  if (!n) return false;
  if (n === 1) flow.outstanding.delete(seq);
  else flow.outstanding.set(seq, n - 1);
  flow.acked = Math.min(flow.acked + 1, flow.sent);
  flow.wake?.();
  return true;
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

export async function runSceneLoop(
  recordScene: RecordScene,
  server: Pick<WebSocket, "send">,
  isClosed: () => boolean,
  flow: SceneFlow,
  opts: {
    w: number;
    h: number;
    fps: number;
    text: boolean;
    allowPartial?: boolean;
    now?: () => number;
    canIdle?: () => boolean;
  },
  getGeneration: () => number,
  tracer?: Tracer,
): Promise<void> {
  const clock = opts.now ?? Date.now;
  const period = Math.max(MIN_FRAME_INTERVAL_MS, Math.floor(MILLISECONDS_PER_SECOND / opts.fps));
  let generation = getGeneration();
  let wireBase = 0;
  let maxWireSeq = -1;
  let lastSeq = -1;
  let paintedSeq = -1;
  let lastFullScene: {
    bytes: Uint8Array;
    resources?: Uint8Array;
    scrollX: number;
    scrollY: number;
  } | null = null;
  let due = 0;
  let idleUntil = 0;
  let creditWaitMs = 0;
  let fpsWaitMs = 0;
  let lastSendAt = 0;
  let lastWireAt = 0;
  const sendHeartbeat = (): boolean => {
    if (clock() - lastWireAt < SCENE_HEARTBEAT_MS) return true;
    // A heartbeat proves stream liveness; it does not finish the pending record.
    try {
      server.send(infoEnvelope({ t: "sceneAlive" }));
    } catch {
      return false;
    }
    lastWireAt = clock();
    return true;
  };
  let spanBudget = MAX_FRAME_TRACE_SPANS;
  const pumpStats: {
    calls: number;
    pumpMsTotal: number;
    byVal: Record<number, number>;
  } = {
    calls: 0,
    pumpMsTotal: 0,
    byVal: {},
  };
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
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
  const sameBytes = (a: Uint8Array | undefined, b: Uint8Array | undefined) =>
    a === b ||
    (a !== undefined &&
      b !== undefined &&
      a.length === b.length &&
      a.every((value, index) => value === b[index]));
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
  let pending: PendingFrame | null = null;
  const resetGeneration = () => {
    const current = getGeneration();
    if (current === generation) return false;
    generation = current;
    pending = null;
    lastSeq = -1;
    paintedSeq = -1;
    lastFullScene = null;
    idleUntil = 0;
    due = 0;
    // Wire sequences stay monotonic although PageScript sequences reset on navigation.
    wireBase = maxWireSeq + 1;
    flow.sent = 0;
    flow.acked = 0;
    flow.outstanding.clear();
    flow.needFull = false;
    server.send(infoEnvelope({ t: "sceneReset" }));
    return true;
  };
  const flushPending = (): boolean => {
    if (!pending) return true;
    const f = pending;
    pending = null;
    try {
      if (f.resBytes) {
        server.send(sceneEnvelope(MSG_RESOURCES, 0, f.w, f.h, f.resBytes));
      }
      if (f.partial && f.clip) {
        server.send(partialEnvelope(f.seq, f.clip, f.baseSeq, f.bytes));
      } else {
        server.send(sceneEnvelope(MSG_SCENE, f.seq, f.w, f.h, f.bytes));
      }
    } catch {
      return false;
    }
    const tSent = clock();
    if (tracer && spanBudget > 0) {
      spanBudget--;
      traceSpan(tracer, "rbi.frame", () => {}, {
        seq: f.seq,
        partial: f.partial,
        sceneBytes: f.bytes.length,
        resBytes: f.resBytes ? f.resBytes.length : 0,
        recordMs: f.recordMs,
        sendLagMs: tSent - f.tRecordDone,
        creditWaitMs,
        fpsWaitMs,
        interFrameMs: lastSendAt > 0 ? tSent - lastSendAt : 0,
        inFlight: flow.sent - flow.acked,
      });
    }
    lastSendAt = tSent;
    lastWireAt = tSent;
    creditWaitMs = 0;
    fpsWaitMs = 0;
    return true;
  };
  while (!isClosed()) {
    resetGeneration();
    const now = clock();
    // Sleep while idle only if the page can wake this stream when paint changes.
    if (idleUntil > now && !flow.paintDirty && !flow.needFull && opts.canIdle?.() !== false) {
      if (!flushPending() || !sendHeartbeat()) return;
      if (flow.paintDirty || flow.needFull) continue;
      await sleep(Math.min(idleUntil - now, SCENE_HEARTBEAT_MS - (clock() - lastWireAt)));
      continue;
    }
    idleUntil = 0;
    if (now < due) {
      if (!flushPending()) return;
      const t0 = clock();
      await sleep(Math.min(due - now, FRAME_WAIT_SLICE_MS));
      fpsWaitMs += clock() - t0;
      continue;
    }
    if (flow.sent - flow.acked >= MAX_SCENES_IN_FLIGHT) {
      if (!flushPending()) return;
      if (!sendHeartbeat()) return;
      const t0 = clock();
      await sleep(SCENE_CREDIT_POLL_MS);
      creditWaitMs += clock() - t0;
      continue;
    }
    due = now + period;
    const forceFull = flow.needFull;
    if (forceFull) {
      flow.needFull = false;
      paintedSeq = -1;
      lastFullScene = null;
      lastSeq = -1;
    }
    let r: RecordSceneReply;
    const tRecordStart = clock();
    const recordedW = opts.w;
    const recordedH = opts.h;
    // A wake arriving during the RPC must survive until the next record, even if
    // this reply says idle. That closes the arm/reply/sleep lost-wakeup window.
    flow.paintDirty = false;
    try {
      const p = recordScene({
        ...(opts.text ? { producer: "client" as const } : {}),
        sinceSeq: lastSeq,
        allowPartial: !opts.text && opts.allowPartial !== false,
        baseSeq: paintedSeq < 0 ? -1 : paintedSeq - wireBase,
        inlineResources: true,
        // Deployed isolates can defer timer wakes under CPU load, so each record also runs
        // overdue rAF callbacks and timers; the scene stream doubles as the page's vsync.
        pumpRaf: true,
        frameIntervalMs: period,
        armWake: opts.canIdle?.() !== false,
      });
      if (resetGeneration()) {
      } else if (!flushPending()) return;
      let heartbeatFailed = false;
      const heartbeat = setInterval(() => {
        if (isClosed() || !sendHeartbeat()) {
          heartbeatFailed = true;
          clearInterval(heartbeat);
        }
      }, SCENE_HEARTBEAT_MS);
      try {
        r = await p;
      } finally {
        clearInterval(heartbeat);
      }
      if (heartbeatFailed || isClosed()) return;
    } catch {
      continue;
    }
    if (resetGeneration()) continue;
    const tRecordDone = clock();
    if (r.nextRafDelayMs !== undefined && r.nextRafDelayMs > 0) {
      due = Math.min(due, tRecordDone + r.nextRafDelayMs);
    }
    if (r.idle && !r.error && !flow.paintDirty && (r.unchanged || r.scene?.length)) {
      idleUntil = tRecordDone + SCENE_HEARTBEAT_MS;
    }
    pumpStats.calls++;
    const pv = typeof r.pumped === "number" ? r.pumped : -1;
    pumpStats.byVal[pv] = (pumpStats.byVal[pv] ?? 0) + 1;
    pumpStats.pumpMsTotal += r.pumpMs ?? 0;
    if (pumpStats.calls % PUMP_STATS_CALL_INTERVAL === 0) {
      try {
        server.send(
          infoEnvelope({
            t: "pumpStats",
            pumpMsTotal: pumpStats.pumpMsTotal,
            ...pumpStats.byVal,
          }),
        );
      } catch {}
    }
    if (r.error || r.unchanged || !r.scene || r.scene.length === 0) {
      if (typeof r.seq === "number") lastSeq = r.seq;
      if (!r.error && !sendHeartbeat()) return;
      continue;
    }
    lastSeq = r.seq ?? 0;
    const seq = lastSeq + wireBase;
    maxWireSeq = Math.max(maxWireSeq, seq);
    const bytes = r.scene;
    const full = !(r.partial && r.clip);
    const resources = r.resourceBatch?.length ? r.resourceBatch : undefined;
    if (
      full &&
      !forceFull &&
      lastFullScene &&
      lastFullScene.scrollX === (r.scrollX ?? 0) &&
      lastFullScene.scrollY === (r.scrollY ?? 0) &&
      sameBytes(lastFullScene.resources, resources) &&
      sameBytes(lastFullScene.bytes, bytes)
    ) {
      if (!sendHeartbeat()) return;
      continue;
    }
    lastFullScene = full
      ? { bytes, resources, scrollX: r.scrollX ?? 0, scrollY: r.scrollY ?? 0 }
      : null;
    {
      paintedSeq = seq;
      trackSceneSent(flow, seq);
      pending = {
        seq,
        bytes,
        resBytes: resources ?? null,
        partial: !!(r.partial && r.clip),
        // Convert recordScene's document-space clip to the RBI envelope's viewport space.
        clip: r.clip
          ? {
              x: r.clip.x - (r.scrollX ?? 0),
              y: r.clip.y - (r.scrollY ?? 0),
              w: r.clip.w,
              h: r.clip.h,
            }
          : null,
        baseSeq: r.baseSeq === undefined ? -1 : r.baseSeq + wireBase,
        recordMs: tRecordDone - tRecordStart,
        tRecordDone,
        w: recordedW,
        h: recordedH,
      };
    }
  }
  pending = null;
}
