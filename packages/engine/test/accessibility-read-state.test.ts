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

describe("accessibility read state", () => {
  // The AX nodes and the DOM snapshot are separate reads, so the tree's own
  // stamp is what lets a consumer tell whether they describe the same DOM.
  it("records the accessibility read's stamp", async () => {
    const requested: Array<QueryDomArgs<"accessibilityTree">> = [];
    const ps = {
      call: {
        getDocument: async () => ({ root: ROOT, readStamp: stamp(1, 1) }),
        accessibilityTree: async (args: QueryDomArgs<"accessibilityTree">) => {
          requested.push(args);
          return {
            byteLength: new TextEncoder().encode(TREE).byteLength,
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
    const target = { type: "page", frameId: "F", url: "", title: "" } as TargetState;

    const built = await buildTree(ps, target, { includeReadState: true });

    expect(requested).toHaveLength(1);
    expect(requested[0]?.includeReadStamp).toBe(true);
    expect(built?.readState?.stamps.accessibility).toEqual(stamp(1, 2));
  });

  it("does not request a stamp when the caller did not ask for read state", async () => {
    const requested: Array<QueryDomArgs<"accessibilityTree">> = [];
    const ps = {
      call: {
        getDocument: async () => ({ root: ROOT }),
        accessibilityTree: async (args: QueryDomArgs<"accessibilityTree">) => {
          requested.push(args);
          return {
            byteLength: new TextEncoder().encode(TREE).byteLength,
            json: streamOf(TREE),
          };
        },
      },
      tryCall: {
        getDocument: async () => ({ root: ROOT }),
        notRenderedNodeIds: async () => ({ displayNone: [], invisible: [] }),
        formStateSnapshot: async () => ({ values: [], checked: [], selected: [] }),
      },
    };
    const target = { type: "page", frameId: "F", url: "", title: "" } as TargetState;

    const built = await buildTree(ps, target);

    expect(requested[0]?.includeReadStamp).toBeUndefined();
    expect(built?.readState).toBeUndefined();
  });
});
