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
    if (targetId !== undefined && id !== targetId) continue;
    stream.closed = true;
    stream.flow.wake?.();
    stopTerminalWheelQueue(browser, stream);
    byTarget.delete(id);
  }
}

export function terminalSceneWheelQueue(
  browser: BrowserState,
  targetId: string,
  sessionId: string | undefined,
): WheelQueue | null {
  const stream = streams.get(browser)?.get(targetId);
  if (!stream || stream.closed || !stream.terminal || stream.ownerSessionId !== sessionId)
    return null;
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

export async function sceneStreamCommand(
  ctx: DispatchCtx,
  req: SceneStreamRequest,
): Promise<unknown> {
  const targetParams = TargetParams.safeParse(req.params ?? {});
  if (!targetParams.success) throw new Error("invalid scene stream target");
  const target = page(ctx, targetParams.data.targetId, req.sessionId);
  if (!target) throw new Error("no page target");
  let byTarget = streams.get(ctx.browser);
  if (!byTarget) {
    byTarget = new Map();
    streams.set(ctx.browser, byTarget);
  }
  const active = byTarget.get(target.targetId);
  if (req.method === "Kitesurf.stopSceneStream") {
    stopSceneStreams(ctx.browser, target.targetId);
    await active?.done;
    return {};
  }
  if (req.method === "Kitesurf.sceneFrameAck") {
    const params = AckParams.safeParse(req.params);
    if (active && params.success) {
      if (claimSceneAck(active.flow, params.data.seq) && params.data.painted === false) {
        active.flow.needFull = true;
        wakeSceneFlow(active.flow);
      }
    }
    return {};
  }
  if (req.method === "Kitesurf.getSceneResources") {
    if (!active || !target.pageScript) throw new Error("scene stream not running");
    if (active.needInFlight >= MAX_IN_FLIGHT_RESOURCE_REQUESTS) {
      throw new Error("too many resource requests");
    }
    const params = ResourceParams.safeParse(req.params);
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
    const images: number[] = [],
      fonts: number[] = [];
    for (let i = 0; i < count; i++) {
      const off = MISSING_RESOURCE_LIST_HEADER_BYTES + i * MISSING_RESOURCE_LIST_ENTRY_BYTES;
      const kind = missing[off];
      if (kind === 2) {
        images.push(
          ...missing.subarray(
            off + MISSING_RESOURCE_LIST_KIND_BYTES,
            off + MISSING_RESOURCE_LIST_ENTRY_BYTES,
          ),
        );
      } else if (kind === 3) {
        fonts.push(
          ...missing.subarray(
            off + MISSING_RESOURCE_LIST_KIND_BYTES,
            off + MISSING_RESOURCE_LIST_ENTRY_BYTES,
          ),
        );
      }
    }
    active.needInFlight++;
    try {
      const reply = await stubQueryDom(target.pageScript, "getPaintResources", {
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
      return { batchB64: base64(batch) } satisfies Protocol.Kitesurf.GetSceneResourcesResponse;
    } finally {
      active.needInFlight--;
    }
  }
  const parsed = StartParams.safeParse(req.params);
  if (!parsed.success) {
    throw new Error("invalid scene stream parameters");
  }
  const { width, height, fps, text = false, terminal, cellW, cellH, allowPartial } = parsed.data;
  if (active) {
    // Finish the existing owner before installing another loop for this target.
    active.closed = true;
    active.flow.wake?.();
    stopTerminalWheelQueue(ctx.browser, active);
    await active.done;
  }
  const latest = byTarget.get(target.targetId);
  if (latest && latest !== active) {
    latest.closed = true;
    latest.flow.wake?.();
    stopTerminalWheelQueue(ctx.browser, latest);
    await latest.done;
  }
  const flow: SceneFlow = {
    sent: 0,
    acked: 0,
    outstanding: new Map(),
    needFull: false,
  };
  const stream: Stream = {
    closed: false,
    flow,
    target,
    resources: new DeliveredKeys(),
    needInFlight: 0,
    terminal: terminal === true,
    ownerSessionId: req.sessionId,
    wheelQueue: null,
  };
  byTarget.set(target.targetId, stream);
  if (terminal) {
    ctx.browser.ttyKeyboard = true;
    if (text) {
      ctx.browser.ttyUaCss = 1;
      if (cellW !== undefined && cellH !== undefined) {
        ctx.browser.ttyCellW = cellW;
        ctx.browser.ttyCellH = cellH;
      }
    }
  }
  const ownerSessionId = req.sessionId;
  const send = (bytes: Uint8Array) => {
    ctx.emit({
      method: "Kitesurf.sceneFrame",
      params: { data: base64(bytes) },
      sessionId: ownerSessionId,
    });
  };
  const loop = runSceneLoop(
    async (args) => {
      if (!target.pageScript) throw new Error("page not ready");
      const have = stream.resources.pack();
      const recordArgs = {
        ...args,
        haveImages: have.images,
        haveFonts: have.fonts,
      };
      const reply = await stubQueryDom(target.pageScript, "recordScene", recordArgs);
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
    },
    { send },
    () => stream.closed || ctx.browser.wsClosing || !ctx.browser.targets.has(target.targetId),
    flow,
    {
      w: width,
      h: height,
      fps: fps ?? DEFAULT_SCENE_STREAM_FPS,
      text,
      allowPartial: allowPartial !== false,
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
  return { heartbeatMs: SCENE_HEARTBEAT_MS };
}
