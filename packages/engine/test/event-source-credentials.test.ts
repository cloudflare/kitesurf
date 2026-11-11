// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// EventSource fetches through the gated path with the credentials mode its withCredentials option
// selects, so a cross-origin stream carries jar cookies only when CORS admits them.
// The page-script modules load through vi.importActual: engine's tsconfig must not type-check them.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { registerCookieJar, unregisterCookieJar } from "../src/cdp/cookie-jar-registry.ts";
import { createCookieJar } from "../src/cookies.ts";
import {
  createSandboxOutboundOverride,
  type SandboxOutboundEnv,
  type SandboxOutboundExports,
} from "../src/eval/outbound.ts";

const KEY = "event-source-credentials";
const ORIGIN = "https://attacker.example";
const PAGE = `${ORIGIN}/page`;
const TARGET = "https://victim.example/sse";
const REDIRECTING = `${ORIGIN}/redirect`;
const SECRET = "sid=SECRET";

let EventStreamParser: any;
let state: any;
let gateway: ((request: Request) => Promise<Response>) | null = null;
// The reconnect timer runs on the setTimeout captured at module load, so recording its delays
// shows whether close() left one scheduled.
const realSetTimeout = setTimeout;
const scheduledDelays: number[] = [];

beforeAll(async () => {
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    scheduledDelays.push(Number(ms ?? 0));
    return realSetTimeout(callback, ms, ...args);
  }) as typeof setTimeout);
  const pageScriptState = (await vi.importActual("../../page-script/src/state.ts")) as any;
  const fetchShim = (await vi.importActual("../../page-script/src/fetch-shim.ts")) as any;
  const eventSource = (await vi.importActual("../../page-script/src/event-source.ts")) as any;
  const shimEvents = (await vi.importActual("../../dom-shim/src/events/event.ts")) as any;
  const shimNodes = (await vi.importActual("../../dom-shim/src/node-base.ts")) as any;
  EventStreamParser = eventSource.EventStreamParser;
  state = pageScriptState.state;
  state.pageUrl = PAGE;
  state.connectionId = KEY;
  state.cookieKey = KEY;
  // Engine-created events use the shim classes, and the shim EventTarget only dispatches those.
  pageScriptState.ksEventCtors.Event = shimEvents.KsEvent;
  pageScriptState.ksEventCtors.MessageEvent = shimEvents.KsMessageEvent;
  // installGlobals swaps in the shim's EventTarget before page JS runs; the source dispatches
  // through it, so the harness does the same.
  Object.defineProperty(globalThis, "EventTarget", {
    value: shimNodes.KsEventTarget,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  // The real page fetch path: the shim adds the carriers, then the real gateway decides.
  globalThis.fetch = ((input: any, init?: any) => {
    if (!gateway) throw new TypeError("no gateway");
    return gateway(new Request(input, init));
  }) as typeof fetch;
  fetchShim.installFetchShim();
  eventSource.installEventSource();
});

afterEach(() => {
  gateway = null;
  unregisterCookieJar(KEY);
});

function nextEvent(source: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no event")), 2000);
    const done = (event: any) => {
      clearTimeout(timer);
      source.removeEventListener("message", done);
      source.removeEventListener("error", done);
      resolve(event);
    };
    source.addEventListener("message", done);
    source.addEventListener("error", done);
  });
}

// acac decides whether the victim admits credentials: without it the wildcard origin must block.
async function stream(withCredentials: boolean, acac: boolean) {
  const seen: string[] = [];
  const source = openSource(withCredentials, (request) => {
    seen.push(`${request.headers.get("accept")} ${request.headers.get("cookie")}`);
    const headers: Record<string, string> = { "content-type": "text/event-stream" };
    headers["access-control-allow-origin"] = acac ? ORIGIN : "*";
    if (acac) headers["access-control-allow-credentials"] = "true";
    return new Response("data: hello\n\n", { headers });
  });
  const first = await nextEvent(source);
  source.close();
  expect(source.readyState).toBe(2);
  return { seen, first };
}

