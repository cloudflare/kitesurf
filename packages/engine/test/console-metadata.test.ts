// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, it } from "vitest";
import type { PackedResult } from "@kitesurf/jsrpc-types/shared";
import { packResult } from "../../page-script/src/pack.ts";
import { consoleEntryToCdpEvent } from "../src/eval/page-script.ts";

it("console metadata is a primitive string", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const object = { constructor: { name: cycle } };
  const fn = Object.assign(() => {}, { toString: () => ({ slice: () => cycle }) });
  const error = new Error("boom");
  Object.defineProperty(error, "stack", {
    get: () => {
      throw new Error("no stack");
    },
  });
  Object.defineProperty(error, "name", { get: () => cycle });
  Object.defineProperty(error, "message", { get: () => cycle });

  const cases = [
    [object, "Object"],
    [fn, "Function"],
    [error, "Error"],
    [new (class Widget {})(), "Widget"],
  ] as const;
  for (const [value, className] of cases) {
    const packed = packResult(value, true);
    expect(packed.className).toBe(className);
    expect(typeof packed.description).toBe("string");
  }

  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- forged RPC reply whose wire type claims strings.
  const forged = {
    ok: true,
    type: "object",
    className: cycle,
    description: cycle,
    valueJson: cycle,
  } as unknown as PackedResult;
  const event = consoleEntryToCdpEvent({ level: "log", timestamp: 0, args: [forged] });
  expect(event.params.args[0]?.className).toBeUndefined();
  expect(event.params.args[0]?.description).toBeUndefined();
  expect(() => JSON.stringify(event)).not.toThrow();
});
