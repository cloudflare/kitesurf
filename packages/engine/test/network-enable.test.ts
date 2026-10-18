// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import { NetworkEventTracker, isolateRetainedBodyBytesTotal } from "../src/cdp/network-events.ts";
import { destroyOopifTarget } from "../src/cdp/target.ts";

interface Seen {
  method: string;
  sessionId?: string;
}

const live: NetworkEventTracker[] = [];

afterEach(() => {
  while (live.length > 0) {
    const t = live.pop();
    if (t !== undefined) t.dispose();
  }
});

function newTracker(): { tracker: NetworkEventTracker; seen: Seen[] } {
  const seen: Seen[] = [];
  const tracker = new NetworkEventTracker((ev) => {
    seen.push({ method: ev.method, sessionId: ev.sessionId });
  }, "conn-enable");
  live.push(tracker);
  return { tracker, seen };
}

function roundTrip(tracker: NetworkEventTracker): string {
  const url = "https://example.test/asset.json";
  const id = tracker.beginRequest({
    url,
    method: "GET",
    headers: {},
    type: "XHR",
    initiator: { type: "other" },
    loaderId: "loader-1",
    frameId: "frame-1",
  });
  tracker.completeRequest(id, {
    url,
    status: 200,
    statusText: "OK",
    headers: {},
    mimeType: "application/json",
    bodyLength: 4,
    body: "{}!!",
  });
  tracker.drain();
  return id;
}

function sizedBody(tracker: NetworkEventTracker, chars: number): string {
  const url = `https://example.test/${chars}-${crypto.randomUUID()}`;
  const id = tracker.beginRequest({
    url,
    method: "GET",
    headers: {},
    type: "XHR",
    initiator: { type: "other" },
    loaderId: "loader-1",
    frameId: "frame-1",
  });
  tracker.completeRequest(id, {
    url,
    status: 200,
    statusText: "OK",
    headers: {},
    mimeType: "application/json",
    bodyLength: chars,
    body: "a".repeat(chars),
  });
  return id;
}

