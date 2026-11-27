// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserSession,
  parseConnectionParams,
  type ClientConnection,
  type ClientOptions,
  type ConnectionParams,
} from "../src/cdp/connection.ts";
import type { SessionContext } from "../src/cdp/dispatch.ts";
import { makeChildFrameState } from "../src/cdp/frames.ts";
import {
  drainInterception,
  ensureInterception,
  registerParked,
} from "../src/cdp/fetch-interception.ts";
import { liveExtraHeaders } from "../src/cdp/extra-headers-registry.ts";
import { liveExtraHeadersTarget } from "../src/cdp/network.ts";

type Message = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: unknown;
  sessionId?: string;
};

interface TestClient {
  conn: ClientConnection;
  socket: WebSocket;
  inbox: Message[];
  closed: Promise<CloseEvent>;
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Message>;
  events(method: string): Message[];
}

const WAIT = { timeout: 3_000, interval: 10 };

const sessionCtx: SessionContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  exports: {} as SessionContext["exports"],
  props: {},
};

function params(query = ""): ConnectionParams {
  return parseConnectionParams(new Request(`http://engine.test/devtools/browser${query}`));
}

function openSession(opts: { persistent: boolean }): BrowserSession {
  const request = new Request("http://engine.test/devtools/browser");
  return new BrowserSession(request, {} as Env, sessionCtx, params(), opts);
}

function connect(session: BrowserSession, p = params(), opts?: ClientOptions): TestClient {
  const [socket, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  server.accept();
  socket.accept();
  const inbox: Message[] = [];
  socket.addEventListener("message", (e) => {
    inbox.push(JSON.parse(e.data as string) as Message);
  });
  const closed = new Promise<CloseEvent>((resolve) => {
    socket.addEventListener("close", (e) => resolve(e));
  });
  const conn = session.attachClient(server, p, opts);
  let nextId = 1;
  return {
    conn,
    socket,
    inbox,
    closed,
    async send(method, cmdParams, sessionId) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params: cmdParams ?? {}, sessionId }));
      return vi.waitFor(() => {
        const reply = inbox.find((m) => m.id === id);
        if (!reply) throw new Error(`no reply to ${method}`);
        return reply;
      }, WAIT);
    },
    events(method) {
      return inbox.filter((m) => m.method === method);
    },
  };
}

async function autoAttach(client: TestClient): Promise<string> {
  await client.send("Target.setAutoAttach", { autoAttach: true, flatten: true });
  const attached = client.events("Target.attachedToTarget").at(-1);
  const sessionId = attached?.params?.sessionId;
  if (typeof sessionId !== "string") throw new Error("no attachedToTarget");
  return sessionId;
}

function pageTarget(session: BrowserSession) {
  const page = Array.from(session.browser.targets.values()).find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  return page;
}

// A child frame that exists before the test's clients ask for it, as one a page already loaded.
function addChildFrame(session: BrowserSession, frameId = "child-1") {
  const page = pageTarget(session);
  const frame = makeChildFrameState({
    frameId,
    parentFrameId: page.frameId,
    loaderId: `${frameId}-loader`,
    url: "https://child.test/",
    name: "",
    ownerElementId: `${frameId}-owner`,
    ownerBackendNodeId: 1,
    isCrossOrigin: true,
    delaysLoadEvent: false,
  });
  page.frames.set(frameId, frame);
  return frame;
}

let current: BrowserSession | null = null;

afterEach(() => {
  current?.dispose({ endReason: "close", closeCode: 1000, wasClean: 1 });
  current = null;
});

