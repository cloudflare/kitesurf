// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { createExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleWebSocket } from "../src/cdp/connection.ts";
import { getTracker } from "../src/cdp/network-events-registry.ts";
import { SESSION_ID_HEADER } from "../src/observability.ts";
import {
  notifyIsolateLimit,
  registerIsolateLimitListener,
  unregisterIsolateLimitListener,
  unregisterIsolateLimitListenersFor,
  type IsolateLimitNotice,
} from "../src/eval/limit-registry.ts";

const NOTICE: IsolateLimitNotice = { kind: "cpu", capMs: 50, fromTail: true };
const REGISTRY_CAP = 64;
const registered: string[] = [];

function register(name: string, cb: () => void, isLive?: () => boolean, owner?: string): void {
  registered.push(name);
  registerIsolateLimitListener(name, cb, { isLive, owner });
}

afterEach(() => {
  for (const name of registered.splice(0)) unregisterIsolateLimitListener(name);
  vi.unstubAllGlobals();
});

describe("isolate limit registry", () => {
  it("keeps a live listener while retired generations overflow the map", () => {
    const fired: string[] = [];
    register(
      "victim",
      () => fired.push("victim"),
      () => true,
    );
    for (let i = 0; i < REGISTRY_CAP * 2; i++)
      register(
        `retired-${i}`,
        () => {},
        () => false,
      );
    notifyIsolateLimit("victim", NOTICE);
    expect(fired).toEqual(["victim"]);
  });

  it("still bounds the map when every listener is live", () => {
    const fired: string[] = [];
    register(
      "oldest",
      () => fired.push("oldest"),
      () => true,
    );
    for (let i = 0; i < REGISTRY_CAP; i++)
      register(
        `live-${i}`,
        () => {},
        () => true,
      );
    notifyIsolateLimit("oldest", NOTICE);
    expect(fired).toEqual([]);
  });

  it("drops only the closing connection's listeners", () => {
    const fired: string[] = [];
    register("a", () => fired.push("a"), undefined, "conn-a");
    register("b", () => fired.push("b"), undefined, "conn-b");
    unregisterIsolateLimitListenersFor("conn-a");
    notifyIsolateLimit("a", NOTICE);
    notifyIsolateLimit("b", NOTICE);
    expect(fired).toEqual(["b"]);
  });
});

describe("connection teardown", () => {
  it("releases the tracker when the socket errors and never closes", async () => {
    const server = Object.assign(new EventTarget(), { accept() {}, send() {} });
    const RealPair = WebSocketPair;
    vi.stubGlobal("WebSocketPair", function () {
      return { 0: Object.values(new RealPair())[0], 1: server };
    });
    const r = await handleWebSocket(new Request("https://x"), {} as Env, createExecutionContext());
    server.dispatchEvent(new Event("error"));
    const id = r.headers.get(SESSION_ID_HEADER);
    expect(id).toBeTruthy();
    expect(getTracker(id ?? "")).toBeUndefined();
  });
});
