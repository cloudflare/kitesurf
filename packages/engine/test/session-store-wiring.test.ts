// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The engine keeps a session's data in the store the host supplies, sizes it by the limits that
// store declares, and writes back what it changes, so a backend that hands out copies works.

import { createExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleWebSocket } from "../src/cdp/connection.ts";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import { NetworkEventTracker, isolateRetainedBodyBytesTotal } from "../src/cdp/network-events.ts";
import type { CdpEvent } from "../src/cdp/types.ts";
import type { EngineHost } from "../src/host.ts";
import { JsonSessionStore } from "./json-session-store.ts";

const live: NetworkEventTracker[] = [];

afterEach(() => {
  for (const t of live.splice(0)) t.dispose();
  vi.unstubAllGlobals();
});

function tracker(store: JsonSessionStore, events: CdpEvent[] = []): NetworkEventTracker {
  const t = new NetworkEventTracker((ev) => events.push(ev), "conn-store", store);
  live.push(t);
  return t;
}

function request(
  t: NetworkEventTracker,
  body: string,
  sessionIds?: Array<string | undefined>,
): string {
  const url = `https://example.test/${crypto.randomUUID()}`;
  const id = t.beginRequest({
    url,
    method: "GET",
    headers: {},
    type: "XHR",
    initiator: { type: "other" },
    loaderId: "loader-1",
    frameId: "frame-1",
    sessionIds,
  });
  t.completeRequest(id, {
    url,
    status: 200,
    statusText: "OK",
    headers: {},
    mimeType: "application/json",
    bodyLength: body.length,
    body,
  });
  return id;
}

describe("the network log in a session store", () => {
  it("keeps records and bodies in the store, up to the requests the store allows", () => {
    const store = new JsonSessionStore({ networkRequests: 2 });
    const t = tracker(store);
    t.setEnabled(undefined, true);
    const ids = [request(t, "one"), request(t, "two"), request(t, "three")];

    expect(t.retainedRequestCount()).toBe(2);
    expect(Array.from(store.rows("network.requests").keys())).toEqual(ids.slice(1));
    expect(Array.from(store.rows("network.bodies").keys())).toEqual(ids.slice(1));
    expect(t.getResponseBody(ids[0] ?? "")).toBeNull();
    expect(t.getResponseBody(ids[2] ?? "")).toEqual({ body: "three", base64Encoded: false });
  });

  it("clamps what Network.enable asks for to the store's body limits", () => {
    const store = new JsonSessionStore({
      networkBodyBytes: 1_000,
      networkBodyBytesPerResource: 100,
    });
    const t = tracker(store);
    t.setEnabled(undefined, true, { maxTotalBufferSize: 1e9, maxResourceBufferSize: 1e9 });
    expect(t.perBodyBudget()).toBe(100);

    // Two bytes per UTF-16 code unit: 50 units fit the per-body limit, 51 do not.
    const fits = request(t, "a".repeat(50));
    const over = request(t, "a".repeat(51));
    expect(t.getResponseBody(fits)?.body).toHaveLength(50);
    expect(t.getResponseBody(over)).toBeNull();
  });

  it("does not charge a store off the heap against the isolate's body budget", () => {
    const before = isolateRetainedBodyBytesTotal();
    const off = tracker(new JsonSessionStore());
    off.setEnabled(undefined, true);
    request(off, "a".repeat(1_000));
    expect(isolateRetainedBodyBytesTotal()).toBe(before);
    expect(off.retainedBodyBytes()).toBe(0);

    const on = tracker(new JsonSessionStore({ onHeap: true }));
    on.setEnabled(undefined, true);
    request(on, "a".repeat(1_000));
    expect(isolateRetainedBodyBytesTotal()).toBe(before + 2_000);
    expect(on.retainedBodyBytes()).toBe(2_000);
  });

  it("writes a changed record back, so a request completes once", () => {
    const t = tracker(new JsonSessionStore());
    const id = request(t, "{}");
    expect(t.getInFlight()).toBe(0);
    t.failRequest(id, "net::ERR_ABORTED");
    expect(t.getInFlight()).toBe(0);
  });

  it("sends a root-session event without a session id after the record round-trips", () => {
    const events: CdpEvent[] = [];
    const t = tracker(new JsonSessionStore(), events);
    t.setEnabled(undefined, true);
    t.setEnabled("s1", true);
    request(t, "{}", [undefined, "s1"]);
    t.drain();

    const responses = events.filter((e) => e.method === "Network.responseReceived");
    expect(responses.map((e) => e.sessionId)).toEqual([undefined, "s1"]);
    expect(responses.some((e) => e.sessionId === null)).toBe(false);
  });
});

describe("a browser session with a host store", () => {
  it("keeps its data in the store the host creates", async () => {
    const store = new JsonSessionStore();
    let seen: DispatchCtx | undefined;
    const host: EngineHost = { createSessionStore: () => store };
    const r = await handleWebSocket(
      new Request("https://x/devtools/browser"),
      {} as Env,
      createExecutionContext(),
      (dctx: DispatchCtx) => {
        seen = dctx;
      },
      { host },
    );
    expect(seen?.browser.store).toBe(store);
    r.webSocket?.accept();
    r.webSocket?.close(1000, "done");
  });
});
