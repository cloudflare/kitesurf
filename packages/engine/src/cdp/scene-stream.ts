// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Manages RBI scene streams, frame acknowledgements, resources, and terminal wheel input. CDP
// surface: `Kitesurf.startSceneStream` / `stopSceneStream`, `sceneFrame` events, `sceneFrameAck`
// to return credit (`painted:false` asks for a full frame), and `getSceneResources`. Navigation,
// viewport and input use standard CDP on the same connection; see rbi.ts for the frame wire.

import type { Protocol } from "devtools-protocol";
import { z } from "zod";
import type { DispatchCtx } from "./dispatch.ts";
import type { BrowserState, CdpRequest, TargetState } from "./types.ts";
import { stubQueryDom } from "./page-session.ts";
import {
  claimSceneAck,
  runSceneLoop,
  SCENE_HEARTBEAT_MS,
  wakeSceneFlow,
  type SceneFlow,
} from "../rbi.ts";
import { getWheelQueue, stopAndRemoveWheelQueue, type WheelQueue } from "./wheel-queue.ts";
import {
  DeliveredKeys,
  dropAlreadySent,
  MAX_MISSING_RESOURCE_LIST_B64_CHARS,
  MISSING_RESOURCE_LIST_ENTRY_BYTES,
  MISSING_RESOURCE_LIST_HEADER_BYTES,
  MISSING_RESOURCE_LIST_KIND_BYTES,
  noteDelivered,
  supplyEngineResources,
} from "../rbi-protocol.ts";
import { getFontBytes, getImageBytes } from "../eval/resource-store.ts";
import { makeWallClock } from "../eval/host-clock.ts";
import { MAX_SIDE } from "./viewport.ts";
import { TTY_CELL_PX_MAX, TTY_CELL_PX_MIN } from "../tty/nav-params.ts";

interface Stream {
  closed: boolean;
  done?: Promise<void>;
  needInFlight: number;
  flow: SceneFlow;
  target: TargetState;
  resources: DeliveredKeys;
  terminal: boolean;
  ownerSessionId: string | undefined;
  wheelQueue: WheelQueue | null;
}

const streams = new WeakMap<BrowserState, Map<string, Stream>>();

export function wakeSceneStream(browser: BrowserState, targetId: string): void {
  const stream = streams.get(browser)?.get(targetId);
  if (stream && !stream.closed) wakeSceneFlow(stream.flow);
}

export function stopSceneStreams(browser: BrowserState, targetId?: string): void {
  const byTarget = streams.get(browser);
  if (!byTarget) return;
  for (const [id, stream] of byTarget) {
    if (shouldStopStream(id, targetId)) stopAndForgetStream(browser, byTarget, id, stream);
  }
}

function shouldStopStream(id: string, targetId: string | undefined): boolean {
  return targetId === undefined || id === targetId;
}

function stopAndForgetStream(
  browser: BrowserState,
  byTarget: Map<string, Stream>,
  id: string,
  stream: Stream,
): void {
  stream.closed = true;
  stream.flow.wake?.();
  stopTerminalWheelQueue(browser, stream);
  byTarget.delete(id);
}

export function terminalSceneWheelQueue(
  browser: BrowserState,
  targetId: string,
  sessionId: string | undefined,
): WheelQueue | null {
  const stream = streams.get(browser)?.get(targetId);
  if (!ownsLiveTerminalStream(stream, sessionId)) return null;
  return ensureTerminalWheelQueue(browser, targetId, sessionId, stream);
}

function ownsLiveTerminalStream(
  stream: Stream | undefined,
  sessionId: string | undefined,
): stream is Stream {
  return !!stream && !stream.closed && stream.terminal && stream.ownerSessionId === sessionId;
}

function ensureTerminalWheelQueue(
  browser: BrowserState,
  targetId: string,
  sessionId: string | undefined,
  stream: Stream,
): WheelQueue {
  if (!stream.wheelQueue?.isAccepting) {
    stream.wheelQueue = getWheelQueue(browser, targetId, sessionId);
  }
  return stream.wheelQueue;
}

function stopTerminalWheelQueue(browser: BrowserState, stream: Stream): void {
  if (
    !stream.wheelQueue ||
    stream.wheelQueue === browser.screencasts.get(stream.target.targetId)?.wheelQueue
  )
    return;
  stopAndRemoveWheelQueue(
    browser,
    stream.target.targetId,
    stream.ownerSessionId,
    stream.wheelQueue,
  );
  stream.wheelQueue = null;
}

