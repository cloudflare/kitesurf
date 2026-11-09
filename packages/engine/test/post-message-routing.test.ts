// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { makeChildFrameState, makeMainFrameState } from "../src/cdp/frames.ts";
import { routePostMessageToChild, routePostMessageToParent } from "../src/cdp/page.ts";
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
