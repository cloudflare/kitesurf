// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A routed fetch whose signal aborts before the session stub answers still resolves on the
// private continuation. Nobody is left to read that response, so its body must be cancelled.
// page-script modules load through vi.importActual: engine's tsconfig must not type-check them.

import { afterEach, describe, expect, it, vi } from "vitest";

type Stub = (request: unknown) => Promise<Response>;

const sessionOutbound = (await vi.importActual("../../page-script/src/session-outbound.ts")) as {
  routeViaSession: (native: typeof globalThis.fetch) => typeof globalThis.fetch;
  setSessionOutbound: (stub: Stub) => void;
  clearSessionOutbound: (stub: Stub) => void;
  cancelSessionResponseBodies: () => void;
};

let installed: Stub | null = null;

afterEach(() => {
  sessionOutbound.cancelSessionResponseBodies();
  if (installed) sessionOutbound.clearSessionOutbound(installed);
  installed = null;
});

it("cancels a response body that arrives after the abort", async () => {
  let release!: (response: Response) => void;
  let requested!: () => void;
  const inFlight = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const stub: Stub = () => {
    requested();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  };
  installed = stub;
  sessionOutbound.setSessionOutbound(stub);

  const routed = sessionOutbound.routeViaSession(globalThis.fetch);
  const controller = new AbortController();
  // The page fetch shim follows redirects itself and hands the session a manual request.
  const pending = routed("https://ks.invalid/sse", {
    signal: controller.signal,
    redirect: "manual",
  });
  await inFlight;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });

  let canceled = false;
  release(
    new Response(
      new ReadableStream({
        cancel() {
          canceled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(canceled).toBe(true);
});

const ROUTED_URL = "https://origin.test/asset";

// The page fetch shim owns redirects, so it routes every request with manual redirects.
const ROUTED_INIT: RequestInit = { redirect: "manual" };

const CANCELLED = "cancelled";

const FIRST_CHUNK = new TextEncoder().encode("first");

const SECOND_CHUNK = new TextEncoder().encode("second");

// A routed fetch must reach the stub, never a socket in the loaded worker.
const NATIVE_FETCH: typeof globalThis.fetch = () => {
  throw new Error("routed fetch reached the native fetch");
};

function installOutbound(respond: Stub): void {
  installed = respond;
  sessionOutbound.setSessionOutbound(respond);
}

interface OpenBody {
  body: ReadableStream<Uint8Array>;
  push(chunk: Uint8Array): void;
  end(): void;
}

// A body the test feeds chunk by chunk, so it stays open until the test ends it.
function openBody(cancels: string[]): OpenBody {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(started) {
      controller = started;
    },
    cancel() {
      cancels.push(CANCELLED);
    },
  });
  const stream = (): ReadableStreamDefaultController<Uint8Array> => {
    if (!controller) throw new Error("body stream did not start");
    return controller;
  };
  return {
    body,
    push(chunk) {
      stream().enqueue(chunk);
    },
    end() {
      stream().close();
    },
  };
}

// A body the page reads to the end.
function completeBody(cancels: string[]): ReadableStream<Uint8Array> {
  const source = openBody(cancels);
  source.push(FIRST_CHUNK);
  source.push(SECOND_CHUNK);
  source.end();
  return source.body;
}

function bodyOf(response: Response): ReadableStream<Uint8Array> {
  const body = response.body;
  if (!body) throw new Error("response has no body");
  return body;
}

describe("routed response bodies", () => {
  it("ends a routed body the page never read", async () => {
    const cancels: string[] = [];
    const source = openBody(cancels);
    source.push(FIRST_CHUNK);
    installOutbound(async () => new Response(source.body));
    const routed = sessionOutbound.routeViaSession(NATIVE_FETCH);
    const response = await routed(ROUTED_URL, ROUTED_INIT);

    sessionOutbound.cancelSessionResponseBodies();

    await expect.poll(() => cancels).toEqual([CANCELLED]);
    await expect(response.text()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("ends a routed body the page is reading", async () => {
    const cancels: string[] = [];
    const source = openBody(cancels);
    source.push(FIRST_CHUNK);
    installOutbound(async () => new Response(source.body));
    const routed = sessionOutbound.routeViaSession(NATIVE_FETCH);
    const response = await routed(ROUTED_URL, ROUTED_INIT);
    const reader = bodyOf(response).getReader();
    expect((await reader.read()).value).toEqual(FIRST_CHUNK);

    sessionOutbound.cancelSessionResponseBodies();

    await expect.poll(() => cancels).toEqual([CANCELLED]);
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("ends every routed body still open when the session closes", async () => {
    const cancels: string[] = [];
    const sources = [openBody(cancels), openBody(cancels), openBody(cancels)];
    let next = 0;
    installOutbound(async () => new Response(sources[next++]!.body));
    const routed = sessionOutbound.routeViaSession(NATIVE_FETCH);
    for (let i = 0; i < sources.length; i++) await routed(ROUTED_URL, ROUTED_INIT);

    sessionOutbound.cancelSessionResponseBodies();

    await expect.poll(() => cancels).toEqual([CANCELLED, CANCELLED, CANCELLED]);
  });

  it("leaves a routed body the page read to the end alone", async () => {
    const cancels: string[] = [];
    installOutbound(async () => new Response(completeBody(cancels)));
    const routed = sessionOutbound.routeViaSession(NATIVE_FETCH);
    const response = await routed(ROUTED_URL, ROUTED_INIT);
    expect(await response.text()).toBe("firstsecond");

    sessionOutbound.cancelSessionResponseBodies();

    expect(cancels).toEqual([]);
  });

  it("ends a routed body the page is reading when the fetch is aborted", async () => {
    const cancels: string[] = [];
    const source = openBody(cancels);
    source.push(FIRST_CHUNK);
    installOutbound(async () => new Response(source.body));
    const controller = new AbortController();
    const abortReason = new Error("page navigated");
    const routed = sessionOutbound.routeViaSession(NATIVE_FETCH);
    const response = await routed(ROUTED_URL, { ...ROUTED_INIT, signal: controller.signal });
    const reader = bodyOf(response).getReader();
    expect((await reader.read()).value).toEqual(FIRST_CHUNK);

    controller.abort(abortReason);

    await expect.poll(() => cancels).toEqual([CANCELLED]);
    await expect(reader.read()).rejects.toBe(abortReason);
  });

  it("keeps the status, headers and url of the routed response", async () => {
    const cancels: string[] = [];
    installOutbound(
      async () =>
        new Response(completeBody(cancels), {
          status: 201,
          statusText: "Created",
          headers: { "x-origin": "engine" },
        }),
    );
    const routed = sessionOutbound.routeViaSession(NATIVE_FETCH);

    const response = await routed(`${ROUTED_URL}?v=1#fragment`, ROUTED_INIT);

    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(response.headers.get("x-origin")).toBe("engine");
    expect(response.url).toBe(`${ROUTED_URL}?v=1`);
    expect(() => response.headers.set("x-origin", "page")).toThrow(TypeError);
  });

  it("returns a response with no body as is", async () => {
    installOutbound(async () => new Response(null, { status: 204 }));
    const routed = sessionOutbound.routeViaSession(NATIVE_FETCH);

    const response = await routed(ROUTED_URL, ROUTED_INIT);

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it("keeps a routed body from a page that replaced Response and ReadableStream", async () => {
    const cancels: string[] = [];
    const engineResponse = new Response(completeBody(cancels));
    installOutbound(async () => engineResponse);
    const routed = sessionOutbound.routeViaSession(NATIVE_FETCH);
    const realResponse = Response;
    const realStream = ReadableStream;
    const seen: unknown[] = [];
    // A page-installed constructor would receive the routed body, opaque responses included.
    vi.stubGlobal("Response", function (...args: unknown[]) {
      seen.push(args[0]);
      return Reflect.construct(realResponse, args);
    });
    vi.stubGlobal("ReadableStream", function (...args: unknown[]) {
      seen.push(args[0]);
      return Reflect.construct(realStream, args);
    });
    try {
      const response = await routed(ROUTED_URL, ROUTED_INIT);
      expect(await response.text()).toBe("firstsecond");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(seen).toEqual([]);
  });

  it("supports BYOB reading, survives Object.prototype poisoning, and surfaces stream errors as TypeError", async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode("abcdefghij");
    // Chunks arrive in their own buffers: a byte-stream enqueue detaches the buffer it is given.
    const engineResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, 4));
          controller.enqueue(bytes.slice(4));
          controller.close();
        },
      }),
    );
    installOutbound(async () => engineResponse);
    const routed = sessionOutbound.routeViaSession(NATIVE_FETCH);

    // Poison Object.prototype with throwing accessors matching WPT stream-safe-creation.
    const poisoned = ["start", "type", "size", "highWaterMark"] as const;
    for (const key of poisoned) {
      Object.defineProperty(Object.prototype, key, {
        get() {
          throw new Error(`Object.prototype.${key} accessed`);
        },
        configurable: true,
      });
    }
    try {
      const response = await routed(ROUTED_URL, ROUTED_INIT);
      const reader = response.body!.getReader({ mode: "byob" });
      const out = new Uint8Array(bytes.byteLength);
      let offset = 0;
      while (offset < out.byteLength) {
        const chunkLen = Math.min(3, out.byteLength - offset);
        const { value, done } = await reader.read(new Uint8Array(chunkLen));
        if (value) {
          out.set(value, offset);
          offset += value.byteLength;
        }
        if (done) break;
      }
      expect(new TextDecoder().decode(out.subarray(0, offset))).toBe("abcdefghij");
    } finally {
      for (const key of poisoned) {
        delete (Object.prototype as Record<string, unknown>)[key];
      }
    }

    // Stream errors from decompression/RPC surface as TypeError.
    installOutbound(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("corrupt gzip stream"));
            },
          }),
        ),
    );
    const failing = await routed(ROUTED_URL, ROUTED_INIT);
    await expect(failing.text()).rejects.toBeInstanceOf(TypeError);
  });
});
