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
const SECRET = "sid=SECRET";

let EventStreamParser: any;
let state: any;
let gateway: ((request: Request) => Promise<Response>) | null = null;

beforeAll(async () => {
  const pageScriptState = (await vi.importActual("../../page-script/src/state.ts")) as any;
  const fetchShim = (await vi.importActual("../../page-script/src/fetch-shim.ts")) as any;
  const eventSource = (await vi.importActual("../../page-script/src/event-source.ts")) as any;
  EventStreamParser = eventSource.EventStreamParser;
  state = pageScriptState.state;
  state.pageUrl = PAGE;
  state.connectionId = KEY;
  state.cookieKey = KEY;
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
  const jar = createCookieJar();
  jar.setFromHeader("https://victim.example/", "sid=SECRET; Secure; Path=/; SameSite=None");
  registerCookieJar(KEY, jar);
  const seen: string[] = [];
  const outbound = createSandboxOutboundOverride(
    {} as SandboxOutboundExports,
    {} as SandboxOutboundEnv,
    {
      fetch: async (request) => {
        seen.push(`${request.headers.get("accept")} ${request.headers.get("cookie")}`);
        const headers: Record<string, string> = { "content-type": "text/event-stream" };
        headers["access-control-allow-origin"] = acac ? ORIGIN : "*";
        if (acac) headers["access-control-allow-credentials"] = "true";
        return new Response("data: hello\n\n", { headers });
      },
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
  const source = new Source(TARGET, { withCredentials });
  const first = await nextEvent(source);
  source.close();
  expect(source.readyState).toBe(2);
  return { seen, first };
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
});