const MIN_SCENE_STREAM_WIDTH = 320;
const MIN_SCENE_STREAM_HEIGHT = 240;
const MAX_SCENE_STREAM_HEIGHT = 1440;
const MAX_SCENE_STREAM_FPS = 60;
const DEFAULT_SCENE_STREAM_FPS = 60;
const MAX_SCENE_FRAME_SEQUENCE = 0xffff_ffff;
const MAX_SCENE_RESOURCE_REQUEST_ITEMS = 4096;
// Each resource request is an RPC into the page isolate.
const MAX_IN_FLIGHT_RESOURCE_REQUESTS = 2;

const TargetParams = z.object({ targetId: z.string().optional() });
const StartParams = TargetParams.extend({
  width: z.number().int().min(MIN_SCENE_STREAM_WIDTH).max(MAX_SIDE),
  height: z.number().int().min(MIN_SCENE_STREAM_HEIGHT).max(MAX_SCENE_STREAM_HEIGHT),
  fps: z.number().int().min(1).max(MAX_SCENE_STREAM_FPS).optional(),
  text: z.boolean().optional(),
  terminal: z.boolean().optional(),
  cellW: z.number().min(TTY_CELL_PX_MIN).max(TTY_CELL_PX_MAX).optional(),
  cellH: z.number().min(TTY_CELL_PX_MIN).max(TTY_CELL_PX_MAX).optional(),
  allowPartial: z.boolean().optional(),
});
const AckParams = TargetParams.extend({
  seq: z.number().int().min(0).max(MAX_SCENE_FRAME_SEQUENCE),
  painted: z.boolean().optional(),
});
const ResourceParams = TargetParams.extend({
  missingB64: z.string().max(MAX_MISSING_RESOURCE_LIST_B64_CHARS),
});

function page(
  ctx: DispatchCtx,
  targetId: string | undefined,
  sessionId: string | undefined,
): TargetState | null {
  if (targetId !== undefined) {
    const target = ctx.browser.targets.get(targetId);
    return target?.type === "page" ? target : null;
  }
  if (sessionId) {
    for (const target of ctx.browser.targets.values()) {
      if (target.type === "page" && target.sessions.has(sessionId)) return target;
    }
    return null;
  }
  return [...ctx.browser.targets.values()].find((t) => t.type === "page") ?? null;
}

function base64(bytes: Uint8Array): string {
  return bytes.toBase64();
}

function unpack(value: string): Uint8Array {
  return Uint8Array.fromBase64(value);
}

export type SceneStreamRequest = Extract<
  CdpRequest,
  {
    method:
      | "Kitesurf.startSceneStream"
      | "Kitesurf.stopSceneStream"
      | "Kitesurf.sceneFrameAck"
      | "Kitesurf.getSceneResources";
  }
>;

type SceneRecord = Parameters<typeof runSceneLoop>[0];
type SceneRecordArgs = Parameters<SceneRecord>[0];
type SceneRecordReply = Awaited<ReturnType<SceneRecord>>;
type StartSceneParams = z.infer<typeof StartParams>;

export async function sceneStreamCommand(
  ctx: DispatchCtx,
  req: SceneStreamRequest,
): Promise<unknown> {
  const target = parseSceneTarget(ctx, req);
  const byTarget = streamMapFor(ctx.browser);
  const active = byTarget.get(target.targetId);
  return routeSceneCommand(ctx, req, target, byTarget, active);
}

function parseSceneTarget(ctx: DispatchCtx, req: SceneStreamRequest): TargetState {
  const params = TargetParams.safeParse(req.params ?? {});
  if (!params.success) throw new Error("invalid scene stream target");
  const target = page(ctx, params.data.targetId, req.sessionId);
  if (!target) throw new Error("no page target");
  return target;
}

function streamMapFor(browser: BrowserState): Map<string, Stream> {
  let byTarget = streams.get(browser);
  if (!byTarget) {
    byTarget = new Map();
    streams.set(browser, byTarget);
  }
  return byTarget;
}

async function routeSceneCommand(
  ctx: DispatchCtx,
  req: SceneStreamRequest,
  target: TargetState,
  byTarget: Map<string, Stream>,
  active: Stream | undefined,
): Promise<unknown> {
  if (req.method === "Kitesurf.stopSceneStream") {
    return stopSceneStreamCommand(ctx.browser, target, active);
  }
  if (req.method === "Kitesurf.sceneFrameAck") return acknowledgeSceneFrame(active, req.params);
  if (req.method === "Kitesurf.getSceneResources") {
    return getSceneResources(ctx, target, active, req.params);
  }
  return startSceneStream(ctx, req, target, byTarget, active);
}

