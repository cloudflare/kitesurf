// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { afterEach, describe, expect, it } from "vitest";
import { handleLog } from "../src/cdp/log.ts";
import { NetworkEventTracker } from "../src/cdp/network-events.ts";
import { registerTracker, unregisterTracker } from "../src/cdp/network-events-registry.ts";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import type { CdpEvent, CdpRequest } from "../src/cdp/types.ts";
import {
  SandboxOutbound,
  type CallerOutboundProps,
  type SandboxOutboundEnv,
} from "../src/eval/outbound.ts";

const CONNECTION = "log-conn";
const PAGE_SESSION = "sess-page";
const OTHER_SESSION = "sess-other";
const PAGE_FRAME = "frame-page";
const OTHER_FRAME = "frame-other";
const PAGE_ORIGIN = "https://page.test";
const BLOCKED_URL = "https://remote.test/blocked.json?token=secret";

const live: NetworkEventTracker[] = [];

afterEach(() => {
  while (live.length > 0) live.pop()?.dispose();
  unregisterTracker(CONNECTION);
});

function tracked(): { tracker: NetworkEventTracker; events: CdpEvent[] } {
  const events: CdpEvent[] = [];
  const tracker = new NetworkEventTracker((ev) => events.push(ev), CONNECTION);
  tracker.setTargetAttribution(PAGE_FRAME, "loader-page", [PAGE_SESSION]);
  tracker.setTargetAttribution(OTHER_FRAME, "loader-other", [OTHER_SESSION]);
  registerTracker(CONNECTION, tracker);
  live.push(tracker);
  return { tracker, events };
}

function logEntries(events: CdpEvent[]) {
  return events.flatMap((ev) => (ev.method === "Log.entryAdded" ? [ev] : []));
}

// Drives the real gateway as a page-realm fetch; only the host transport is faked.
function pageFetch(props: Partial<CallerOutboundProps> = {}, url = BLOCKED_URL): Promise<Response> {
  return SandboxOutbound.handle(
    {} as SandboxOutboundEnv,
    {
      pageOrigin: PAGE_ORIGIN,
      connectionId: CONNECTION,
      mainFrameId: PAGE_FRAME,
      pageRealm: true,
      externalOutbound: {
        fetch: async () =>
          new Response("secret", { headers: { "content-type": "application/json" } }),
      },
      ...props,
    },
    new Request(url, { headers: { "x-kitesurf-resource-type": "Fetch" } }),
  );
}

describe("Log domain", () => {
  it("tracks Log.enable and Log.disable per session", async () => {
    const { tracker } = tracked();
    // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the ledger is read.
    const ctx = { browser: { networkEvents: tracker } } as unknown as DispatchCtx;
    const enable = { id: 1, method: "Log.enable", sessionId: PAGE_SESSION } as CdpRequest;
    const disable = { id: 2, method: "Log.disable", sessionId: PAGE_SESSION } as CdpRequest;

    expect(await handleLog(ctx, enable)).toEqual({});
    expect(tracker.isLogEnabled(PAGE_SESSION)).toBe(true);
    expect(tracker.isLogEnabled(OTHER_SESSION)).toBe(false);

    expect(await handleLog(ctx, disable)).toEqual({});
    expect(tracker.isLogEnabled(PAGE_SESSION)).toBe(false);
  });

  it("reports a blocked page fetch as one Log entry on the owning session", async () => {
    const { tracker, events } = tracked();
    tracker.setLogEnabled(PAGE_SESSION, true);
    tracker.setLogEnabled(OTHER_SESSION, true);

    const response = await pageFetch();
    tracker.drain();

    expect(response.status).toBe(403);
    // The page gets the generic rejection: the detailed body names the blocked target.
    expect(await response.text()).toBe("kitesurf: blocked by CORS policy (cors-missing-origin)");
    expect(events.some((ev) => ev.method === "Runtime.consoleAPICalled")).toBe(false);

    const entries = logEntries(events);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (entry?.method !== "Log.entryAdded") throw new Error("no Log.entryAdded event");
    expect(entry.sessionId).toBe(PAGE_SESSION);
    expect(entry.params.entry).toEqual({
      source: "network",
      level: "error",
      text:
        "Access to fetch at 'https://remote.test/blocked.json' from origin 'https://page.test' " +
        "has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present " +
        "on the requested resource.",
      timestamp: expect.any(Number),
      url: "https://remote.test/blocked.json",
      lineNumber: 0,
      networkRequestId: expect.any(String),
    });
  });

  it("stays silent when the owning session has not enabled Log", async () => {
    const { tracker, events } = tracked();
    tracker.setLogEnabled(OTHER_SESSION, true);

    const response = await pageFetch();
    tracker.drain();

    expect(response.status).toBe(403);
    expect(logEntries(events)).toEqual([]);
    expect(tracker.retainedRequestCount(), "the request is still tracked").toBe(1);
  });

  it("names an opaque origin 'null'", async () => {
    const { tracker, events } = tracked();
    tracker.setLogEnabled(PAGE_SESSION, true);

    await pageFetch({ pageOrigin: "" });
    tracker.drain();

    const [entry] = logEntries(events);
    if (entry?.method !== "Log.entryAdded") throw new Error("no Log.entryAdded event");
    expect(entry.params.entry.text).toContain("from origin 'null'");
  });

  it("reports a non-CORS block with its existing detail text", async () => {
    const { tracker, events } = tracked();
    tracker.setLogEnabled(PAGE_SESSION, true);

    const response = await pageFetch({ pageOrigin: "https://kitesurf.local" });
    tracker.drain();

    expect(response.status).toBe(403);
    expect(response.headers.get("x-kitesurf-blocked")).toBe("synthetic-origin");
    expect(await response.text()).toBe(
      "kitesurf: synthetic-origin fetch dropped (no network during bench)",
    );
    const entries = logEntries(events);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (entry?.method !== "Log.entryAdded") throw new Error("no Log.entryAdded event");
    expect(entry.sessionId).toBe(PAGE_SESSION);
    // No hop was admitted, so there is no Network request to name, and the query token is gone.
    expect(entry.params.entry).toEqual({
      source: "network",
      level: "error",
      text: "synthetic-origin fetch dropped (no network during bench)",
      timestamp: expect.any(Number),
      url: "https://remote.test/blocked.json",
      lineNumber: 0,
    });
  });
});
