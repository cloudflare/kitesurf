// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A server-sent event stream stays open for the life of the page. Capturing its body for Network
// would wait for an EOF that never comes, so the page's EventSource never sees its first message.

import { afterEach, describe, expect, it } from "vitest";
import { NetworkEventTracker } from "../src/cdp/network-events.ts";
import { registerTracker, unregisterTracker } from "../src/cdp/network-events-registry.ts";
import {
  SandboxOutbound,
  type OutboundProps,
  type SandboxOutboundEnv,
} from "../src/eval/outbound.ts";

const CONNECTION = "outbound-event-stream";
const PAGE = "https://page.test/page";
const SSE_URL = "https://page.test/sse";

const live: NetworkEventTracker[] = [];

afterEach(() => {
  unregisterTracker(CONNECTION);
  while (live.length > 0) live.pop()?.dispose();
});

// Network.enable with both buffer sizes set is what makes the tracker retain response bodies.
function trackNetwork(): {
  tracker: NetworkEventTracker;
  events: string[];
  requestId: () => string;
} {
  const events: string[] = [];
  let requestId = "";
  const tracker = new NetworkEventTracker((event) => {
    events.push(event.method);
    if (event.method === "Network.requestWillBeSent") requestId = event.params.requestId;
  }, CONNECTION);
  tracker.setEnabled(undefined, true, {
    maxTotalBufferSize: 1024 * 1024,
    maxResourceBufferSize: 256 * 1024,
  });
  registerTracker(CONNECTION, tracker);
  live.push(tracker);
  return { tracker, events, requestId: () => requestId };
}

async function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(what)), 1000);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function gateway(
  fetch: (request: Request) => Promise<Response>,
  request: Request,
): Promise<Response> {
  const props: OutboundProps = {
    pageOrigin: PAGE,
    connectionId: CONNECTION,
    externalOutbound: { fetch },
  };
  return SandboxOutbound.handle({} as SandboxOutboundEnv, props, request);
}

// The stream never closes: an open connection is exactly what the capture must not wait for.
function openStream(first: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(first));
    },
  });
}

describe("Network body capture skips an event stream", () => {
  it.each([
    ["an EventSource request", "EventSource", "text/plain; charset=utf-8"],
    ["a text/event-stream response", "Fetch", "text/event-stream"],
  ])("streams %s to the consumer before it ends", async (_name, type, contentType) => {
    const network = trackNetwork();
    const response = await withTimeout(
      gateway(
        async () =>
          new Response(openStream("data: hello\n\n"), { headers: { "content-type": contentType } }),
        new Request(SSE_URL, {
          headers: { "x-kitesurf-resource-type": type, accept: "text/event-stream" },
        }),
      ),
      "the outbound fetch waited for the event stream to end",
    );
    const reader = response.body!.getReader();
    const chunk = await withTimeout(
      reader.read(),
      "no chunk reached the consumer while the stream was open",
    );
    expect(new TextDecoder().decode(chunk.value)).toBe("data: hello\n\n");
    await reader.cancel();
    network.tracker.drain();
    expect(network.events).toContain("Network.responseReceived");
    expect(network.events).toContain("Network.loadingFinished");
    expect(network.events).not.toContain("Network.loadingFailed");
    // Chrome serves no body for a live stream, so neither does the tracker.
    expect(network.tracker.getResponseBody(network.requestId())).toBeNull();
  });

  it("still captures a finite text body", async () => {
    const network = trackNetwork();
    const response = await gateway(
      async () =>
        new Response("hello", { headers: { "content-type": "text/plain; charset=utf-8" } }),
      new Request("https://page.test/text", { headers: { "x-kitesurf-resource-type": "Fetch" } }),
    );
    expect(await response.text()).toBe("hello");
    network.tracker.drain();
    expect(network.tracker.getResponseBody(network.requestId())).toEqual({
      body: "hello",
      base64Encoded: false,
    });
  });
});
