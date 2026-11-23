// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import type { LocalStorageOp } from "@kitesurf/jsrpc-types/page-script";

import { sharedArea } from "../../page-script/src/web-storage.ts";

const QUOTA = 5 * 1024 * 1024;
// JSRPC's message limit (core dom/cdp.rs). A code unit serializes to two bytes or less.
const RPC_LIMIT_UNITS = (32 * 1024 * 1024) / 2;

const batchUnits = (ops: LocalStorageOp[]) =>
  ops.reduce(
    (n, op) =>
      n + (op.op === "clear" ? 0 : op.key.length) + (op.op === "set" ? op.value.length : 0),
    0,
  );

describe("sharedArea", () => {
  it("sends its batch on a page that replaced Promise.prototype.then and Reflect.apply", async () => {
    const sent: LocalStorageOp[][] = [];
    const area = sharedArea([], (ops) => sent.push(ops));
    const { then } = Promise.prototype;
    const { apply } = Reflect;
    try {
      Promise.prototype.then = () => new Promise(() => {});
      Reflect.apply = () => undefined;
      area.set("k", "v");
    } finally {
      Promise.prototype.then = then;
      Reflect.apply = apply;
    }
    await Promise.resolve();
    area.set("later", "w");
    await Promise.resolve();
    expect(sent).toEqual([
      [{ op: "set", key: "k", value: "v" }],
      [{ op: "set", key: "later", value: "w" }],
    ]);
  });

  it("sends one task's changes as one batch", async () => {
    const sent: LocalStorageOp[][] = [];
    const area = sharedArea([["seeded", "1"]], (ops) => sent.push(ops));
    area.set("a", "1");
    area.remove("seeded");
    expect(sent).toEqual([]);
    await Promise.resolve();
    expect(sent).toEqual([
      [
        { op: "set", key: "a", value: "1" },
        { op: "remove", key: "seeded" },
      ],
    ]);
  });

  it("keeps every batch of a replace loop under the RPC limit, in order", async () => {
    const sent: LocalStorageOp[][] = [];
    const area = sharedArea([], (ops) => sent.push(ops));
    const big = "x".repeat(4 * 1024 * 1024);
    for (let i = 0; i < 9; i++) area.set("k", big + i);
    await Promise.resolve();
    expect(sent.length).toBeGreaterThan(1);
    for (const ops of sent) expect(batchUnits(ops)).toBeLessThan(RPC_LIMIT_UNITS);
    const last = sent.at(-1)?.at(-1);
    expect(last).toEqual({ op: "set", key: "k", value: big + 8 });
    expect(sent.flat()).toHaveLength(9);
  });

  it("sends nothing before a clear in the same batch", async () => {
    const sent: LocalStorageOp[][] = [];
    const area = sharedArea([], (ops) => sent.push(ops));
    area.set("a", "1");
    area.clear();
    area.set("b", "2");
    await Promise.resolve();
    expect(sent).toEqual([[{ op: "clear" }, { op: "set", key: "b", value: "2" }]]);
  });

  it("drops a remove whose key no area can hold", async () => {
    const sent: LocalStorageOp[][] = [];
    const area = sharedArea([], (ops) => sent.push(ops));
    for (let i = 0; i < 4; i++) area.remove("k".repeat(QUOTA + 1 + i));
    area.remove("k");
    await Promise.resolve();
    expect(sent).toEqual([[{ op: "remove", key: "k" }]]);
  });

  it("replays a sent batch over a change the engine applied before it", async () => {
    const area = sharedArea([], () => {});
    area.set("k", "mine");
    await Promise.resolve();
    // Another page's write landed before batch 1: the area ends with this copy's value.
    expect(area.applyRemote([{ op: "set", key: "k", value: "theirs" }], 0)).toEqual([]);
    expect(area.get("k")).toBe("mine");
    // After batch 1 the other write wins and shows.
    const later = area.applyRemote([{ op: "set", key: "k", value: "later" }], 1);
    expect(later).toEqual([{ key: "k", oldValue: "mine", newValue: "later" }]);
    expect(area.get("k")).toBe("later");
  });

  it("takes the area's value for a set the engine dropped, under later writes", async () => {
    const area = sharedArea([], () => {});
    area.set("k", "dropped");
    area.set("j", "dropped");
    await Promise.resolve();
    area.set("j", "kept");
    await Promise.resolve();
    const fixes: LocalStorageOp[] = [
      { op: "remove", key: "k" },
      { op: "set", key: "j", value: "old" },
    ];
    area.applyRemote(fixes, 1);
    expect([area.get("k"), area.get("j")]).toEqual([null, "kept"]);
    // The ack of batch 2 leaves nothing to replay.
    area.applyRemote([{ op: "set", key: "j", value: "theirs" }], 2);
    expect(area.get("j")).toBe("theirs");
  });
});
