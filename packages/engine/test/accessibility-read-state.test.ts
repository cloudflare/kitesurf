// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";

import { buildTree } from "../src/cdp/accessibility.ts";
import type { TargetState } from "../src/cdp/types.ts";
import type { QueryDomArgs } from "@kitesurf/jsrpc-types/query-dom";

const TREE = JSON.stringify({
  nodes: [
    {
      nodeId: "root-F",
      ignored: false,
      role: { type: "internalRole", value: "RootWebArea" },
      name: { type: "computedString", value: "T" },
      backendDOMNodeId: 0,
      frameId: "F",
      childIds: [],
    },
  ],
});

const TREE_BYTE_LENGTH = new TextEncoder().encode(TREE).byteLength;

const ROOT = {
  nodeId: 1,
  backendNodeId: 1,
  nodeType: 9,
  nodeName: "#document",
  localName: "",
  nodeValue: "",
};

function stamp(before: number, after: number) {
  return { before, after, complete: true };
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function pageTarget(): TargetState {
  return { type: "page", frameId: "F", url: "", title: "" } as TargetState;
}

// Every reply carries a stamp; only the caller's option decides whether one is requested.
function pageScriptStub() {
  const requested: Array<QueryDomArgs<"accessibilityTree">> = [];
  const ps = {
    call: {
      getDocument: async () => ({ root: ROOT, readStamp: stamp(1, 1) }),
      accessibilityTree: async (args: QueryDomArgs<"accessibilityTree">) => {
        requested.push(args);
        return {
          byteLength: TREE_BYTE_LENGTH,
          json: streamOf(TREE),
          readStamp: stamp(1, 2),
        };
      },
    },
    tryCall: {
      getDocument: async () => ({ root: ROOT, readStamp: stamp(1, 1) }),
      notRenderedNodeIds: async () => ({
        displayNone: [],
        invisible: [],
        readStamp: stamp(1, 1),
      }),
      formStateSnapshot: async () => ({
        values: [],
        checked: [],
        selected: [],
        readStamp: stamp(1, 1),
      }),
    },
  };
  return { ps, requested };
}

describe("accessibility read state", () => {
  // The AX nodes and the DOM snapshot are separate reads, so the tree's own
  // stamp is what lets a consumer tell whether they describe the same DOM.
  it("records the accessibility read's stamp", async () => {
    const { ps, requested } = pageScriptStub();

    const built = await buildTree(ps, pageTarget(), { includeReadState: true });

    expect(requested).toHaveLength(1);
    expect(requested[0]?.includeReadStamp).toBe(true);
    expect(built?.readState?.stamps.accessibility).toEqual(stamp(1, 2));
  });

  // `call` throws where `tryCall` answers null. An embedder that reads null as "no document yet"
  // and retries must keep working when a navigation starts mid-read.
  it("answers null when the pinned generation retires during the read", async () => {
    const retired = async () => {
      throw new Error("PageScript generation retired");
    };
    const ps = {
      call: { getDocument: retired, accessibilityTree: retired },
      tryCall: {
        getDocument: async () => null,
        notRenderedNodeIds: async () => null,
        formStateSnapshot: async () => null,
      },
    };

    await expect(
      buildTree(ps, pageTarget(), { includeReadState: true, fallback: false }),
    ).resolves.toBeNull();
  });

  // A navigation that replaces the PageScript mid-read rejects with the RPC's own error, not the
  // session's "retired" message, so the session's liveness is what decides.
  it("answers null when the PageScript is replaced during the document read", async () => {
    const ps = {
      call: {
        getDocument: async () => {
          throw new Error("PageScript session is dead");
        },
        accessibilityTree: async () => null as never,
      },
      tryCall: {
        getDocument: async () => null,
        notRenderedNodeIds: async () => null,
        formStateSnapshot: async () => null,
      },
      isLive: () => false,
    };

    await expect(
      buildTree(ps, pageTarget(), { includeReadState: true, fallback: false }),
    ).resolves.toBeNull();
  });

  // The navigation can land after the document read; the tree read has to answer the same way.
  it("answers null when the navigation lands before the accessibility read", async () => {
    let live = true;
    const ps = {
      call: {
        getDocument: async () => ({ root: ROOT, readStamp: stamp(1, 1) }),
        accessibilityTree: async () => {
          live = false;
          throw new Error("PageScript generation retired");
        },
      },
      tryCall: {
        getDocument: async () => null,
        notRenderedNodeIds: async () => null,
        formStateSnapshot: async () => null,
      },
      isLive: () => live,
    };

    await expect(
      buildTree(ps, pageTarget(), { includeReadState: true, fallback: false }),
    ).resolves.toBeNull();
  });

  // A read budget error is a real failure, not a generation that went away.
  it("still throws when the document read reports a budget error", async () => {
    const ps = {
      call: {
        getDocument: async () => ({
          budgetError: { nodes: 120_000, atLeastBytes: 30_000_000, nodesAtLeast: true, budget: 1 },
        }),
        accessibilityTree: async () => ({ budgetError: { nodes: 1, bytes: 1, budget: 0 } }),
      },
      tryCall: {
        getDocument: async () => null,
        notRenderedNodeIds: async () => null,
        formStateSnapshot: async () => null,
      },
    };

    await expect(buildTree(ps, pageTarget(), { fallback: false })).rejects.toThrow(/budget/i);
  });

  it("does not request a stamp when the caller did not ask for read state", async () => {
    const { ps, requested } = pageScriptStub();

    const built = await buildTree(ps, pageTarget());

    expect(requested[0]?.includeReadStamp).toBeUndefined();
    expect(built?.readState).toBeUndefined();
  });
});
