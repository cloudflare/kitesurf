// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import {
  addScreencastViewer,
  emitToScreencastViewers,
  isScreencastOwner,
  leaveScreencast,
  leaveScreencastsOfClient,
} from "../src/cdp/screencast-viewers.ts";
import type { BrowserState, CdpEvent, ScreencastState } from "../src/cdp/types.ts";
import { getWheelQueue } from "../src/cdp/wheel-queue.ts";

const TARGET = "page-1";

function setup() {
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the field these read.
  const browser = { screencasts: new Map() } as unknown as BrowserState;
  let woken = 0;
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the fields these read.
  const stream = {
    wheelQueue: getWheelQueue(browser, TARGET, "a1"),
    ownerClientId: "a",
    ownerSessionId: "a1",
    viewers: new Map(),
    frameSeq: 7,
    lastAckedSeq: 2,
    pendingAckSessionId: 3,
    pendingAckSetAt: 100,
    stopped: false,
    wake: () => woken++,
  } as unknown as ScreencastState;
  addScreencastViewer(stream, "a", "a1");
  browser.screencasts.set(TARGET, stream);
  return { browser, stream, woken: () => woken };
}

describe("screencast viewers", () => {
  it("keeps the stream for its owner when another viewer leaves", () => {
    const { browser, stream } = setup();
    addScreencastViewer(stream, "b", undefined);
    leaveScreencast(browser, TARGET, "b", undefined);
    expect(browser.screencasts.get(TARGET)).toBe(stream);
    expect(isScreencastOwner(stream, "a", "a1")).toBe(true);
    expect(stream.viewers.size).toBe(1);
  });

  it("hands the stream to the oldest viewer with full ack credit when the owner leaves", () => {
    const { browser, stream, woken } = setup();
    addScreencastViewer(stream, "b", undefined);
    addScreencastViewer(stream, "c", "c1");
    leaveScreencast(browser, TARGET, "a", "a1");
    expect(isScreencastOwner(stream, "b", undefined)).toBe(true);
    expect(stream.lastAckedSeq).toBe(7);
    expect(stream.pendingAckSessionId).toBeNull();
    expect(stream.stopped).toBe(false);
    expect(woken()).toBe(1);
  });

  it("ends the stream with its last viewer", () => {
    const { browser, stream } = setup();
    leaveScreencast(browser, TARGET, "a", "a1");
    expect(stream.stopped).toBe(true);
    expect(browser.screencasts.has(TARGET)).toBe(false);
  });

  it("tells clients apart on the same session id", () => {
    const { browser, stream } = setup();
    addScreencastViewer(stream, "b", "a1");
    leaveScreencast(browser, TARGET, "b", "a1");
    expect(isScreencastOwner(stream, "a", "a1")).toBe(true);
    expect(isScreencastOwner(stream, "b", "a1")).toBe(false);
  });

  it("removes every view of a client that leaves", () => {
    const { browser, stream } = setup();
    addScreencastViewer(stream, "a", undefined);
    addScreencastViewer(stream, "b", "b1");
    leaveScreencastsOfClient(browser, "a");
    expect(Array.from(stream.viewers.values())).toEqual([{ clientId: "b", sessionId: "b1" }]);
    expect(isScreencastOwner(stream, "b", "b1")).toBe(true);
  });

  it("sends a frame to each viewer on its own client and session", () => {
    const { stream } = setup();
    addScreencastViewer(stream, "b", undefined);
    const sent: Array<[string, CdpEvent]> = [];
    const peer = (id: string) => ({
      client: { id },
      emitToClient: (e: CdpEvent) => sent.push([id, e]),
    });
    const peers = [peer("a"), peer("b"), peer("c")];
    // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the fields these read.
    const ctx = { peers: () => peers } as unknown as DispatchCtx;
    emitToScreencastViewers(ctx, stream, {
      method: "Page.screencastFrame",
      params: {
        data: "",
        metadata: {
          offsetTop: 0,
          pageScaleFactor: 1,
          deviceWidth: 1,
          deviceHeight: 1,
          scrollOffsetX: 0,
          scrollOffsetY: 0,
        },
        sessionId: 1,
      },
    });
    expect(sent.map(([id, e]) => [id, e.sessionId])).toEqual([
      ["a", "a1"],
      ["b", undefined],
    ]);
  });
});
