// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The trusted ancestor chain comes from the frame tree, not from URLs the page supplies. A local
// scheme document inherits its creator's committed origin, and an opaque origin keeps one
// identity per document.

import { expect, test } from "vitest";

import {
  committedFrameOriginOf,
  frameAncestorOrigins,
  makeChildFrameState,
  makeMainFrameState,
} from "../src/cdp/frames.ts";
import { SANDBOX_ALLOW_ALL, type SandboxRestrictions } from "@kitesurf/script-gate";
import type { FrameState } from "../src/cdp/types.ts";

const MAIN_URL = "https://a.example/index.html";

function opaqueSandbox(): SandboxRestrictions {
  return { ...SANDBOX_ALLOW_ALL, sameOrigin: false };
}

function frameMap(frames: FrameState[]): Map<string, FrameState> {
  return new Map(frames.map((frame) => [frame.frameId, frame]));
}

function child(
  parent: FrameState,
  frameId: string,
  url: string,
  options: { sandbox?: SandboxRestrictions; loaderId?: string } = {},
): FrameState {
  return makeChildFrameState({
    frameId,
    parentFrameId: parent.frameId,
    loaderId: options.loaderId ?? `loader-${frameId}`,
    url,
    ...(options.sandbox ? { sandbox: options.sandbox } : {}),
    name: "",
    ownerElementId: "",
    ownerBackendNodeId: -1,
    isCrossOrigin: false,
    delaysLoadEvent: true,
  });
}

test("a network child reports its parent's committed origin", () => {
  const main = makeMainFrameState({ frameId: "main", loaderId: "main-loader", url: MAIN_URL });
  const network = child(main, "child", "https://b.example/x");
  expect(frameAncestorOrigins(network, frameMap([main, network]), MAIN_URL)).toEqual([
    { kind: "tuple", origin: "https://a.example" },
  ]);
});

test("about:blank and srcdoc inherit their creator's origin", () => {
  const main = makeMainFrameState({ frameId: "main", loaderId: "main-loader", url: MAIN_URL });
  const blank = child(main, "blank", "about:blank");
  const srcdoc = child(main, "srcdoc", "about:srcdoc");
  const frames = frameMap([main, blank, srcdoc]);
  for (const frame of [blank, srcdoc]) {
    expect(committedFrameOriginOf(frame, frames, MAIN_URL)).toEqual({
      kind: "tuple",
      origin: "https://a.example",
    });
  }
});

test("a sandboxed document has a distinct opaque identity", () => {
  const main = makeMainFrameState({ frameId: "main", loaderId: "main-loader", url: MAIN_URL });
  const opaque = child(main, "opaque", "https://a.example/x", { sandbox: opaqueSandbox() });
  const frames = frameMap([main, opaque]);
  const origin = committedFrameOriginOf(opaque, frames, MAIN_URL);
  expect(origin).toEqual({ kind: "opaque", id: "opaque:loader-opaque" });
  // A second opaque document never compares equal to the first.
  const sibling = child(main, "sibling", "https://a.example/y", { sandbox: opaqueSandbox() });
  expect(committedFrameOriginOf(sibling, frameMap([main, sibling]), MAIN_URL)).not.toEqual(origin);
});

test("a blank child of an opaque document inherits the opaque identity", () => {
  const main = makeMainFrameState({ frameId: "main", loaderId: "main-loader", url: MAIN_URL });
  const opaque = child(main, "opaque", "https://a.example/x", { sandbox: opaqueSandbox() });
  const blank = child(opaque, "blank", "about:blank");
  expect(committedFrameOriginOf(blank, frameMap([main, opaque, blank]), MAIN_URL)).toEqual({
    kind: "opaque",
    id: "opaque:loader-opaque",
  });
});

test("a data: document is opaque", () => {
  const main = makeMainFrameState({ frameId: "main", loaderId: "main-loader", url: MAIN_URL });
  const data = child(main, "data", "data:text/html,x");
  expect(committedFrameOriginOf(data, frameMap([main, data]), MAIN_URL)).toEqual({
    kind: "opaque",
    id: "data:loader-data",
  });
});

test("the chain is nearest first and resolves local-scheme intermediates", () => {
  const main = makeMainFrameState({ frameId: "main", loaderId: "main-loader", url: MAIN_URL });
  const blank = child(main, "blank", "about:blank");
  const network = child(blank, "network", "https://b.example/x");
  const frames = frameMap([main, blank, network]);
  expect(frameAncestorOrigins(network, frames, MAIN_URL)).toEqual([
    { kind: "tuple", origin: "https://a.example" },
    { kind: "tuple", origin: "https://a.example" },
  ]);
});

test("the chain stops at the main frame", () => {
  const main = makeMainFrameState({ frameId: "main", loaderId: "main-loader", url: MAIN_URL });
  expect(frameAncestorOrigins(main, frameMap([main]), MAIN_URL)).toEqual([]);
});
