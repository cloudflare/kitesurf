// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import { NetworkEventTracker, isolateRetainedBodyBytesTotal } from "../src/cdp/network-events.ts";

const BUDGET_BYTES = 12 * 1024 * 1024;
const BODY_CHARS = 128 * 1024;

const live: NetworkEventTracker[] = [];

afterEach(() => {
  while (live.length > 0) {
    const t = live.pop();
    if (t !== undefined) t.dispose();
  }
  expect(isolateRetainedBodyBytesTotal(), "each test must hand its bytes back").toBe(0);
});

function newTracker(): NetworkEventTracker {
  const t = new NetworkEventTracker(() => {}, "conn-budget");
  t.setEnabled(undefined, true);
  live.push(t);
  return t;
}

function issue(
  tracker: NetworkEventTracker,
  opts: { loaderId: string; bodyChars: number; url?: string },
): string {
  const url = opts.url ?? `https://example.test/${crypto.randomUUID()}`;
  const id = tracker.beginRequest({
    url,
    method: "GET",
    headers: {},
    type: "XHR",
    initiator: { type: "other" },
    loaderId: opts.loaderId,
    frameId: "frame-1",
  });
  tracker.completeRequest(id, {
    url,
    status: 200,
    statusText: "OK",
    headers: {},
    mimeType: "application/json",
    bodyLength: opts.bodyChars,
    body: "x".repeat(opts.bodyChars),
  });
  return id;
}

function at(ids: readonly string[], index: number): string {
  const id = ids[index];
  if (id === undefined) throw new Error(`no request id at index ${index}`);
  return id;
}

describe("NetworkEventTracker retained-body byte budget", () => {
  it("caps aggregate retained bodies well under the worker memory limit", () => {
    const tracker = newTracker();
    const ids: string[] = [];
    for (let i = 0; i < 300; i++) {
      ids.push(issue(tracker, { loaderId: "loader-1", bodyChars: BODY_CHARS }));
    }

    expect(tracker.retainedBodyBytes()).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(isolateRetainedBodyBytesTotal()).toBeLessThanOrEqual(BUDGET_BYTES);

    expect(tracker.getResponseBody(at(ids, ids.length - 1))).not.toBeNull();
    expect(tracker.getResponseBody(at(ids, 0))).toBeNull();
  });

  it("bounds the total across concurrent sessions, not per session", () => {
    const a = newTracker();
    const b = newTracker();
    for (let i = 0; i < 150; i++) {
      issue(a, { loaderId: "loader-a", bodyChars: BODY_CHARS });
      issue(b, { loaderId: "loader-b", bodyChars: BODY_CHARS });
    }
    expect(isolateRetainedBodyBytesTotal()).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(
      a.retainedBodyBytes() + b.retainedBodyBytes(),
      "per-session sums must equal the isolate total",
    ).toBe(isolateRetainedBodyBytesTotal());
  });

  it("returns a disposed session's bytes to the isolate budget", () => {
    const gone = newTracker();
    for (let i = 0; i < 20; i++) {
      issue(gone, { loaderId: "loader-1", bodyChars: 4096 });
    }
    expect(isolateRetainedBodyBytesTotal()).toBe(20 * 4096 * 2);
    gone.dispose();
    expect(isolateRetainedBodyBytesTotal()).toBe(0);
    gone.dispose();
    expect(isolateRetainedBodyBytesTotal()).toBe(0);
  });

  it("ignores a completion that lands after dispose", () => {
    const tracker = newTracker();
    const id = tracker.beginRequest({
      url: "https://example.test/late",
      method: "GET",
      headers: {},
      type: "XHR",
      initiator: { type: "other" },
      loaderId: "loader-1",
      frameId: "frame-1",
    });
    tracker.dispose();
    tracker.completeRequest(id, {
      url: "https://example.test/late",
      status: 200,
      statusText: "OK",
      headers: {},
      mimeType: "application/json",
      bodyLength: 4096,
      body: "x".repeat(4096),
    });
    expect(isolateRetainedBodyBytesTotal()).toBe(0);
    expect(tracker.retainedBodyBytes()).toBe(0);
    expect(tracker.getResponseBody(id)).toBeNull();
  });

  it("does not retain a body for a superseded document load", () => {
    const tracker = newTracker();
    const stale = tracker.beginRequest({
      url: "https://example.test/stale",
      method: "GET",
      headers: {},
      type: "XHR",
      initiator: { type: "other" },
      loaderId: "loader-1",
      frameId: "frame-1",
    });
    tracker.setTargetAttribution("frame-1", "loader-2", []);
    tracker.completeRequest(stale, {
      url: "https://example.test/stale",
      status: 200,
      statusText: "OK",
      headers: {},
      mimeType: "application/json",
      bodyLength: 4096,
      body: "y".repeat(4096),
    });
    expect(tracker.getResponseBody(stale)).toBeNull();
    expect(tracker.retainedBodyBytes()).toBe(0);
    const live = issue(tracker, { loaderId: "loader-2", bodyChars: 4096 });
    expect(tracker.getResponseBody(live)).not.toBeNull();
  });

  it("refunds the charge when a record is evicted past the count cap", () => {
    const tracker = newTracker();
    for (let i = 0; i < 600; i++) {
      issue(tracker, { loaderId: "loader-1", bodyChars: 1024 });
    }
    expect(tracker.retainedBodyBytes()).toBe(500 * 1024 * 2);
  });

  it("drops bodies from a superseded document load on navigate", () => {
    const tracker = newTracker();
    const first = issue(tracker, { loaderId: "loader-1", bodyChars: 4096 });
    tracker.setTargetAttribution("frame-1", "loader-2", []);
    const second = issue(tracker, { loaderId: "loader-2", bodyChars: 4096 });

    tracker.dropStaleLoaderBodies("frame-1");

    expect(tracker.getResponseBody(first)).toBeNull();
    expect(tracker.getResponseBody(second)).not.toBeNull();
    expect(tracker.retainedBodyBytes()).toBe(4096 * 2);
  });

  it("keeps every body when no navigation has committed yet", () => {
    const tracker = newTracker();
    const id = issue(tracker, { loaderId: "loader-1", bodyChars: 4096 });
    tracker.dropStaleLoaderBodies("frame-1");
    expect(tracker.getResponseBody(id)).not.toBeNull();
  });
});
