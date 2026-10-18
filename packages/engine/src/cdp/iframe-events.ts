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

    for (const sessionId of sessions) {
      ctx.emit({
        method: "Page.frameAttached",
        params: { frameId: frame.frameId, parentFrameId },
        sessionId,
      });
    }

    emitFrameTarget(ctx, frame);

    for (const sessionId of sessions) {
      ctx.emit({
        method: "Page.frameStartedLoading",
        params: { frameId: frame.frameId },
        sessionId,
      });
    }

    const navigated: Protocol.Page.FrameNavigatedEvent = {
      frame: makeFrameInfo(frame),
      type: "Navigation",
    };
    for (const sessionId of sessions) {
      ctx.emit({ method: "Page.frameNavigated", params: navigated, sessionId });
    }

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
}
