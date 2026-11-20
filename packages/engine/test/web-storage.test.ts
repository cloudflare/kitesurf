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
});