async function stopSceneStreamCommand(
  browser: BrowserState,
  target: TargetState,
  active: Stream | undefined,
): Promise<Record<string, never>> {
  stopSceneStreams(browser, target.targetId);
  await active?.done;
  return {};
}

function acknowledgeSceneFrame(
  active: Stream | undefined,
  rawParams: unknown,
): Record<string, never> {
  const params = AckParams.safeParse(rawParams);
  if (!active || !params.success) return {};
  if (claimSceneAck(active.flow, params.data.seq) && params.data.painted === false) {
    active.flow.needFull = true;
    wakeSceneFlow(active.flow);
  }
  return {};
}

interface MissingSceneResources {
  images: number[];
  fonts: number[];
}

function parseMissingSceneResources(rawParams: unknown): MissingSceneResources {
  const params = ResourceParams.safeParse(rawParams);
  if (!params.success) throw new Error("invalid resource request");
  const missing = unpack(params.data.missingB64);
  const view = new DataView(missing.buffer, missing.byteOffset, missing.byteLength);
  if (missing.length < MISSING_RESOURCE_LIST_HEADER_BYTES) {
    throw new Error("invalid resource request");
  }
  const count = view.getUint32(0, true);
  if (
    count > MAX_SCENE_RESOURCE_REQUEST_ITEMS ||
    missing.length !==
      MISSING_RESOURCE_LIST_HEADER_BYTES + count * MISSING_RESOURCE_LIST_ENTRY_BYTES
  ) {
    throw new Error("invalid resource request");
  }
  return collectMissingSceneResources(missing, count);
}

function collectMissingSceneResources(missing: Uint8Array, count: number): MissingSceneResources {
  const images: number[] = [];
  const fonts: number[] = [];
  for (let i = 0; i < count; i++) {
    const offset = MISSING_RESOURCE_LIST_HEADER_BYTES + i * MISSING_RESOURCE_LIST_ENTRY_BYTES;
    const kind = missing[offset];
    if (kind === 2) {
      images.push(
        ...missing.subarray(
          offset + MISSING_RESOURCE_LIST_KIND_BYTES,
          offset + MISSING_RESOURCE_LIST_ENTRY_BYTES,
        ),
      );
    } else if (kind === 3) {
      fonts.push(
        ...missing.subarray(
          offset + MISSING_RESOURCE_LIST_KIND_BYTES,
          offset + MISSING_RESOURCE_LIST_ENTRY_BYTES,
        ),
      );
    }
  }
  return { images, fonts };
}

function resourceContext(
  target: TargetState,
  active: Stream | undefined,
): { active: Stream; pageScript: NonNullable<TargetState["pageScript"]> } {
  if (!active || !target.pageScript) throw new Error("scene stream not running");
  if (active.needInFlight >= MAX_IN_FLIGHT_RESOURCE_REQUESTS) {
    throw new Error("too many resource requests");
  }
  return { active, pageScript: target.pageScript };
}

async function getSceneResources(
  ctx: DispatchCtx,
  target: TargetState,
  active: Stream | undefined,
  rawParams: unknown,
): Promise<Protocol.Kitesurf.GetSceneResourcesResponse> {
  const { active: stream, pageScript } = resourceContext(target, active);
  const { images, fonts } = parseMissingSceneResources(rawParams);
  stream.needInFlight++;
  try {
    const reply = await stubQueryDom(pageScript, "getPaintResources", {
      imageHashes: new Uint8Array(images),
      fontDataHashes: new Uint8Array(fonts),
    });
    const batch = reply.batch
      ? supplyEngineResources(
          reply.batch,
          (hash) => getImageBytes(hash, ctx.connectionId),
          (key) => getFontBytes(key, ctx.connectionId),
        )
      : new Uint8Array();
    return { batchB64: base64(batch) };
  } finally {
    stream.needInFlight--;
  }
}

