// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import { handleNetwork, effectiveExtraHeaders } from "../src/cdp/network.ts";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import type { CdpRequest, TargetState } from "../src/cdp/types.ts";

function makeTarget(over: Partial<TargetState> = {}): TargetState {
  return {
    type: "page",
    sessions: new Set<string>(),
    extraHttpHeaders: {},
    userAgentOverride: "",
    ...over,
  } as TargetState;
}

function makeCtx(targets: Map<string, TargetState>): DispatchCtx {
  return {
    browser: { targets, cookies: {} },
  } as DispatchCtx;
}

function uaReq(userAgent: unknown, sessionId?: string): CdpRequest {
  return {
    id: 1,
    method: "Network.setUserAgentOverride",
    params: { userAgent },
    sessionId,
  } as CdpRequest;
}

describe("Network.setUserAgentOverride storage", () => {
  it("stores the override on the session-attached target", async () => {
    const attached = makeTarget({ sessions: new Set(["sess-1"]) });
    const other = makeTarget();
    const ctx = makeCtx(
      new Map([
        ["t-other", other],
        ["t-attached", attached],
      ]),
    );
    const res = await handleNetwork(ctx, uaReq("TestUA/1.0", "sess-1"));
    expect(res).toEqual({});
    expect(attached.userAgentOverride).toBe("TestUA/1.0");
    expect(other.userAgentOverride).toBe("");
  });

  it("falls back to the first PAGE target when no sessionId", async () => {
    const browserTarget = makeTarget({ type: "browser" });
    const page = makeTarget();
    const ctx = makeCtx(
      new Map([
        ["browser", browserTarget],
        ["page", page],
      ]),
    );
    await handleNetwork(ctx, uaReq("TestUA/2.0"));
    expect(page.userAgentOverride).toBe("TestUA/2.0");
    expect(browserTarget.userAgentOverride).toBe("");
  });

  it("empty string clears a previously set override", async () => {
    const page = makeTarget({ userAgentOverride: "Old/1.0" });
    const ctx = makeCtx(new Map([["page", page]]));
    await handleNetwork(ctx, uaReq(""));
    expect(page.userAgentOverride).toBe("");
  });

  it("non-string userAgent param clears rather than storing garbage", async () => {
    const page = makeTarget({ userAgentOverride: "Old/1.0" });
    const ctx = makeCtx(new Map([["page", page]]));
    await handleNetwork(ctx, uaReq(42));
    expect(page.userAgentOverride).toBe("");
  });

  it("no page target at all is a silent no-op (empty result)", async () => {
    const ctx = makeCtx(new Map([["browser", makeTarget({ type: "browser" })]]));
    const res = await handleNetwork(ctx, uaReq("TestUA/3.0"));
    expect(res).toEqual({});
  });
});

describe("effectiveExtraHeaders merge", () => {
  it("returns the extras map untouched when no override is set", () => {
    const t = makeTarget({ extraHttpHeaders: { "x-a": "1" } });
    expect(effectiveExtraHeaders(t)).toBe(t.extraHttpHeaders);
  });

  it("folds the override in as user-agent without mutating extras", () => {
    const t = makeTarget({
      extraHttpHeaders: { "x-a": "1" },
      userAgentOverride: "Merged/1.0",
    });
    expect(effectiveExtraHeaders(t)).toEqual({
      "x-a": "1",
      "user-agent": "Merged/1.0",
    });
    expect(t.extraHttpHeaders).toEqual({ "x-a": "1" });
  });

  it("override wins over an extras-supplied lowercase user-agent", () => {
    const t = makeTarget({
      extraHttpHeaders: { "user-agent": "FromExtras/1.0" },
      userAgentOverride: "Override/1.0",
    });
    expect(effectiveExtraHeaders(t)).toEqual({ "user-agent": "Override/1.0" });
  });

  it("drops case-variant user-agent extras keys (no combined value)", () => {
    const t = makeTarget({
      extraHttpHeaders: { "User-Agent": "FromExtras/1.0", "x-a": "1" },
      userAgentOverride: "Override/1.0",
    });
    expect(effectiveExtraHeaders(t)).toEqual({
      "x-a": "1",
      "user-agent": "Override/1.0",
    });
  });
});