describe("Network.enable session ledger", () => {
  it("emits nothing until a session enables the domain", () => {
    const { tracker, seen } = newTracker();
    roundTrip(tracker);
    expect(seen, "no client asked for Network events").toEqual([]);
  });

  it("delivers to the root session once it enables", () => {
    const { tracker, seen } = newTracker();
    tracker.setEnabled(undefined, true);
    roundTrip(tracker);
    expect(seen.map((e) => e.method)).toEqual([
      "Network.requestWillBeSent",
      "Network.requestWillBeSentExtraInfo",
      "Network.responseReceivedExtraInfo",
      "Network.responseReceived",
      "Network.dataReceived",
      "Network.loadingFinished",
    ]);
    expect(seen.every((e) => e.sessionId === undefined)).toBe(true);
  });

  it("emits response metadata before a response-level failure", () => {
    const { tracker, seen } = newTracker();
    tracker.setEnabled(undefined, true);
    const url = "https://example.test/no-content";
    const id = tracker.beginRequest({
      url,
      method: "GET",
      headers: {},
      type: "Document",
      initiator: { type: "other" },
      loaderId: "loader-1",
      frameId: "frame-1",
    });
    tracker.completeRequest(id, {
      url,
      status: 204,
      statusText: "No Content",
      headers: {},
      mimeType: "text/html",
      bodyLength: 0,
      errorText: "net::ERR_ABORTED",
    });
    tracker.drain();

    expect(seen.map((event) => event.method)).toEqual([
      "Network.requestWillBeSent",
      "Network.requestWillBeSentExtraInfo",
      "Network.responseReceivedExtraInfo",
      "Network.responseReceived",
      "Network.loadingFailed",
    ]);
  });

  it("stops delivery on Network.disable", () => {
    const { tracker, seen } = newTracker();
    tracker.setEnabled(undefined, true);
    roundTrip(tracker);
    const afterEnable = seen.length;
    expect(afterEnable).toBeGreaterThan(0);
    tracker.setEnabled(undefined, false);
    roundTrip(tracker);
    expect(seen.length, "disable must be more than advisory").toBe(afterEnable);
  });

  it("fans out only to the sessions that enabled", () => {
    const { tracker, seen } = newTracker();
    tracker.setTargetAttribution("frame-1", "loader-1", ["sess-a", "sess-b"]);
    tracker.setEnabled("sess-b", true);
    roundTrip(tracker);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen.map((e) => e.sessionId))).toEqual(new Set(["sess-b"]));
  });

  it("falls back to the root when it enabled but a session is attached", () => {
    const { tracker, seen } = newTracker();
    tracker.setTargetAttribution("frame-1", "loader-1", ["sess-a"]);
    tracker.setEnabled(undefined, true);
    roundTrip(tracker);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((e) => e.sessionId === undefined)).toBe(true);
  });

  it("forgets a detached session's enable", () => {
    const { tracker, seen } = newTracker();
    tracker.setTargetAttribution("frame-1", "loader-1", ["sess-a"]);
    tracker.setEnabled("sess-a", true);
    tracker.forgetSession("sess-a");
    roundTrip(tracker);
    expect(seen).toEqual([]);
  });

  it("keeps in-flight bookkeeping with the domain off", () => {
    const { tracker } = newTracker();
    const url = "https://example.test/slow";
    const id = tracker.beginRequest({
      url,
      method: "GET",
      headers: {},
      type: "XHR",
      initiator: { type: "other" },
      loaderId: "loader-1",
      frameId: "frame-1",
    });
    expect(tracker.getInFlight()).toBe(1);
    tracker.failRequest(id, "net::ERR_FAILED");
    expect(tracker.getInFlight()).toBe(0);
    expect(tracker.retainedRequestCount()).toBe(1);
  });

  it("keeps each request on its target when a sibling target navigates", () => {
    const { tracker, seen } = newTracker();
    tracker.setEnabled("sess-a", true);
    tracker.setEnabled("sess-b", true);
    tracker.setTargetAttribution("frame-a", "loader-a", ["sess-a"]);
    tracker.setTargetAttribution("frame-b", "loader-b", ["sess-b"]);

    const url = "https://example.test/slow";
    const id = tracker.beginRequest({
      url,
      method: "GET",
      headers: {},
      type: "XHR",
      initiator: { type: "other" },
      loaderId: "loader-a",
      frameId: "frame-a",
    });
    tracker.setTargetAttribution("frame-b", "loader-b-2", ["sess-b"]);
    tracker.completeRequest(id, {
      url,
      status: 200,
      statusText: "OK",
      headers: {},
      mimeType: "application/json",
      bodyLength: 2,
      body: "{}",
    });
    tracker.drain();

    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen.map((event) => event.sessionId))).toEqual(new Set(["sess-a"]));
  });

  it("retains no response bodies while the domain is off", () => {
    const { tracker } = newTracker();
    const id = roundTrip(tracker);
    expect(tracker.getResponseBody(id)).toBeNull();
    expect(tracker.retainedBodyBytes()).toBe(0);
  });

  it("retains bodies once any session enables", () => {
    const { tracker } = newTracker();
    tracker.setEnabled("sess-a", true);
    const id = roundTrip(tracker);
    expect(tracker.getResponseBody(id)).toEqual({
      body: "{}!!",
      base64Encoded: false,
    });
  });
});

