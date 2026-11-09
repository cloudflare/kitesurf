// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

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
