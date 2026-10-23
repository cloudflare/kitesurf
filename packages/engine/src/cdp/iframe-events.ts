// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Emits CDP frame lifecycle events when child frames attach and load.

import type { Protocol } from "devtools-protocol";
import type { DispatchCtx } from "./dispatch.ts";
import { makeFrameInfo } from "./frames.ts";
import type { FrameState } from "./types.ts";
import { emitFrameTarget } from "./target.ts";

const MILLISECONDS_PER_SECOND = 1_000;

export function emitChildFrameAttachAndStart(
  ctx: DispatchCtx,
  frames: Iterable<FrameState>,
  sessions: readonly (string | undefined)[],
): void {
  const timestamp = Date.now() / MILLISECONDS_PER_SECOND;
  for (const frame of frames) {
    const parentFrameId = frame.parentFrameId;
    if (parentFrameId === null) continue;
    emitFrameAttached(ctx, frame, parentFrameId, sessions);
    emitFrameTarget(ctx, frame);
    emitFrameStartedLoading(ctx, frame, sessions);
    emitFrameNavigated(ctx, frame, sessions);
    emitFrameLifecycleInit(ctx, frame, sessions, timestamp);
  }
}

function emitFrameAttached(
  ctx: DispatchCtx,
  frame: FrameState,
  parentFrameId: string,
  sessions: readonly (string | undefined)[],
): void {
  for (const sessionId of sessions) {
    ctx.emit({
      method: "Page.frameAttached",
      params: { frameId: frame.frameId, parentFrameId },
      sessionId,
    });
  }
}

function emitFrameStartedLoading(
  ctx: DispatchCtx,
  frame: FrameState,
  sessions: readonly (string | undefined)[],
): void {
  for (const sessionId of sessions) {
    ctx.emit({
      method: "Page.frameStartedLoading",
      params: { frameId: frame.frameId },
      sessionId,
    });
  }
}

function emitFrameNavigated(
  ctx: DispatchCtx,
  frame: FrameState,
  sessions: readonly (string | undefined)[],
): void {
  const navigated: Protocol.Page.FrameNavigatedEvent = {
    frame: makeFrameInfo(frame),
    type: "Navigation",
  };
  for (const sessionId of sessions) {
    ctx.emit({ method: "Page.frameNavigated", params: navigated, sessionId });
  }
}

function emitFrameLifecycleInit(
  ctx: DispatchCtx,
  frame: FrameState,
  sessions: readonly (string | undefined)[],
  timestamp: number,
): void {
  const init: Protocol.Page.LifecycleEventEvent = {
    frameId: frame.frameId,
    loaderId: frame.loaderId,
    name: "init",
    timestamp,
  };
  for (const sessionId of sessions) {
    ctx.emit({ method: "Page.lifecycleEvent", params: init, sessionId });
  }
}
