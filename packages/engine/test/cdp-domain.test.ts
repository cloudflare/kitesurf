// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { defineDomain, defineSessionMethods, stub } from "../src/cdp/domain.ts";
import { dispatch, type DispatchCtx } from "../src/cdp/dispatch.ts";
import { CDP_COMMAND_UNHANDLED, parseCdpRequest, type CdpRequest } from "../src/cdp/types.ts";
import { testClient } from "./client-state.ts";

function request(message: object): CdpRequest {
  const parsed = parseCdpRequest(JSON.stringify(message));
  if (!parsed.ok) throw new Error("bad request fixture");
  return parsed.request;
}

function fakeCtx(): DispatchCtx {
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only what dispatch reads.
  return {
    browser: {
      networkEvents: { drain() {}, setLogEnabled() {} },
      rendererSessionId: null,
      engineSessionId: null,
    },
    client: testClient(),
  } as unknown as DispatchCtx;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("defineDomain", () => {
  it("throws on a method outside the domain", () => {
    // The types reject this map too (cdp-domain.test-d.ts); a cast or spread could still pass it.
    // @ts-expect-error DOM.enable is not a Log method.
    expect(() => defineDomain("Log", { methods: { "DOM.enable": stub } })).toThrow(
      "DOM.enable is not a Log method",
    );
  });

  it("answers a defined method with its handler", async () => {
    const domain = defineDomain("Log", {
      methods: { "Log.enable": () => ({}), "Log.clear": stub },
    });
    expect([...domain.methods]).toEqual(["Log.enable", "Log.clear"]);
    expect(await domain.run(fakeCtx(), request({ id: 1, method: "Log.clear" }))).toEqual({});
  });

  it("starts the handler before run returns, as the switch handlers did", async () => {
    let started = false;
    const domain = defineDomain("Log", {
      context: (ctx) => ctx,
      methods: {
        "Log.enable": () => {
          started = true;
          return {};
        },
      },
    });
    const pending = domain.run(fakeCtx(), request({ id: 1, method: "Log.enable" }));
    expect(started).toBe(true);
    await pending;
  });

  it("runs the context, then returns CDP_COMMAND_UNHANDLED for a method it does not define", async () => {
    const context = vi.fn((ctx: DispatchCtx) => ctx);
    const domain = defineDomain("Log", { context, methods: {} });
    const reply = await domain.run(fakeCtx(), request({ id: 1, method: "Log.enable" }));
    expect(reply).toBe(CDP_COMMAND_UNHANDLED);
    expect(context).toHaveBeenCalledTimes(1);
  });
});

describe("defineSessionMethods", () => {
  it("answers methods of any domain and leaves the rest to the caller", async () => {
    const table = defineSessionMethods("Engine", {
      methods: { "Runtime.enable": () => ({}), "Log.clear": stub },
    });
    expect([...table.methods]).toEqual(["Runtime.enable", "Log.clear"]);
    expect(await table.run(fakeCtx(), request({ id: 1, method: "Log.clear" }))).toEqual({});
    const reply = await table.run(fakeCtx(), request({ id: 2, method: "DOM.enable" }));
    expect(reply).toBe(CDP_COMMAND_UNHANDLED);
  });
});

describe("dispatch of a defined domain", () => {
  it("answers {} for a method the domain does not define, and logs it once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = fakeCtx();
    for (const id of [1, 2]) {
      const response = await dispatch(ctx, request({ id, method: "Log.notAMethod" }));
      expect(response).toEqual({ id, result: {}, sessionId: undefined });
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[kitesurf-cdp] "Log.notAMethod" is not defined; answering {}',
    );
  });

  it("refuses a WebMCP method the domain does not define", async () => {
    const response = await dispatch(fakeCtx(), request({ id: 3, method: "WebMCP.notAMethod" }));
    expect(response).toEqual({
      id: 3,
      error: { code: -32000, message: "WebMCP.notAMethod is not a recognized WebMCP method" },
      sessionId: undefined,
    });
  });
});
