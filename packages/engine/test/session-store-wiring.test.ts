// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The engine keeps a session's data in the store the host supplies, sizes it by the limits that
// store declares, and writes back what it changes, so a backend that hands out copies works.

import { createExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleWebSocket } from "../src/cdp/connection.ts";
import { makeCompiledScriptMeta } from "../src/cdp/debugger.ts";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import { NetworkEventTracker, isolateRetainedBodyBytesTotal } from "../src/cdp/network-events.ts";
import type { CdpEvent, CdpRequest, CdpResponse } from "../src/cdp/types.ts";
import {
  dropConnectionImages,
  dropTargetImages,
  getImageBytes,
  imageStoreStats,
  putAuthorFont,
  putOpaqueImage,
  registerResourceStore,
} from "../src/eval/resource-store.ts";
import type { EngineHost } from "../src/host.ts";
import { JsonSessionStore } from "./json-session-store.ts";

const live: NetworkEventTracker[] = [];

afterEach(() => {
  for (const t of live.splice(0)) t.dispose();
  vi.unstubAllGlobals();
});

function tracker(store: JsonSessionStore, events: CdpEvent[] = []): NetworkEventTracker {
  const t = new NetworkEventTracker((ev) => events.push(ev), "conn-store", store);
  live.push(t);
  return t;
}

function request(
  t: NetworkEventTracker,
  body: string,
  sessionIds?: Array<string | undefined>,
): string {
  const url = `https://example.test/${crypto.randomUUID()}`;
  const id = t.beginRequest({
    url,
    method: "GET",
    headers: {},
    type: "XHR",
    initiator: { type: "other" },
    loaderId: "loader-1",
    frameId: "frame-1",
    sessionIds,
  });
  t.completeRequest(id, {
    url,
    status: 200,
    statusText: "OK",
    headers: {},
    mimeType: "application/json",
    bodyLength: body.length,
    body,
  });
  return id;
}

describe("the network log in a session store", () => {
  it("keeps records and bodies in the store, up to the requests the store allows", () => {
    const store = new JsonSessionStore({ networkRequests: 2 });
    const t = tracker(store);
    t.setEnabled(undefined, true);
    const ids = [request(t, "one"), request(t, "two"), request(t, "three")];

    expect(t.retainedRequestCount()).toBe(2);
    expect(Array.from(store.rows("network.requests").keys())).toEqual(ids.slice(1));
    expect(Array.from(store.rows("network.bodies").keys())).toEqual(ids.slice(1));
    expect(t.getResponseBody(ids[0] ?? "")).toBeNull();
    expect(t.getResponseBody(ids[2] ?? "")).toEqual({ body: "three", base64Encoded: false });
  });

  it("clamps what Network.enable asks for to the store's body limits", () => {
    const store = new JsonSessionStore({
      networkBodyBytes: 1_000,
      networkBodyBytesPerResource: 100,
    });
    const t = tracker(store);
    t.setEnabled(undefined, true, { maxTotalBufferSize: 1e9, maxResourceBufferSize: 1e9 });
    expect(t.perBodyBudget()).toBe(100);

    // Two bytes per UTF-16 code unit: 50 units fit the per-body limit, 51 do not.
    const fits = request(t, "a".repeat(50));
    const over = request(t, "a".repeat(51));
    expect(t.getResponseBody(fits)?.body).toHaveLength(50);
    expect(t.getResponseBody(over)).toBeNull();
  });

  it("does not charge a store off the heap against the isolate's body budget", () => {
    const before = isolateRetainedBodyBytesTotal();
    const off = tracker(new JsonSessionStore());
    off.setEnabled(undefined, true);
    request(off, "a".repeat(1_000));
    expect(isolateRetainedBodyBytesTotal()).toBe(before);
    expect(off.retainedBodyBytes()).toBe(0);

    const on = tracker(new JsonSessionStore({ onHeap: true }));
    on.setEnabled(undefined, true);
    request(on, "a".repeat(1_000));
    expect(isolateRetainedBodyBytesTotal()).toBe(before + 2_000);
    expect(on.retainedBodyBytes()).toBe(2_000);
  });

  it("writes a changed record back, so a request completes once", () => {
    const t = tracker(new JsonSessionStore());
    const id = request(t, "{}");
    expect(t.getInFlight()).toBe(0);
    t.failRequest(id, "net::ERR_ABORTED");
    expect(t.getInFlight()).toBe(0);
  });

  it("sends a root-session event without a session id after the record round-trips", () => {
    const events: CdpEvent[] = [];
    const t = tracker(new JsonSessionStore(), events);
    t.setEnabled(undefined, true);
    t.setEnabled("s1", true);
    request(t, "{}", [undefined, "s1"]);
    t.drain();

    const responses = events.filter((e) => e.method === "Network.responseReceived");
    expect(responses.map((e) => e.sessionId)).toEqual([undefined, "s1"]);
    expect(responses.some((e) => e.sessionId === null)).toBe(false);
  });
});

