// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import { makeMainFrameState } from "../src/cdp/frames.ts";
import { handleInput } from "../src/cdp/input.ts";
import type { CdpEvent, CdpRequest, TargetState } from "../src/cdp/types.ts";

function setup(url: string, hashNavigateTo: string, pageScriptUrl: string | undefined = url) {
  const main = makeMainFrameState({ frameId: "F", loaderId: "L", url });
  main.securityOrigin = new URL(url).origin;
  const reply = {
    console: [],
    cookieWrites: [],
    cdpMutations: [],
    defaultPrevented: false,
    hashNavigateTo,
  };
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the fields input dispatch reads are set.
  const target = {
    type: "page",
    targetId: "T",
    frameId: "F",
    loaderId: "L",
    url,
    pageScriptUrl,
    frames: new Map([["F", main]]),
    sessions: new Set(["S"]),
    navigateGeneration: 1,
    wheelTeardownDepth: 0,
    defaultContextId: 1,
    pageScript: {
      dispatchKeyEvent: async () => reply,
      dispatchMouseEvent: async () => ({ ...reply, navigateTo: null, navigatePost: null }),
    },
  } as unknown as TargetState;
  const emitted: CdpEvent[] = [];
  const ctx = {
    browser: { targets: new Map([["T", target]]), screencasts: new Map(), wsClosing: false },
    emit: (e: CdpEvent) => {
      emitted.push(e);
    },
  } as DispatchCtx;
  return { ctx, target, main, emitted };
}

const key = {
  id: 1,
  method: "Input.dispatchKeyEvent",
  params: { type: "keyDown", key: "Escape", code: "Escape" },
  sessionId: "S",
} as CdpRequest;

const click = {
  id: 1,
  method: "Input.dispatchMouseEvent",
  params: { type: "mouseReleased", x: 1, y: 1, button: "left", clickCount: 1 },
  sessionId: "S",
} as CdpRequest;

async function follow(
  req: CdpRequest,
  url: string,
  hashNavigateTo: string,
  pageScriptUrl?: string,
) {
  const h = setup(url, hashNavigateTo, pageScriptUrl ?? url);
  await handleInput(h.ctx, req);
  return {
    url: h.target.url,
    frameUrl: h.main.url,
    origin: h.main.securityOrigin,
    navigated: h.emitted.filter((e) => e.method === "Page.frameNavigated").length,
  };
}

describe("hashNavigateTo in an input reply", () => {
  it.each([
    ["https://a.test/x", "https://a.test/x#f", undefined],
    ["https://a.test/x?q", "https://a.test/x?q#f", undefined],
    ["https://a.test/x#old", "https://a.test/x#new", undefined],
    ["https://a.test/pushed", "https://a.test/pushed#f", "https://a.test/x"],
    ["data:text/html,doc", "data:text/html,doc#f", undefined],
    ["about:blank", "about:blank#f", undefined],
  ])("moves %s to %s", async (from, to, sealed) => {
    for (const req of [key, click]) {
      const origin = new URL(from).origin;
      expect(await follow(req, from, to, sealed)).toEqual({
        url: to,
        frameUrl: to,
        origin,
        navigated: 1,
      });
    }
  });

  it.each([
    ["https://a.test/x", "https://b.test/x#f", undefined],
    ["https://a.test/x", "http://a.test/x#f", undefined],
    ["https://a.test/x", "https://a.test/other#f", undefined],
    ["https://a.test/x", "https://a.test/x?q#f", undefined],
    ["https://a.test/x#f", "https://a.test/x", undefined],
    ["data:text/html,doc", "data:text/html,other#f", undefined],
    ["https://a.test/x", "not a url#f", undefined],
    // target.url already names the next document while this isolate still answers input.
    ["https://b.test/next", "https://b.test/next#f", "https://a.test/x"],
  ])("keeps %s when the reply names %s", async (from, to, sealed) => {
    for (const req of [key, click]) {
      expect(await follow(req, from, to, sealed)).toEqual({
        url: from,
        frameUrl: from,
        origin: new URL(from).origin,
        navigated: 0,
      });
    }
  });
});