// One source over the real page fetch path; respond answers each hop with its index.
function openSource(
  withCredentials: boolean,
  respond: (request: Request, index: number) => Response | Promise<Response>,
  url = TARGET,
): any {
  const jar = createCookieJar();
  jar.setFromHeader("https://victim.example/", "sid=SECRET; Secure; Path=/; SameSite=None");
  registerCookieJar(KEY, jar);
  let index = 0;
  const outbound = createSandboxOutboundOverride(
    {} as SandboxOutboundExports,
    {} as SandboxOutboundEnv,
    {
      fetch: async (request) => respond(request, index++),
    },
  );
  const fetcher = outbound.parent({
    pageOrigin: ORIGIN,
    pageUrl: PAGE,
    connectionId: KEY,
    cookieKey: KEY,
  });
  gateway = (request) => fetcher.fetch(request);
  const Source = (globalThis as any).EventSource;
  return new Source(url, { withCredentials });
}

function sse(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "access-control-allow-origin": "*",
      // The reconnect hop carries Last-Event-ID, which CORS must admit.
      "access-control-allow-headers": "last-event-id",
    },
  });
}

describe("EventSource follows the browser credentials mode", () => {
  it.each([
    ["default same-origin sends no cookie", false, false, "text/event-stream null", "message"],
    [
      "withCredentials sends the cookie and CORS blocks it",
      true,
      false,
      `text/event-stream ${SECRET}`,
      "error",
    ],
    [
      "withCredentials is admitted with credentials",
      true,
      true,
      `text/event-stream ${SECRET}`,
      "message",
    ],
  ] as const)("%s", async (_name, withCredentials, acac, seen, type) => {
    const got = await stream(withCredentials, acac);
    expect([got.seen, got.first.type, got.first.data]).toEqual([
      [seen],
      type,
      type === "message" ? "hello" : undefined,
    ]);
  });
});

