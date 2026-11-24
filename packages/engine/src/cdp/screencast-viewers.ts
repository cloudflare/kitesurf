// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The viewers of a screencast: each CDP session of a client that started it and did not stop it.
// A target has one render loop, and each viewer gets its frames. The latest starter owns the
// stream: its acks pace the loop and its wheel input is coalesced. A viewer names its client
// too, because the clients of a shared session all use the root session.

import type { DispatchCtx } from "./dispatch.ts";
import type { BrowserState, CdpEvent, ScreencastState } from "./types.ts";
import { getWheelQueue, stopAndRemoveWheelQueue } from "./wheel-queue.ts";

export interface ScreencastViewer {
  clientId: string;
  sessionId: string | undefined;
}

function viewerKey(clientId: string, sessionId: string | undefined): string {
  return `${clientId}\n${sessionId ?? ""}`;
}

export function addScreencastViewer(
  stream: ScreencastState,
  clientId: string,
  sessionId: string | undefined,
): void {
  stream.viewers.set(viewerKey(clientId, sessionId), { clientId, sessionId });
}

export function isScreencastOwner(
  stream: ScreencastState,
  clientId: string,
  sessionId: string | undefined,
): boolean {
  return stream.ownerClientId === clientId && stream.ownerSessionId === sessionId;
}

/** Sends `event` to each viewer, on the viewer's own session and client. */
export function emitToScreencastViewers(
  ctx: DispatchCtx,
  stream: ScreencastState,
  event: Omit<CdpEvent, "sessionId">,
): void {
  const peers = ctx.peers();
  for (const viewer of stream.viewers.values()) {
    const peer = peers.find((p) => p.client.id === viewer.clientId);
    peer?.emitToClient({ ...event, sessionId: viewer.sessionId } as CdpEvent);
  }
}

/**
 * The session `sessionId` of client `clientId` stops viewing the screencast of `targetId`. The
 * stream ends with its last viewer. When the owner leaves, the oldest other viewer owns it.
 */
export function leaveScreencast(
  browser: BrowserState,
  targetId: string,
  clientId: string,
  sessionId: string | undefined,
): void {
  const stream = browser.screencasts.get(targetId);
  if (!stream || !stream.viewers.delete(viewerKey(clientId, sessionId))) return;
  if (!isScreencastOwner(stream, clientId, sessionId)) return;
  stopAndRemoveWheelQueue(browser, targetId, sessionId, stream.wheelQueue);
  const next = stream.viewers.values().next();
  if (next.done) {
    stream.stopped = true;
    stream.wake?.();
    browser.screencasts.delete(targetId);
    return;
  }
  stream.ownerClientId = next.value.clientId;
  stream.ownerSessionId = next.value.sessionId;
  stream.wheelQueue = getWheelQueue(browser, targetId, next.value.sessionId);
  // The old owner can hold frames it did not ack. The new owner starts with full credit and
  // no stale ack deadline, as a takeover does.
  stream.lastAckedSeq = stream.frameSeq;
  stream.pendingAckSessionId = null;
  stream.pendingAckSetAt = 0;
  stream.wake?.();
}

/** A client left: each of its sessions stops viewing each screencast. */
export function leaveScreencastsOfClient(browser: BrowserState, clientId: string): void {
  for (const [targetId, stream] of Array.from(browser.screencasts)) {
    for (const viewer of Array.from(stream.viewers.values())) {
      if (viewer.clientId === clientId) {
        leaveScreencast(browser, targetId, clientId, viewer.sessionId);
      }
    }
  }
}
