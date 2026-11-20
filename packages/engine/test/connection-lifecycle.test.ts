// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// handleWebSocket over a fake server socket: the order of the in-process hooks and the initial
// page, teardown on close and error, the two deadlines, and a host hook that throws.

import { createExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleWebSocket } from "../src/cdp/connection.ts";
import { getTracker } from "../src/cdp/network-events-registry.ts";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import type { EngineHost } from "../src/host.ts";
import { SESSION_ID_HEADER, type TelemetryEvent } from "../src/observability.ts";

interface FakeServer extends EventTarget {
  sent: string[];
  closes: Array<{ code: number; reason: string }>;
  accepted: number;
  accept(): void;
  send(data: string): void;
  close(code: number, reason: string): void;
}

// The server end of the pair. close() records the call and sends no close event, as a peer
// that has not answered the close frame yet.
function fakeServer(): FakeServer {
  const server = Object.assign(new EventTarget(), {
    sent: [] as string[],
    closes: [] as Array<{ code: number; reason: string }>,
    accepted: 0,
    accept() {
      server.accepted++;
    },
    send(data: string) {
      server.sent.push(data);
    },
    close(code: number, reason: string) {
      server.closes.push({ code, reason });
    },
  });
  const RealPair = WebSocketPair;
  vi.stubGlobal("WebSocketPair", function () {
    return { 0: Object.values(new RealPair())[0], 1: server };
  });
  return server;
}

function createdTargetIds(server: FakeServer): string[] {
  return server.sent
    .map(
      (s) => JSON.parse(s) as { method?: string; params?: { targetInfo?: { targetId: string } } },
    )
    .filter((m) => m.method === "Target.targetCreated")
    .map((m) => m.params?.targetInfo?.targetId ?? "");
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("handleWebSocket", () => {
  it("runs the in-process hooks before it creates the initial page", async () => {
    const server = fakeServer();
    let targetsSeenByOnCtx = -1;
    await handleWebSocket(
      new Request("https://x/devtools/browser"),
      {} as Env,
      createExecutionContext(),
      (dctx: DispatchCtx) => {
        targetsSeenByOnCtx = dctx.browser.targets.size;
      },
      {
        onDispatch: (dispatch) => {
          void dispatch({ id: 1, method: "Target.createTarget", params: { url: "about:blank" } });
        },
      },
    );
    await settle();
    expect(targetsSeenByOnCtx).toBe(0);
    // The hook's page and the initial page, each announced once.
    const ids = createdTargetIds(server);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("tears down once and sends one session_end when an error follows the close", async () => {
    const server = fakeServer();
    const events: TelemetryEvent[] = [];
    const host: EngineHost = { telemetry: () => ({ emit: (e) => events.push(e) }) };
    const r = await handleWebSocket(
      new Request("https://x/devtools/browser"),
      {} as Env,
      createExecutionContext(),
      undefined,
      { host },
    );
    const id = r.headers.get(SESSION_ID_HEADER) ?? "";
    expect(getTracker(id)).toBeDefined();
    server.dispatchEvent(Object.assign(new Event("close"), { code: 1000, wasClean: true }));
    server.dispatchEvent(new Event("error"));
    expect(getTracker(id)).toBeUndefined();
    const ends = events.filter((e) => e.name === "session_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]?.fields).toMatchObject({ endReason: "close", closeCode: 1000, wasClean: 1 });
  });

  it("closes an idle socket once, also when the wall-clock cap passes during the close", async () => {
    vi.useFakeTimers();
    const server = fakeServer();
    await handleWebSocket(
      new Request("https://x/devtools/browser?ksIdleMs=1000&ksMaxSessionMs=5000"),
      {} as Env,
      createExecutionContext(),
    );
    await vi.advanceTimersByTimeAsync(1_500);
    expect(server.closes).toHaveLength(1);
    expect(server.closes[0]?.reason).toMatch(/idle for 1000 ms/);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.closes).toHaveLength(1);
  });

  it("fails before it accepts a socket when the connectionOptions hook throws", async () => {
    const server = fakeServer();
    const host: EngineHost = {
      connectionOptions: () => {
        throw new Error("host hook failed");
      },
    };
    await expect(
      handleWebSocket(
        new Request("https://x/devtools/browser"),
        {} as Env,
        createExecutionContext(),
        undefined,
        { host },
      ),
    ).rejects.toThrow("host hook failed");
    expect(server.accepted).toBe(0);
  });
});