describe("Network.enable buffer sizes", () => {
  it("retains nothing when the session asks for no buffer", () => {
    const { tracker } = newTracker();
    const isolateBefore = isolateRetainedBodyBytesTotal();
    tracker.setEnabled(undefined, true, { maxTotalBufferSize: 0 });
    const id = roundTrip(tracker);
    expect(tracker.getResponseBody(id)).toBeNull();
    expect(tracker.retainedBodyBytes()).toBe(0);
    expect(
      isolateRetainedBodyBytesTotal() - isolateBefore,
      "a zero-buffer session must not charge the shared budget",
    ).toBe(0);
    expect(tracker.retainedRequestCount()).toBe(1);
  });

  it("retains nothing when the session never enables at all", () => {
    const { tracker } = newTracker();
    const isolateBefore = isolateRetainedBodyBytesTotal();
    const id = roundTrip(tracker);
    expect(tracker.getResponseBody(id)).toBeNull();
    expect(isolateRetainedBodyBytesTotal() - isolateBefore).toBe(0);
  });

  it("honours a buffer smaller than our ceiling", () => {
    const { tracker } = newTracker();
    tracker.setEnabled(undefined, true, { maxTotalBufferSize: 4096 });
    const first = sizedBody(tracker, 2000);
    expect(tracker.retainedBodyBytes()).toBe(4000);
    const second = sizedBody(tracker, 2000);
    expect(tracker.retainedBodyBytes()).toBe(4000);
    expect(tracker.getResponseBody(first)).toBeNull();
    expect(tracker.getResponseBody(second)).not.toBeNull();
  });

  it("clamps a request bigger than our ceiling", () => {
    const { tracker } = newTracker();
    tracker.setEnabled(undefined, true, {
      maxTotalBufferSize: 250 * 1024 * 1024,
      maxResourceBufferSize: 20 * 1000 * 1000,
    });
    expect(tracker.perBodyBudget()).toBe(256 * 1024);
  });

  it("drops the per-body cap when asked to", () => {
    const { tracker } = newTracker();
    tracker.setEnabled(undefined, true, { maxResourceBufferSize: 512 });
    expect(tracker.perBodyBudget()).toBe(512);
    const small = roundTrip(tracker);
    expect(tracker.getResponseBody(small)).not.toBeNull();
    expect(tracker.getResponseBody(sizedBody(tracker, 600))).toBeNull();
  });

  it("reports whether a body can be retained at all", () => {
    const { tracker } = newTracker();
    expect(tracker.retainsBodies()).toBe(false);

    tracker.setEnabled(undefined, true);
    expect(tracker.retainsBodies()).toBe(true);

    tracker.setEnabled(undefined, true, { maxTotalBufferSize: 0 });
    expect(tracker.perBodyBudget()).toBeGreaterThan(0);
    expect(tracker.retainsBodies()).toBe(false);

    tracker.setEnabled(undefined, true, { maxResourceBufferSize: 0 });
    expect(tracker.retainsBodies()).toBe(false);

    tracker.setEnabled(undefined, false);
    expect(tracker.retainsBodies()).toBe(false);
  });

  it("takes the most permissive ask across sessions", () => {
    const { tracker } = newTracker();
    tracker.setTargetAttribution("frame-1", "loader-1", ["sess-devtools", "sess-frugal"]);
    tracker.setEnabled("sess-frugal", true, { maxTotalBufferSize: 0 });
    tracker.setEnabled("sess-devtools", true, {
      maxTotalBufferSize: 250 * 1024 * 1024,
    });
    const id = roundTrip(tracker);
    expect(tracker.getResponseBody(id)).not.toBeNull();
  });

  it("sheds when the last session holding a buffer disables", () => {
    const { tracker } = newTracker();
    tracker.setEnabled(undefined, true);
    const id = roundTrip(tracker);
    expect(tracker.retainedBodyBytes()).toBeGreaterThan(0);
    tracker.setEnabled(undefined, false);
    expect(tracker.retainedBodyBytes(), "Network.disable must hand the bytes back").toBe(0);
    expect(tracker.getResponseBody(id)).toBeNull();
  });
});

describe("destroyOopifTarget drops Network state", () => {
  it("forgets every session and the frame attribution", () => {
    const seen: Seen[] = [];
    const tracker = new NetworkEventTracker((ev) => {
      seen.push({ method: ev.method, sessionId: ev.sessionId });
    }, "conn-detach");
    live.push(tracker);
    tracker.setTargetAttribution("frame-1", "loader-1", ["sess-a", "sess-b"]);
    tracker.setEnabled("sess-a", true);
    tracker.setEnabled("sess-b", true);

    const sessions = new Set(["sess-a", "sess-b"]);
    // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- partial DispatchCtx fixture.
    const ctx = {
      emit: (ev: { method: string; sessionId?: string }) => seen.push(ev),
      browser: { networkEvents: tracker },
    } as unknown as Parameters<typeof destroyOopifTarget>[0];
    destroyOopifTarget(ctx, { frameId: "frame-1", sessions });

    expect(sessions.size, "the set is emptied").toBe(0);
    expect(tracker.attributionForTarget("frame-1")).toBeUndefined();
    expect(
      seen.filter((e) => e.method === "Target.detachedFromTarget").length,
      "one detachedFromTarget per session",
    ).toBe(2);
    const id = roundTrip(tracker);
    expect(tracker.getResponseBody(id)).toBeNull();
    expect(tracker.retainedBodyBytes()).toBe(0);
    seen.length = 0;
    roundTrip(tracker);
    expect(seen, "no events to detached sessions").toEqual([]);
  });
});