describe("BrowserSession", () => {
  it("announces the existing page to each client", async () => {
    const session = (current = openSession({ persistent: true }));
    const a = connect(session);
    const b = connect(session);
    const pageId = pageTarget(session).targetId;
    for (const client of [a, b]) {
      await vi.waitFor(() => expect(client.events("Target.targetCreated")).toHaveLength(1), WAIT);
      const info = client.events("Target.targetCreated")[0]?.params?.targetInfo;
      expect(info).toMatchObject({ targetId: pageId, type: "page", attached: false });
    }
  });

  it("routes a session event to its owner and a root event to every client", async () => {
    const session = (current = openSession({ persistent: true }));
    const a = connect(session);
    const b = connect(session);
    const sessionA = await autoAttach(a);

    session.route({ method: "Runtime.executionContextsCleared", sessionId: sessionA });
    session.route({ method: "Inspector.detached", params: { reason: "test" } });
    // Each reply comes after every event routed to that socket before it.
    await a.send("Target.getTargets");
    await b.send("Target.getTargets");

    expect(a.events("Runtime.executionContextsCleared")).toHaveLength(1);
    expect(b.events("Runtime.executionContextsCleared")).toHaveLength(0);
    expect(b.events("Target.attachedToTarget")).toHaveLength(0);
    expect(a.events("Inspector.detached")).toHaveLength(1);
    expect(b.events("Inspector.detached")).toHaveLength(1);
  });

  it("keeps Target.setAutoAttach per client", async () => {
    const session = (current = openSession({ persistent: true }));
    const a = connect(session);
    const b = connect(session);
    const sessionA = await autoAttach(a);
    expect(a.conn.state.autoAttach).toBe(true);
    expect(b.conn.state.autoAttach).toBe(false);

    const sessionB = await autoAttach(b);
    expect(sessionB).not.toBe(sessionA);
    expect(a.events("Target.attachedToTarget")).toHaveLength(1);
    expect(Array.from(pageTarget(session).sessions)).toEqual([sessionA, sessionB]);
  });

  it("detaches a leaving client's sessions and scripts, and the other keeps working", async () => {
    let remaining = -1;
    const request = new Request("http://engine.test/devtools/browser");
    const session = (current = new BrowserSession(request, {} as Env, sessionCtx, params(), {
      persistent: true,
      onClientLeft: (n) => (remaining = n),
    }));
    const a = connect(session);
    const b = connect(session);
    const sessionA = await autoAttach(a);
    const sessionB = await autoAttach(b);
    const scriptA = await a.send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: "1" },
      sessionA,
    );
    const scriptB = await b.send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: "2" },
      sessionB,
    );
    expect(session.browser.preNavScripts.size).toBe(2);

    a.socket.close(1000, "done");
    await vi.waitFor(() => expect(remaining).toBe(1), WAIT);

    expect(session.disposed).toBe(false);
    expect(Array.from(pageTarget(session).sessions)).toEqual([sessionB]);
    expect(Array.from(session.browser.preNavScripts.keys())).toEqual([scriptB.result?.identifier]);
    expect(session.browser.preNavScripts.has(String(scriptA.result?.identifier))).toBe(false);

    const reply = await b.send("Target.getTargetInfo", {}, sessionB);
    expect(reply.error).toBeUndefined();
    session.route({ method: "Runtime.executionContextsCleared", sessionId: sessionB });
    await vi.waitFor(
      () => expect(b.events("Runtime.executionContextsCleared")).toHaveLength(1),
      WAIT,
    );
  });

  it("clears the overrides a leaving client set and keeps the other client's", async () => {
    let remaining = -1;
    const request = new Request("http://engine.test/devtools/browser");
    const session = (current = new BrowserSession(request, {} as Env, sessionCtx, params(), {
      persistent: true,
      onClientLeft: (n) => (remaining = n),
    }));
    const a = connect(session);
    const b = connect(session);
    const sessionA = await autoAttach(a);
    const sessionB = await autoAttach(b);
    await a.send("Network.setExtraHTTPHeaders", { headers: { Authorization: "a" } }, sessionA);
    await a.send("Emulation.setEmulatedMedia", { media: "print" }, sessionA);
    await a.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 300 }, sessionA);
    await b.send("Emulation.setUserAgentOverride", { userAgent: "ua-b" }, sessionB);

    a.socket.close(1000, "done");
    await vi.waitFor(() => expect(remaining).toBe(1), WAIT);

    const page = pageTarget(session);
    expect(page.extraHttpHeaders).toEqual({});
    expect(page.emulatedMedia).toBe("screen");
    expect([page.viewportWidth, page.viewportHeight, page.deviceScaleFactor]).toEqual([
      null,
      null,
      1,
    ]);
    expect(page.userAgentOverride).toBe("ua-b");
  });

  it("gives back the newest remaining client's override when its writer leaves", async () => {
    let remaining = -1;
    const request = new Request("http://engine.test/devtools/browser");
    const session = (current = new BrowserSession(request, {} as Env, sessionCtx, params(), {
      persistent: true,
      onClientLeft: (n) => (remaining = n),
    }));
    const a = connect(session);
    const b = connect(session);
    const c = connect(session);
    const sessionA = await autoAttach(a);
    const sessionB = await autoAttach(b);
    const sessionC = await autoAttach(c);
    await a.send("Network.setExtraHTTPHeaders", { headers: { Authorization: "a" } }, sessionA);
    await a.send("Emulation.setEmulatedMedia", { media: "print" }, sessionA);
    await b.send("Network.setExtraHTTPHeaders", { headers: { Authorization: "b" } }, sessionB);
    await b.send("Emulation.setEmulatedMedia", { media: "screen" }, sessionB);
    await c.send("Network.setExtraHTTPHeaders", { headers: { Authorization: "c" } }, sessionC);

    const page = pageTarget(session);
    const liveId = liveExtraHeadersTarget(session.id, page);
    b.socket.close(1000, "done");
    await vi.waitFor(() => expect(remaining).toBe(2), WAIT);
    expect(page.extraHttpHeaders).toEqual({ Authorization: "c" });
    expect(page.emulatedMedia).toBe("print");

    c.socket.close(1000, "done");
    await vi.waitFor(() => expect(remaining).toBe(1), WAIT);
    expect(page.extraHttpHeaders).toEqual({ Authorization: "a" });
    expect(liveExtraHeaders(session.id, liveId)).toEqual({ Authorization: "a" });
  });

  it("gives back the viewport a leaving client's screencast set", async () => {
    let remaining = -1;
    const request = new Request("http://engine.test/devtools/browser");
    const session = (current = new BrowserSession(request, {} as Env, sessionCtx, params(), {
      persistent: true,
      onClientLeft: (n) => (remaining = n),
    }));
    const a = connect(session);
    const b = connect(session);
    const sessionA = await autoAttach(a);
    const sessionB = await autoAttach(b);
    await a.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 300 }, sessionA);
    await b.send("Page.startScreencast", { maxWidth: 640, maxHeight: 480 }, sessionB);
    const page = pageTarget(session);
    expect([page.viewportWidth, page.viewportHeight]).toEqual([640, 480]);

    b.socket.close(1000, "done");
    await vi.waitFor(() => expect(remaining).toBe(1), WAIT);
    expect(session.browser.screencasts.size).toBe(0);
    expect([page.viewportWidth, page.viewportHeight]).toEqual([400, 300]);
  });

  it("keeps Fetch interception to its owner and hands it over", async () => {
    let remaining = -1;
    const request = new Request("http://engine.test/devtools/browser");
    const session = (current = new BrowserSession(request, {} as Env, sessionCtx, params(), {
      persistent: true,
      onClientLeft: (n) => (remaining = n),
    }));
    const a = connect(session);
    const b = connect(session);
    connect(session);
    await a.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    const st = ensureInterception(session.id);
    const pause = () =>
      registerParked(st, {
        url: "https://ks.invalid/",
        method: "GET",
        headers: {},
        resourceType: "Document",
        frameId: "frame",
        networkId: "net",
      });
    const first = pause();
    drainInterception(session.id);
    await vi.waitFor(() => expect(a.events("Fetch.requestPaused")).toHaveLength(1), WAIT);
    await b.send("Target.getTargets");
    expect(b.events("Fetch.requestPaused")).toHaveLength(0);

    const foreign = await b.send("Fetch.continueRequest", { requestId: first.interceptionId });
    expect(foreign.error).toBeDefined();
    await b.send("Fetch.disable");
    expect(first.verdict).toBeUndefined();
    expect(st.ownerClientId).toBe(a.conn.state.id);

    await b.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    expect(first.verdict).toEqual({ kind: "continue" });
    const late = await a.send("Fetch.continueRequest", { requestId: first.interceptionId });
    expect(late.error).toBeDefined();

    const second = pause();
    b.socket.close(1000, "done");
    await vi.waitFor(() => expect(remaining).toBe(2), WAIT);
    expect(second.verdict).toEqual({ kind: "continue" });
    expect(st.ownerClientId).toBeNull();
    expect(st.patterns).toEqual([]);
  });

  it("tells a late browser-mode client of the existing child frames and attaches it", async () => {
    const session = (current = openSession({ persistent: true }));
    const a = connect(session);
    await vi.waitFor(() => expect(a.events("Target.targetCreated")).toHaveLength(1), WAIT);
    const frame = addChildFrame(session);

    const late = connect(session);
    await vi.waitFor(() => expect(late.events("Target.targetCreated")).toHaveLength(2), WAIT);
    const infos = late.events("Target.targetCreated").map((m) => m.params?.targetInfo);
    expect(infos).toContainEqual(
      expect.objectContaining({ targetId: frame.frameId, type: "iframe" }),
    );

    await late.send("Target.setAutoAttach", { autoAttach: true, flatten: true });
    const attached = late
      .events("Target.attachedToTarget")
      .map((m) => (m.params?.targetInfo as { targetId?: string } | undefined)?.targetId);
    expect(attached).toContain(frame.frameId);
    expect(frame.sessions.size).toBe(1);
    expect(late.conn.state.sessions.has(Array.from(frame.sessions)[0] ?? "")).toBe(true);
  });

  it("drops another client's child-frame sessions when a page closes", async () => {
    const session = (current = openSession({ persistent: true }));
    const a = connect(session);
    const b = connect(session);
    await vi.waitFor(() => expect(b.events("Target.targetCreated")).toHaveLength(1), WAIT);
    const frame = addChildFrame(session);
    await b.send("Target.setAutoAttach", { autoAttach: true, flatten: true });
    const frameSession = Array.from(frame.sessions)[0] ?? "";
    expect(b.conn.state.sessions.has(frameSession)).toBe(true);

    const reply = await a.send("Target.closeTarget", { targetId: pageTarget(session).targetId });
    expect(reply.error).toBeUndefined();
    expect(b.conn.state.sessions.has(frameSession)).toBe(false);
  });

  it("closes an idle client without ending the session", async () => {
    const session = (current = openSession({ persistent: true }));
    const idle = connect(session, params("?ksIdleMs=300"));
    const busy = connect(session, params("?ksIdleMs=300"), { exemptIdleDeadline: true });

    const close = await idle.closed;
    expect(close.code).toBe(1001);
    expect(close.reason).toContain("idle for 300 ms");
    expect(session.disposed).toBe(false);
    expect(session.clientCount).toBe(1);

    const reply = await busy.send("Target.getTargets");
    expect(reply.error).toBeUndefined();
  });

  it("ends a non-persistent session with its client", async () => {
    const session = (current = openSession({ persistent: false }));
    const only = connect(session);
    await vi.waitFor(() => expect(only.events("Target.targetCreated")).toHaveLength(1), WAIT);

    only.socket.close(1000, "done");
    await vi.waitFor(() => expect(session.disposed).toBe(true), WAIT);
    expect(session.browser.wsClosing).toBe(true);
  });
});
