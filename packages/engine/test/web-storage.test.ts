// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import type { WebStorageOp } from "@kitesurf/jsrpc-types/page-script";
import { WEB_STORAGE_QUOTA_UNITS, WebStorage } from "../src/state/web-storage.ts";
import { MemorySessionStore } from "../src/state/session-store.ts";
import { sharedArea } from "../../page-script/src/web-storage.ts";

const ORIGIN = "https://example.com";
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("a page's localStorage batch", () => {
  // Rewriting a near-quota key a few times in one task used to queue a batch over the RPC size
  // cap, and the refused send lost every write in it.
  it("keeps the last write per key, so it stays within the quota", async () => {
    const sent: WebStorageOp[][] = [];
    const area = sharedArea([], (ops) => sent.push(ops));
    const big = (c: string) => c.repeat(2 * 1024 * 1024);
    for (const c of "abcdefgh") area.set("big", big(c));
    area.set("x", "1");
    area.remove("x");
    area.set("y", "2");
    await settle();
    expect(sent).toHaveLength(1);
    expect(
      sent[0]?.map((op) => (op.op === "set" ? [op.op, op.key, op.value.length] : [op.op])),
    ).toEqual([["set", "big", 2 * 1024 * 1024], ["remove"], ["set", "y", 1]]);
    expect(sent[0]?.[0]?.op === "set" && sent[0][0].value[0]).toBe("h");
  });

  it("drops what came before a clear, and still sends the clear", async () => {
    const sent: WebStorageOp[][] = [];
    const area = sharedArea([["old", "v"]], (ops) => sent.push(ops));
    area.set("a", "1");
    area.clear();
    area.set("b", "2");
    await settle();
    expect(sent).toEqual([[{ op: "clear" }, { op: "set", key: "b", value: "2" }]]);
    area.remove("gone");
    await settle();
    expect(sent[1]).toEqual([{ op: "remove", key: "gone" }]);
  });
});

describe("the engine's merged localStorage area", () => {
  it("refuses a write that would take it over the quota, keeping the old value", () => {
    const ls = new WebStorage(new MemorySessionStore());
    const half = "x".repeat(WEB_STORAGE_QUOTA_UNITS / 2);
    ls.apply(ORIGIN, [{ op: "set", key: "a", value: half }]); // two pages, each under quota
    ls.apply(ORIGIN, [{ op: "set", key: "b", value: half }]);
    expect(ls.entries(ORIGIN).map(([k]) => k)).toEqual(["a"]);
  });

  it("counts an overwrite, a remove and a clear against what the area holds", () => {
    const ls = new WebStorage(new MemorySessionStore());
    const big = "x".repeat(WEB_STORAGE_QUOTA_UNITS - 10);
    ls.apply(ORIGIN, [{ op: "set", key: "a", value: big }]);
    ls.apply(ORIGIN, [{ op: "set", key: "a", value: big.slice(1) }]); // the old value is freed
    ls.apply(ORIGIN, [
      { op: "remove", key: "a" },
      { op: "set", key: "b", value: big },
    ]);
    expect(ls.entries(ORIGIN).map(([k]) => k)).toEqual(["b"]);
    ls.apply(ORIGIN, [{ op: "clear" }, { op: "set", key: "c", value: big }]);
    expect(ls.entries(ORIGIN).map(([k]) => k)).toEqual(["c"]);
  });
});
