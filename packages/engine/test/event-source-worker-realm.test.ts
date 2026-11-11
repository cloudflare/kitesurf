// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The dedicated-worker realm installs the fetch shim and the EventSource over it but never
// installGlobals: its EventTarget is workerd's and ksEventCtors empty, so events come from the
// realm's own constructors. It also captures the trusted fetch, or the stream is labeled Fetch.

// The worker-script modules load through vi.importActual: engine's tsconfig must not check them.

import { beforeAll, describe, expect, it, vi } from "vitest";

interface OutboundRequest {
  url: string;
  method: string;
  headers: Array<[string, string]>;
}

const sent: OutboundRequest[] = [];

beforeAll(async () => {
  const workerScript = (await vi.importActual("../../worker-script/src/index.ts")) as any;
  // start() reads no entrypoint state, and the test isolate is the worker's globalThis.
  const worker = Object.create(workerScript.DedicatedWorker.prototype) as any;
  const session = worker.openSession({
    outbound: async (request: OutboundRequest) => {
      sent.push(request);
      return new Response("data: hi\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  // The loader supplies no worker module here, so start() only installs the shims and scope.
  await session.start({
    url: "https://worker.test/worker.js",
    baseUrl: "https://page.test/",
    name: "realm",
    navigator: {
      userAgent: "Mozilla/5.0",
      language: "en",
      languages: ["en"],
      platform: "MacIntel",
    },
    connectionId: "worker-realm",
    frameId: "",
    cookieKey: "",
    timeOrigin: 0,
  });
});

function nextMessage(source: any): Promise<any> {
  return new Promise((resolve) => {
    source.addEventListener("message", resolve);
  });
}

describe("EventSource in the dedicated-worker realm", () => {
  it("delivers open and message events through the native EventTarget", async () => {
    // Relative to location.href: this realm has no document to supply a base.
    const source = new (globalThis as any).EventSource("/sse");
    const opened = new Promise<any>((resolve) => {
      source.onopen = resolve;
    });
    const message = nextMessage(source);
    const [openEvent, messageEvent] = await Promise.all([opened, message]);
    source.close();
    expect([openEvent.type, messageEvent.type, messageEvent.data]).toEqual([
      "open",
      "message",
      "hi",
    ]);
    expect(messageEvent).toBeInstanceOf(Event);
    expect(messageEvent.target).toBe(source);
    // The worker scope's MessageEvent keeps the stream's origin, not an empty default.
    expect([messageEvent.origin, messageEvent.lastEventId]).toEqual(["https://worker.test", ""]);
  });

  it("labels the stream request as EventSource", async () => {
    const before = sent.length;
    const source = new (globalThis as any).EventSource("/sse");
    await nextMessage(source);
    source.close();
    expect(sent.length).toBe(before + 1);
    const headers = new Map(sent[before]!.headers);
    expect(headers.get("x-kitesurf-resource-type")).toBe("EventSource");
  });
});
