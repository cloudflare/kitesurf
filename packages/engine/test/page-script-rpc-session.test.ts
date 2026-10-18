// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, it, expect, vi } from "vitest";
import type { RenderPortStub } from "@kitesurf/jsrpc-types/page-renderer";
import type { PageScriptMethod, WireMeta } from "@kitesurf/jsrpc-types/page-script";
import {
  openPageScriptRpcSession,
  type RpcSessionCallable,
  type RpcSessionEntrypoint,
} from "../src/eval/page-script-rpc-session.ts";
import {
  registerIsolateLimitListener,
  type IsolateLimitNotice,
} from "../src/eval/limit-registry.ts";

function makeFake(
  opts: {
    onCall?: (method: PageScriptMethod, params: object, meta: WireMeta) => Promise<unknown>;
    onClose?: () => Promise<void>;
    mintRenderPort?: () => Promise<RenderPortStub>;
  } = {},
) {
  const calls: Array<{ method: PageScriptMethod; params: object; meta: WireMeta }> = [];
  let disposed = 0;
  let opened = 0;
  let portsDisposed = 0;
  let portsMinted = 0;
  let upstream: ((e: { event: string; params: Record<string, unknown> }) => void) | null = null;
  const session: Omit<RpcSessionCallable, "close"> & Partial<Pick<RpcSessionCallable, "close">> = {
    call: ((method: PageScriptMethod, params: object, meta: WireMeta) => {
      calls.push({ method, params, meta });
      return opts.onCall
        ? opts.onCall(method, params, meta)
        : Promise.resolve({ ok: true, method });
    }) as RpcSessionCallable["call"],
    async makeRenderPort() {
      portsMinted += 1;
      return opts.mintRenderPort ? opts.mintRenderPort() : makePort();
    },
    [Symbol.dispose]() {
      disposed += 1;
    },
  };
  if (opts.onClose) session.close = opts.onClose;
  const makePort = () =>
    ({
      [Symbol.dispose]() {
        portsDisposed += 1;
      },
    }) as RenderPortStub;
  const entrypoint: RpcSessionEntrypoint = {
    async openSession(init) {
      opened += 1;
      upstream = init.upstream as (e: { event: string; params: Record<string, unknown> }) => void;
      return session as RpcSessionCallable;
    },
  };
  return {
    entrypoint,
    calls,
    makePort,
    get disposed() {
      return disposed;
    },
    get opened() {
      return opened;
    },
    get portsDisposed() {
      return portsDisposed;
    },
    get portsMinted() {
      return portsMinted;
    },
    fireUpstream(event: string, params: Record<string, unknown>) {
      upstream?.({ event, params });
    },
  };
}

