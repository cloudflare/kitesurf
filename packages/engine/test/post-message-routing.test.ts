// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { makeChildFrameState, makeMainFrameState } from "../src/cdp/frames.ts";
import {
  routeChildFramePostMessage,
  routePostMessageToChild,
  routePostMessageToParent,
} from "../src/cdp/page.ts";
import type { FrameState, TargetState } from "../src/cdp/types.ts";
import type { PageScriptStub } from "../src/eval/page-script.ts";

type Delivered = { origin?: string; dataJson?: string };

function recordingStub(log: Delivered[]): PageScriptStub {
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only deliverMessage is stubbed.
  return {
    deliverMessage: async (m: Delivered) => {
      log.push(m);
    },
  } as unknown as PageScriptStub;
}

function setup(mainUrl: string, childUrl: string) {
  const toMain: Delivered[] = [];
  const toChild: Delivered[] = [];
  const main = makeMainFrameState({ frameId: "M", loaderId: "L", url: mainUrl });
  const child = makeChildFrameState({
    frameId: "C",
    parentFrameId: "M",
    loaderId: "LC",
    url: childUrl,
    name: "",
    ownerElementId: "",
    ownerBackendNodeId: 5,
    isCrossOrigin: true,
    delaysLoadEvent: false,
  });
  child.pageScript = recordingStub(toChild);
  const target = {
    frameId: "M",
    url: mainUrl,
    pageScriptUrl: mainUrl,
    pageScript: recordingStub(toMain),
    frames: new Map<string, FrameState>([
      ["M", main],
      ["C", child],
    ]),
  } as TargetState;
  return { target, main, child, toMain, toChild };
}

const forged = (extra: Record<string, unknown> = {}) => ({
  dataJson: '"hi"',
  targetOrigin: "*",
  sourceOrigin: "https://forged.test",
  ...extra,
});

describe("postMessage source origins", () => {
  it.each([
    ["https://child.test/x", "https://child.test"],
    ["data:text/html,child", "null"],
    ["about:srcdoc", "https://main.test"],
    ["about:blank", "https://main.test"],
  ])("a child at %s posts to its parent as %s", async (childUrl, origin) => {
    const h = setup("https://main.test/page", childUrl);
    routePostMessageToParent(h.target, "C", forged({ toParent: true }));
    await Promise.resolve();
    expect(h.toMain.map((m) => m.origin)).toEqual([origin]);
  });

  it.each([
    ["https://main.test/page", "https://main.test"],
    ["data:text/html,main", "null"],
  ])("a main frame at %s posts to its child as %s", async (mainUrl, origin) => {
    const h = setup(mainUrl, "https://child.test/x");
    routePostMessageToChild(h.target, h.main, forged({ toFrameOwnerId: 5 }));
    await Promise.resolve();
    expect(h.toChild.map((m) => m.origin)).toEqual([origin]);
  });

  it("checks a '/' target origin against the sender's own origin", async () => {
    const h = setup("https://main.test/page", "https://child.test/x");
    routePostMessageToParent(
      h.target,
      "C",
      forged({ toParent: true, sourceOrigin: "https://main.test", targetOrigin: "/" }),
    );
    await Promise.resolve();
    expect(h.toMain).toEqual([]);
  });

  it("queues a message for a child that has no isolate yet under the sender's origin", () => {
    const h = setup("https://main.test/page", "https://child.test/x");
    h.child.pageScript = null;
    routePostMessageToChild(h.target, h.main, forged({ toFrameOwnerId: 5 }));
    expect(h.child.pendingPostMessages?.map((m) => m.sourceOrigin)).toEqual(["https://main.test"]);
  });
});

describe("postMessage routing", () => {
  const addNested = (h: ReturnType<typeof setup>, log: Delivered[]) => {
    const nested = makeChildFrameState({
      frameId: "N",
      parentFrameId: "C",
      loaderId: "LN",
      url: "https://nested.test/",
      name: "",
      ownerElementId: "",
      ownerBackendNodeId: 5,
      isCrossOrigin: true,
      delaysLoadEvent: false,
    });
    nested.pageScript = recordingStub(log);
    h.target.frames.set("N", nested);
  };

  it("delivers a child's message for its own iframe there, not to its parent", async () => {
    const h = setup("https://main.test/page", "https://child.test/x");
    const toNested: Delivered[] = [];
    addNested(h, toNested);
    routeChildFramePostMessage(h.target, h.child, forged({ toFrameOwnerId: 5 }));
    await Promise.resolve();
    expect(h.toMain).toEqual([]);
    expect(h.toChild).toEqual([]);
    expect(toNested.map((m) => m.origin)).toEqual(["https://child.test"]);
  });

  it("delivers a child's message for its parent to the parent", async () => {
    const h = setup("https://main.test/page", "https://child.test/x");
    routeChildFramePostMessage(h.target, h.child, forged({ toParent: true }));
    await Promise.resolve();
    expect(h.toMain.map((m) => m.origin)).toEqual(["https://child.test"]);
  });

  it("keeps the origin of a child document that posts while it is being replaced", async () => {
    const h = setup("https://main.test/page", "https://child.test/x");
    const toNested: Delivered[] = [];
    addNested(h, toNested);
    // kitesurf.frameNavigated commits the next url before the old isolate runs its unload handlers.
    h.child.url = "https://next.test/y";
    routeChildFramePostMessage(
      h.target,
      h.child,
      forged({ toParent: true }),
      "https://child.test/x",
    );
    routeChildFramePostMessage(
      h.target,
      h.child,
      forged({ toFrameOwnerId: 5 }),
      "https://child.test/x",
    );
    await Promise.resolve();
    expect(h.toMain.map((m) => m.origin)).toEqual(["https://child.test"]);
    expect(toNested.map((m) => m.origin)).toEqual(["https://child.test"]);
  });

  it("matches an owner id only among the sender's own children", async () => {
    const h = setup("https://main.test/page", "https://child.test/x");
    const toNested: Delivered[] = [];
    addNested(h, toNested);
    h.target.frames.delete("C");
    routePostMessageToChild(h.target, h.main, forged({ toFrameOwnerId: 5 }));
    await Promise.resolve();
    expect(toNested).toEqual([]);
  });
});