describe("EventSource event delivery", () => {
  it("reconnects with the last event ID of an id-only block", async () => {
    const ids: Array<string | null> = [];
    let reconnected!: () => void;
    const secondRequest = new Promise<void>((resolve) => {
      reconnected = resolve;
    });
    const source = openSource(false, (request) => {
      // The reconnect's Last-Event-ID header is not safelisted, so a preflight hop precedes it.
      if (request.method === "GET") {
        ids.push(request.headers.get("last-event-id"));
        if (ids.length === 2) reconnected();
      }
      return sse("retry: 0\nid: 7\n\n");
    });
    await secondRequest;
    source.close();
    expect(ids).toEqual([null, "7"]);
  });

  it("resumes with the saved id when a reconnect event has no id field", async () => {
    const ids: Array<string | null> = [];
    let third!: () => void;
    const thirdRequest = new Promise<void>((resolve) => {
      third = resolve;
    });
    const bodies = ["id: 5\ndata: a\n\n", "data: b\n\n"];
    const source = openSource(false, (request) => {
      if (request.method !== "GET") return sse("");
      ids.push(request.headers.get("last-event-id"));
      if (ids.length === 3) third();
      return sse(`retry: 0\n${bodies[Math.min(ids.length - 1, bodies.length - 1)]}`);
    });
    await thirdRequest;
    source.close();
    expect(ids).toEqual([null, "5", "5"]);
  });

  it("reports the final origin after a redirect", async () => {
    const source = openSource(
      false,
      (_request, index) =>
        index === 0
          ? new Response(null, { status: 302, headers: { location: TARGET } })
          : sse("data: hi\n\n"),
      REDIRECTING,
    );
    const event = await nextEvent(source);
    source.close();
    expect([event.type, event.origin]).toEqual(["message", "https://victim.example"]);
  });

  it("stops dispatching once a handler closes the source", async () => {
    const seen: string[] = [];
    const source = openSource(false, () => sse("data: 1\n\ndata: 2\n\ndata: 3\n\n"));
    source.onmessage = (event: any) => {
      seen.push(event.data);
      source.close();
    };
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toEqual(["1"]);
  });

  it("schedules no reconnect when a handler closes the source on error", async () => {
    scheduledDelays.length = 0;
    // A stream that ends cleanly raises error and then waits; retry names the wait it would use.
    const source = openSource(false, () => sse("retry: 1234\n\n"));
    await new Promise<void>((resolve) => {
      source.onerror = () => {
        source.close();
        resolve();
      };
    });
    await new Promise((resolve) => realSetTimeout(resolve, 10));
    expect(source.readyState).toBe(2);
    expect(scheduledDelays).not.toContain(1234);
  });

  it("sets the event target to the source", async () => {
    const source = openSource(false, () => sse("data: hi\n\n"));
    const event = await nextEvent(source);
    source.close();
    expect(event.target).toBe(source);
  });

  it("dispatches through the realm's EventTarget", async () => {
    const source = openSource(false, () => sse("data: hi\n\n"));
    const seen = new Promise<any>((resolve) => {
      source.addEventListener("message", (event: any) => {
        resolve([event.target, event.currentTarget, event.eventPhase, event.composedPath()]);
      });
    });
    const during = await seen;
    source.close();
    expect(source instanceof EventTarget).toBe(true);
    expect(during).toEqual([source, source, 2, [source]]);
  });

  it("fires a once listener only for the first event", async () => {
    const seen: string[] = [];
    const source = openSource(false, () => sse("data: 1\n\ndata: 2\n\n"));
    source.addEventListener("message", (event: any) => seen.push(event.data), { once: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    source.close();
    expect(seen).toEqual(["1"]);
  });

  it("calls a handleEvent listener object", async () => {
    const seen: string[] = [];
    const source = openSource(false, () => sse("data: hi\n\n"));
    const done = new Promise<void>((resolve) => {
      source.addEventListener("message", {
        handleEvent(event: any) {
          seen.push(event.data);
          resolve();
        },
      });
    });
    await done;
    source.close();
    expect(seen).toEqual(["hi"]);
  });

  it("removes a listener when its abort signal fires", async () => {
    const controller = new AbortController();
    const signaled: string[] = [];
    const all: string[] = [];
    const source = openSource(false, () => sse("data: 1\n\ndata: 2\n\n"));
    source.addEventListener("message", (event: any) => signaled.push(event.data), {
      signal: controller.signal,
    });
    source.addEventListener("message", (event: any) => all.push(event.data));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    source.close();
    expect([signaled, all]).toEqual([[], ["1", "2"]]);
  });

  it("does not call an on<type> expando for an arbitrary event name", async () => {
    const calls: string[] = [];
    const source = openSource(false, () => sse("event: ping\ndata: hi\n\n"));
    (source as any).onping = () => calls.push("onping");
    const event = await new Promise<any>((resolve) => {
      source.addEventListener("ping", resolve);
    });
    source.close();
    expect([event.type, calls]).toEqual(["ping", []]);
  });

  it("cancels the response body when closed during the request", async () => {
    let release!: (response: Response) => void;
    let requested!: () => void;
    let canceled = false;
    const inFlight = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const source = openSource(
      false,
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
          requested();
        }),
    );
    await inFlight;
    source.close();
    const body = new ReadableStream({
      cancel() {
        canceled = true;
      },
    });
    release(
      new Response(body, {
        headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(canceled).toBe(true);
  });
});

describe("event stream parsing", () => {
  it.each([
    ["data: a\n\n", [{ type: "message", data: "a", lastEventId: "" }]],
    ["\uFEFFdata: bom\n\n", [{ type: "message", data: "bom", lastEventId: "" }]],
    [":comment\n\ndata:b\r\n\r\n", [{ type: "message", data: "b", lastEventId: "" }]],
    ["event: tick\ndata: 1\n\n", [{ type: "tick", data: "1", lastEventId: "" }]],
    ["id: 7\ndata: x\n\n", [{ type: "message", data: "x", lastEventId: "7" }]],
    ["data: a\ndata: b\n\n", [{ type: "message", data: "a\nb", lastEventId: "" }]],
    ["data: 1\n", []],
  ])("%j", (input, expected) => {
    expect(new EventStreamParser().push(input)).toEqual(expected);
  });

  it("keeps a CRLF split across chunks as one line break", () => {
    const parser = new EventStreamParser();
    expect(parser.push("data: a\r")).toEqual([]);
    expect(parser.push("\ndata: b\r\n\r\n")).toEqual([
      { type: "message", data: "a\nb", lastEventId: "" },
    ]);
  });

  it("reads the retry field", () => {
    const parser = new EventStreamParser();
    parser.push("retry: 50\n\n");
    expect(parser.reconnectionTimeMs).toBe(50);
  });

  it("keeps the last event ID of an id-only block", () => {
    const parser = new EventStreamParser();
    expect(parser.push("id: 7\n\n")).toEqual([]);
    expect(parser.lastEventId).toBe("7");
  });
});