describe("PageScriptRpcSession", () => {
  it("opens lazily once and stamps wire meta on every call", async () => {
    const fake = makeFake();
    const s = openPageScriptRpcSession(fake.entrypoint, {
      now: () => 12345,
      getTraceParent: () => "span-1",
    });
    await s.queryDom("getRect", { nodeId: 3 });
    await s.syncCookies("a=b");
    expect(fake.opened).toBe(1);
    expect(fake.calls[0]).toEqual({
      method: "queryDom",
      params: { method: "getRect", args: { nodeId: 3 } },
      meta: { t: 12345, tp: "span-1" },
    });
    expect(fake.calls[1]?.method).toBe("syncCookies");
  });

  it("prefixes child errors with the method name (WS parity)", async () => {
    const fake = makeFake({
      onCall: async () => {
        throw new Error("no document loaded");
      },
    });
    const s = openPageScriptRpcSession(fake.entrypoint);
    await expect(s.queryDom("getDocument", {})).rejects.toThrow(
      /^PageScript\.queryDom: no document loaded/,
    );
  });

  it("times out a hung call without wedging the session", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFake({
        onCall: () => new Promise(() => {}),
      });
      const s = openPageScriptRpcSession(fake.entrypoint, { defaultTimeoutMs: 50 });
      const p = s.drainConsole();
      const expectation = expect(p).rejects.toThrow(/PageScript\.drainConsole: timeout after 50ms/);
      await vi.advanceTimersByTimeAsync(60);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("close() disposes the session stub and kills later + in-flight calls", async () => {
    const fake = makeFake({
      onCall: (method) => (method === "evaluate" ? new Promise(() => {}) : Promise.resolve({})),
    });
    const s = openPageScriptRpcSession(fake.entrypoint);
    await s.syncCookies("warm=up");
    const inflight = s.evaluate("1+1", {});
    const expectation = expect(inflight).rejects.toThrow(
      /PageScript\.evaluate: session ended \(generation bump\)/,
    );
    s.close("generation bump");
    await expectation;
    expect(fake.disposed).toBe(1);
    await expect(s.queryDom("getDocument", {})).rejects.toThrow(
      /session is dead \(generation bump\)/,
    );
  });

  it("acknowledges session close before disposing and killing the isolate", async () => {
    vi.useFakeTimers();
    try {
      let releaseClose = () => {};
      let killed = false;
      const fake = makeFake({
        onClose: () => new Promise<void>((resolve) => (releaseClose = resolve)),
      });
      fake.entrypoint.killIsolate = async () => {
        killed = true;
      };
      const s = openPageScriptRpcSession(fake.entrypoint);
      await s.syncCookies("warm=up");

      s.close("generation bump");
      const killing = s.killIsolate?.("generation bump");
      expect(fake.disposed).toBe(0);
      expect(killed).toBe(false);

      releaseClose();
      await vi.advanceTimersByTimeAsync(0);
      await killing;
      expect(fake.disposed).toBe(1);
      expect(killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("acknowledges session close when close races session creation", async () => {
    let resolveOpen = (_session: RpcSessionCallable) => {};
    let closed = false;
    let disposed = false;
    let killed = false;
    const session: RpcSessionCallable = {
      call: (async () => ({})) as RpcSessionCallable["call"],
      makeRenderPort: async () => ({}) as RenderPortStub,
      close: async () => {
        closed = true;
      },
      [Symbol.dispose]() {
        disposed = true;
      },
    };
    const entrypoint: RpcSessionEntrypoint = {
      openSession: () => new Promise<RpcSessionCallable>((resolve) => (resolveOpen = resolve)),
      killIsolate: async () => {
        killed = true;
      },
    };
    const s = openPageScriptRpcSession(entrypoint);

    s.close("generation bump");
    const killing = s.killIsolate?.("generation bump");
    expect(killed).toBe(false);

    resolveOpen(session);
    await killing;
    expect(closed).toBe(true);
    expect(disposed).toBe(true);
    expect(killed).toBe(true);
  });

  it("bounds hung close and kill RPCs", async () => {
    vi.useFakeTimers();
    try {
      let killed = false;
      const fake = makeFake({ onClose: () => new Promise(() => {}) });
      fake.entrypoint.killIsolate = () => {
        killed = true;
        return new Promise(() => {});
      };
      const s = openPageScriptRpcSession(fake.entrypoint);
      await s.syncCookies("warm=up");

      s.close("generation bump");
      const killing = s.killIsolate?.("generation bump");
      let settled = false;
      void killing?.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(999);
      expect(killed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(killed).toBe(true);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes upstream events through the registered handler", async () => {
    const fake = makeFake();
    const s = openPageScriptRpcSession(fake.entrypoint);
    await s.syncCookies("warm=up");
    const seen: Array<[string, unknown]> = [];
    s.setUpstreamEventHandler((event, params) => seen.push([event, params]));
    fake.fireUpstream("kitesurf.frameAttached", { frameId: "f1" });
    s.setUpstreamEventHandler(null);
    fake.fireUpstream("kitesurf.frameAttached", { frameId: "f2" });
    expect(seen).toEqual([["kitesurf.frameAttached", { frameId: "f1" }]]);
  });

  it("unload replies first, then closes on the next macrotask", async () => {
    const fake = makeFake({
      onCall: async () => ({ ok: true as const }),
    });
    const s = openPageScriptRpcSession(fake.entrypoint);
    const r = await s.unload();
    expect(r.ok).toBe(true);
    expect(fake.disposed).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.disposed).toBe(1);
  });

  it("wall cap kills the isolate, disposes, and rejects everything", async () => {
    vi.useFakeTimers();
    try {
      let killed: string | null = null;
      const fake = makeFake({ onCall: () => new Promise(() => {}) });
      (fake.entrypoint as { killIsolate?: (r?: string) => Promise<unknown> }).killIsolate = async (
        r,
      ) => {
        killed = r ?? null;
        return {};
      };
      const s = openPageScriptRpcSession(fake.entrypoint, { wallCapMs: 100 });
      const inflight = s.evaluate("while(1){}", {});
      const expectation = expect(inflight).rejects.toThrow(/wall-clock cap exceeded/);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(150);
      await expectation;
      expect(killed).toMatch(/wall-clock cap/);
      expect(fake.disposed).toBe(1);
      await expect(s.queryDom("getDocument", {})).rejects.toThrow(/session is dead/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a destroyed execution context ends the session, not just the call", async () => {
    const notices: IsolateLimitNotice[] = [];
    const scriptName = `ks-test-gone-${Math.random().toString(36).slice(2)}`;
    registerIsolateLimitListener(scriptName, (n) => notices.push(n));
    const fake = makeFake({
      onCall: () =>
        Promise.reject(
          new Error("The execution context which hosts this callback is no longer running."),
        ),
    });
    const s = openPageScriptRpcSession(fake.entrypoint, { scriptName });

    await expect(s.queryDom("getDocument", {})).rejects.toThrow(
      /execution context which hosts this/,
    );
    const callsAfterDeath = fake.calls.length;

    await expect(s.evaluate("1+1", {})).rejects.toThrow(
      /session is dead \(page isolate no longer reachable/,
    );
    await expect(s.queryDom("getDocument", {})).rejects.toThrow(/session is dead/);
    expect(fake.calls.length, "no further calls reach the dead peer").toBe(callsAfterDeath);

    expect(notices.map((n) => n.kind)).toEqual(["gone"]);
  });

  it("a teardown of an already-gone isolate reports no crash", async () => {
    const notices: IsolateLimitNotice[] = [];
    const scriptName = `ks-test-retire-${Math.random().toString(36).slice(2)}`;
    registerIsolateLimitListener(scriptName, (n) => notices.push(n));
    const fake = makeFake({
      onCall: () =>
        Promise.reject(
          new Error("The execution context which hosts this callback is no longer running."),
        ),
    });
    const s = openPageScriptRpcSession(fake.entrypoint, { scriptName });

    await expect(s.unload()).rejects.toThrow(/execution context which hosts this/);
    expect(notices, "teardown is not a crash").toHaveLength(0);
    expect(fake.disposed, "transport death releases the session stub").toBe(1);
    await expect(s.evaluate("1+1", {})).rejects.toThrow(/session is dead/);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.disposed, "scheduled close does not dispose twice").toBe(1);
  });

  it("an ordinary page error does not end the session", async () => {
    const notices: IsolateLimitNotice[] = [];
    const scriptName = `ks-test-live-${Math.random().toString(36).slice(2)}`;
    registerIsolateLimitListener(scriptName, (n) => notices.push(n));
    let fail = true;
    const fake = makeFake({
      onCall: async () => {
        if (fail) throw new Error("TypeError: x is not a function");
        return { ok: true };
      },
    });
    const s = openPageScriptRpcSession(fake.entrypoint, { scriptName });

    await expect(s.evaluate("x()", {})).rejects.toThrow(/x is not a function/);
    fail = false;
    const before = fake.calls.length;
    await expect(s.evaluate("1+1", {})).resolves.toBeTruthy();
    expect(fake.calls.length, "the next call still reaches the peer").toBe(before + 1);
    expect(notices, "a page error is not an isolate death").toHaveLength(0);
  });

  it("armAwaitLoad and awaitLoad share one in-flight call", async () => {
    const fake = makeFake({ onCall: async () => ({ ok: true }) });
    const s = openPageScriptRpcSession(fake.entrypoint);
    s.armAwaitLoad?.();
    await s.awaitLoad();
    await s.awaitLoad();
    expect(fake.calls.filter((c) => c.method === "awaitLoad")).toHaveLength(1);
  });

  it("close() disposes the render port it minted, once", async () => {
    const fake = makeFake();
    const s = openPageScriptRpcSession(fake.entrypoint);
    const port = await s.getRenderPort();
    expect(await s.getRenderPort()).toBe(port);
    expect(fake.portsMinted).toBe(1);
    expect(fake.portsDisposed).toBe(0);
    s.close("generation bump");
    expect(fake.portsDisposed).toBe(1);
    s.close("again");
    expect(fake.portsDisposed).toBe(1);
    await expect(s.getRenderPort()).rejects.toThrow(/session is dead \(generation bump\)/);
  });

  it("a render port that lands after close() is disposed, not leaked", async () => {
    let resolveMint: ((port: RenderPortStub) => void) | null = null;
    const fake = makeFake({
      mintRenderPort: () =>
        new Promise((resolve) => {
          resolveMint = resolve;
        }),
    });
    const s = openPageScriptRpcSession(fake.entrypoint);
    const minted = s.getRenderPort();
    const expectation = expect(minted).rejects.toThrow(/session is dead \(generation bump\)/);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolveMint).not.toBeNull();
    s.close("generation bump");
    resolveMint!(fake.makePort());
    await expectation;
    expect(fake.portsDisposed).toBe(1);
  });
});