describe("withheld images and fonts in a session store", () => {
  const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);

  it("go to a store off the heap, under the image and font limits it declares", () => {
    const store = new JsonSessionStore({ imageBytes: 10, fontBytes: 4 });
    const conn = `conn-${crypto.randomUUID()}`;
    registerResourceStore(conn, store);
    const heapBefore = imageStoreStats();
    try {
      const first = putOpaqueImage(bytes(4, 1), conn, "t1");
      const second = putOpaqueImage(bytes(4, 2), conn, "t2");
      expect(first).not.toBeNull();
      expect(store.rows("resources").size).toBe(2);
      expect(imageStoreStats()).toEqual(heapBefore);
      expect(getImageBytes(first ?? 0n, conn)).toEqual(bytes(4, 1));
      expect(getImageBytes(first ?? 0n, "another-connection")).toBeNull();

      // Past the limit the least recently read goes: `second`, since `first` was just read.
      putOpaqueImage(bytes(4, 3), conn, "t1");
      expect(getImageBytes(second ?? 0n, conn)).toBeNull();
      expect(putAuthorFont(bytes(5), conn, "t1")).toBeNull();

      dropTargetImages(conn, "t1");
      expect(store.rows("resources").size).toBe(0);
    } finally {
      dropConnectionImages(conn);
    }
  });

  it("stay in the isolate's caches when the store is on the heap", () => {
    const store = new JsonSessionStore({ onHeap: true });
    const conn = `conn-${crypto.randomUUID()}`;
    registerResourceStore(conn, store);
    try {
      const key = putOpaqueImage(bytes(4), conn, "t1");
      expect(store.rows("resources").size).toBe(0);
      expect(getImageBytes(key ?? 0n, conn)).toEqual(bytes(4));
    } finally {
      dropConnectionImages(conn);
    }
  });
});

describe("a browser session with a host store", () => {
  async function open(store: JsonSessionStore) {
    let seen: DispatchCtx | undefined;
    let send: ((req: CdpRequest) => Promise<CdpResponse>) | undefined;
    const host: EngineHost = { createSessionStore: () => store };
    const r = await handleWebSocket(
      new Request("https://x/devtools/browser"),
      {} as Env,
      createExecutionContext(),
      (dctx: DispatchCtx) => {
        seen = dctx;
      },
      { host, onDispatch: (d) => (send = d) },
    );
    if (!seen || !send) throw new Error("no session");
    const dispatch = send;
    let id = 0;
    const call = async (method: string, params: Record<string, unknown> = {}) => {
      const res = await dispatch({ id: ++id, method, params } as CdpRequest);
      if ("error" in res) throw new Error(JSON.stringify(res.error));
      return res.result as Record<string, unknown>;
    };
    const close = () => {
      r.webSocket?.accept();
      r.webSocket?.close(1000, "done");
    };
    return { browser: seen.browser, connectionId: seen.connectionId, call, close };
  }

  it("keeps its data in the store the host creates", async () => {
    const store = new JsonSessionStore();
    const { browser, close } = await open(store);
    expect(browser.store).toBe(store);
    close();
  });

  it("keeps cookies, new-document scripts and style text in the store", async () => {
    const store = new JsonSessionStore();
    const { browser, call, close } = await open(store);

    await call("Network.setCookie", { name: "a", value: "1", url: "https://a.test/" });
    expect(Array.from(store.rows("cookies").keys())).toEqual(["a.test"]);
    expect(browser.cookies.cookieHeaderForUrl("https://a.test/")).toBe("a=1");
    // The jar reads a copy, changes it and writes it back.
    await call("Network.setCookie", { name: "a", value: "2", url: "https://a.test/" });
    expect(browser.cookies.cookieHeaderForUrl("https://a.test/")).toBe("a=2");

    await call("Page.addScriptToEvaluateOnNewDocument", { source: "window.x = 1" });
    expect(Array.from(store.rows("preNavScripts").values())).toEqual(["window.x = 1"]);

    browser.styleCache.set("https://a.test/s.css", { css: "p{}", fetchedAt: 1 });
    expect(store.rows("styleCache").get("https://a.test/s.css")).toEqual({
      css: "p{}",
      fetchedAt: 1,
    });
    expect(browser.styleCache.get("https://a.test/s.css")?.css).toBe("p{}");
    close();
  });

  it("keeps withheld images in a store off the heap", async () => {
    const store = new JsonSessionStore();
    const { connectionId, close } = await open(store);
    const key = putOpaqueImage(new Uint8Array([1, 2, 3]), connectionId, "t1");
    expect(store.rows("resources").size).toBe(1);
    expect(getImageBytes(key ?? 0n, connectionId)).toEqual(new Uint8Array([1, 2, 3]));
    close();
  });

  it("gives each browser context a cookie table and drops it with the context", async () => {
    const store = new JsonSessionStore();
    const { call, close } = await open(store);
    const { browserContextId } = await call("Target.createBrowserContext");
    await call("Storage.setCookies", {
      browserContextId,
      cookies: [{ name: "b", value: "2", domain: "b.test", path: "/" }],
    });
    expect(store.tableNames()).toContain(`cookies:${String(browserContextId)}`);

    await call("Target.disposeBrowserContext", { browserContextId });
    expect(store.tableNames()).not.toContain(`cookies:${String(browserContextId)}`);
    close();
  });

  it("keeps a page's document and compiled scripts in the store until the page closes", async () => {
    const store = new JsonSessionStore();
    const { browser, call, close } = await open(store);
    const page = Array.from(browser.targets.values()).find((t) => t.type === "page");
    if (!page) throw new Error("no page");

    page.html = "<p>stored</p>";
    page.compiledScripts.set("s1", makeCompiledScriptMeta("s1", "1 + 1", "", { source: "1 + 1" }));
    expect(store.rows("documents").get(page.targetId)).toBe("<p>stored</p>");
    expect(page.html).toBe("<p>stored</p>");
    expect(store.rows(`compiledScripts:${page.targetId}`).has("s1")).toBe(true);

    await call("Target.closeTarget", { targetId: page.targetId });
    expect(store.rows("documents").has(page.targetId)).toBe(false);
    expect(store.tableNames()).not.toContain(`compiledScripts:${page.targetId}`);
    // A navigate that ends after the close does not bring the row back.
    page.html = "<p>late</p>";
    expect(store.rows("documents").has(page.targetId)).toBe(false);
    close();
  });
});
