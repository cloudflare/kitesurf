// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Emulation.setEmulatedMedia keeps the media type and the media features independent, as
// Chrome does: a call that omits one leaves the other alone, and an omitted media type means
// "screen". Puppeteer's emulateMediaType and emulateMediaFeatures each send only their half.
// https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setEmulatedMedia

import { describe, expect, it } from "vitest";
import type { QueryDomMethod } from "@kitesurf/jsrpc-types/query-dom";
import { dispatch, type DispatchCtx } from "../src/cdp/dispatch.ts";
import { parseCdpRequest, type CdpRequest, type TargetState } from "../src/cdp/types.ts";
import { testClient } from "./client-state.ts";

function request(message: object): CdpRequest {
  const parsed = parseCdpRequest(JSON.stringify(message));
  if (!parsed.ok) throw new Error("bad request fixture");
  return parsed.request;
}

interface StubCall {
  method: QueryDomMethod;
  args: unknown;
}

function setup() {
  const calls: StubCall[] = [];
  const stub = {
    async queryDom(method: QueryDomMethod, args: unknown) {
      calls.push({ method, args });
      return {};
    },
  };
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the fields dispatch reads.
  const target = {
    type: "page",
    targetId: "T",
    sessions: new Set<string>(),
    pageScript: stub,
    emulatedMedia: "screen",
  } as unknown as TargetState;
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the fields dispatch reads.
  const ctx = {
    browser: {
      targets: new Map([[target.targetId, target]]),
      networkEvents: { drain() {} },
      rendererSessionId: null,
      engineSessionId: null,
    },
    client: testClient(),
  } as unknown as DispatchCtx;
  const send = (id: number, params: Record<string, unknown>) =>
    dispatch(ctx, request({ id, method: "Emulation.setEmulatedMedia", params }));
  return { target, calls, send };
}

describe("Emulation.setEmulatedMedia", () => {
  it("resets an earlier print override to screen when only features are sent", async () => {
    const h = setup();
    await h.send(1, { media: "print" });
    expect(h.target.emulatedMedia).toBe("print");

    await h.send(2, {
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });

    expect(h.target.emulatedMedia).toBe("screen");
    expect(h.target.emulatedDarkColorScheme).toBe(true);
    expect(h.calls.at(-1)).toEqual({
      method: "setMediaType",
      args: { media: "screen", darkColorScheme: true },
    });
  });

  it("still sets print for an explicit media type", async () => {
    const h = setup();
    await h.send(1, { media: "print" });
    expect(h.target.emulatedMedia).toBe("print");
    expect(h.calls.at(-1)).toEqual({
      method: "setMediaType",
      args: { media: "print" },
    });
  });

  it("keeps the color-scheme override when only the media type is sent", async () => {
    const h = setup();
    await h.send(1, {
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
    expect(h.target.emulatedDarkColorScheme).toBe(true);

    await h.send(2, { media: "print" });

    expect(h.target.emulatedMedia).toBe("print");
    expect(h.target.emulatedDarkColorScheme).toBe(true);
    expect(h.calls.at(-1)).toEqual({
      method: "setMediaType",
      args: { media: "print", darkColorScheme: true },
    });
  });

  it("treats an empty media type as screen", async () => {
    const h = setup();
    await h.send(1, { media: "print" });
    await h.send(2, { media: "" });
    expect(h.target.emulatedMedia).toBe("screen");
  });
});