async function startSceneStream(
  ctx: DispatchCtx,
  req: SceneStreamRequest,
  target: TargetState,
  byTarget: Map<string, Stream>,
  active: Stream | undefined,
): Promise<{ heartbeatMs: number }> {
  const params = parseStartSceneParams(req.params);
  await closeReplacedStreams(ctx.browser, byTarget, target, active);
  const stream = createSceneStream(target, req.sessionId, params.terminal === true);
  byTarget.set(target.targetId, stream);
  configureTerminalStream(ctx.browser, stream, params);
  startSceneLoop(ctx, target, byTarget, stream, params);
  return { heartbeatMs: SCENE_HEARTBEAT_MS };
}

function parseStartSceneParams(rawParams: unknown): StartSceneParams {
  const parsed = StartParams.safeParse(rawParams);
  if (!parsed.success) throw new Error("invalid scene stream parameters");
  return parsed.data;
}

async function closeReplacedStreams(
  browser: BrowserState,
  byTarget: Map<string, Stream>,
  target: TargetState,
  active: Stream | undefined,
): Promise<void> {
  await closeStream(browser, active);
  const latest = byTarget.get(target.targetId);
  if (latest !== active) await closeStream(browser, latest);
}

async function closeStream(browser: BrowserState, stream: Stream | undefined): Promise<void> {
  if (!stream) return;
  stream.closed = true;
  stream.flow.wake?.();
  stopTerminalWheelQueue(browser, stream);
  await stream.done;
}

function createSceneStream(
  target: TargetState,
  sessionId: string | undefined,
  terminal: boolean,
): Stream {
  return {
    closed: false,
    flow: { sent: 0, acked: 0, outstanding: new Map(), needFull: false },
    target,
    resources: new DeliveredKeys(),
    needInFlight: 0,
    terminal,
    ownerSessionId: sessionId,
    wheelQueue: null,
  };
}

function configureTerminalStream(
  browser: BrowserState,
  stream: Stream,
  params: StartSceneParams,
): void {
  if (!params.terminal) return;
  browser.ttyKeyboard = true;
  if (!params.text) return;
  browser.ttyUaCss = 1;
  if (params.cellW === undefined || params.cellH === undefined) return;
  browser.ttyCellW = params.cellW;
  browser.ttyCellH = params.cellH;
}

function startSceneLoop(
  ctx: DispatchCtx,
  target: TargetState,
  byTarget: Map<string, Stream>,
  stream: Stream,
  params: StartSceneParams,
): void {
  const ownerSessionId = stream.ownerSessionId;
  const send = (bytes: Uint8Array) => {
    ctx.emit({
      method: "Kitesurf.sceneFrame",
      params: { data: base64(bytes) },
      sessionId: ownerSessionId,
    });
  };
  const loop = runSceneLoop(
    (args) => recordSceneFrame(ctx, target, stream, args),
    { send },
    () => stream.closed || ctx.browser.wsClosing || !ctx.browser.targets.has(target.targetId),
    stream.flow,
    {
      w: params.width,
      h: params.height,
      fps: params.fps ?? DEFAULT_SCENE_STREAM_FPS,
      text: params.text ?? false,
      allowPartial: params.allowPartial !== false,
      now: makeWallClock(ctx.env),
      // Child isolates cannot currently wake the parent when their own pixels change.
      canIdle: () => ![...target.frames.values()].some((frame) => frame.pageScript),
    },
    () => target.navigateGeneration,
  ).finally(() => {
    stopTerminalWheelQueue(ctx.browser, stream);
    if (byTarget.get(target.targetId) === stream) byTarget.delete(target.targetId);
  });
  stream.done = loop;
  ctx.ctx.waitUntil(loop);
}

async function recordSceneFrame(
  ctx: DispatchCtx,
  target: TargetState,
  stream: Stream,
  args: SceneRecordArgs,
): Promise<SceneRecordReply> {
  const pageScript = target.pageScript;
  if (!pageScript) throw new Error("page not ready");
  const have = stream.resources.pack();
  const reply = await stubQueryDom(pageScript, "recordScene", {
    ...args,
    haveImages: have.images,
    haveFonts: have.fonts,
  });
  if (!reply.resourceBatch) return reply;
  const fresh = dropAlreadySent(reply.resourceBatch, stream.resources);
  if (fresh.length === 0) return { ...reply, resourceBatch: null };
  const supplied = supplyEngineResources(
    fresh,
    (hash) => getImageBytes(hash, ctx.connectionId),
    (key) => getFontBytes(key, ctx.connectionId),
  );
  noteDelivered(supplied, stream.resources);
  return { ...reply, resourceBatch: supplied };
}
