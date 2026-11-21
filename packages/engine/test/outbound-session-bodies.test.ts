// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import type { ExternalOutbound } from "../src/eval/external-outbound.ts";
import {
  createSandboxOutboundOverride,
  type SandboxOutboundEnv,
  type SandboxOutboundExports,
} from "../src/eval/outbound.ts";

const PAGE_ORIGIN = "https://page.example";

const env: SandboxOutboundEnv = {
  FONT_ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
};

const exports: SandboxOutboundExports = {
  SandboxOutbound: () => {
    throw new Error("a session never loads the sandbox entrypoint");
  },
};

interface OriginStream {
  body: ReadableStream<Uint8Array>;
  cancels: unknown[];
  push(text: string): void;
  close(): void;
}

// Stands in for the origin's response body: records the reason the engine cancels it with.
function originStream(): OriginStream {
  const encoder = new TextEncoder();
  const cancels: unknown[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel(reason) {
      cancels.push(reason);
    },
  });
  const live = () => {
    if (controller === null) throw new Error("the origin stream never started");
    return controller;
  };
  return {
    body,
    cancels,
    push: (text) => live().enqueue(encoder.encode(text)),
    close: () => live().close(),
  };
}

function sessionHandle(stream: OriginStream) {
  const egress: ExternalOutbound = {
    fetch: async () =>
      new Response(stream.body, { headers: { "content-type": "text/plain; charset=utf-8" } }),
  };
  const handle = createSandboxOutboundOverride(exports, env, egress).session({
    pageOrigin: PAGE_ORIGIN,
  });
  const fetchStream = () =>
    handle.outbound({
      url: `${PAGE_ORIGIN}/tick`,
      method: "GET",
      headers: [],
      body: null,
    });
  return { handle, fetchStream };
}

describe("session outbound bodies", () => {
  it("cancels a body still streaming to the page when the session is retired", async () => {
    const stream = originStream();
    const { handle, fetchStream } = sessionHandle(stream);
    const response = await fetchStream();
    stream.push("tick\n");
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("tick\n");

    handle.cancelBodies("page retired");

    expect(stream.cancels).toHaveLength(1);
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("leaves a fully read body alone", async () => {
    const stream = originStream();
    const { handle, fetchStream } = sessionHandle(stream);
    const response = await fetchStream();
    stream.push("tick\n");
    stream.close();
    expect(await response.text()).toBe("tick\n");

    handle.cancelBodies("page retired");

    expect(stream.cancels).toEqual([]);
  });

  it("fails a fetch that lands after the session was retired and cancels its body", async () => {
    const stream = originStream();
    const { handle, fetchStream } = sessionHandle(stream);
    handle.cancelBodies("page retired");

    await expect(fetchStream()).rejects.toThrow("Failed to fetch");
    expect(stream.cancels).toHaveLength(1);
  });
});
