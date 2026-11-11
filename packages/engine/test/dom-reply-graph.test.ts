// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { handleDom } from "../src/cdp/dom.ts";
import { registerEnsurePageScript } from "../src/cdp/page-session.ts";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import type { CdpRequest, TargetState } from "../src/cdp/types.ts";
import type { PageScriptStub } from "../src/eval/page-script.ts";
import type { DomHandle } from "../src/wasm.ts";
import type { QueryDomArgs, QueryDomMethod, QueryDomResult } from "@kitesurf/jsrpc-types/query-dom";

type CdpNode = Record<string, unknown>;

const node = (over: CdpNode = {}): CdpNode => ({
  nodeId: 2,
  nodeType: 1,
  nodeName: "DIV",
  ...over,
});

// A cross-origin owner makes the annotator walk the tree, which is where a DAG expands.
const iframe = node({ backendNodeId: 17, nodeName: "IFRAME" });
const documentWith = (...children: unknown[]): CdpNode =>
  node({ nodeId: 1, nodeType: 9, nodeName: "#document", children: [iframe, ...children] });

function chain(depth: number, branch: number): CdpNode {
  let child = node();
  for (let i = 0; i < depth; i++) child = node({ children: Array(branch).fill(child) });
  return documentWith(child);
}

function cycle(): CdpNode {
  const root = documentWith();
  (root.children as unknown[]).push(root);
  return root;
}

function accessorChildren(): CdpNode {
  const root = documentWith();
  Object.defineProperty(root, "children", { get: () => [iframe], enumerable: true });
  return root;
}

function makeStub(replies: Partial<Record<QueryDomMethod, unknown>>): PageScriptStub {
  const stub = {
    async queryDom<M extends QueryDomMethod>(
      method: M,
      _args: QueryDomArgs<M>,
    ): Promise<QueryDomResult<M>> {
      return (replies[method] ?? {}) as QueryDomResult<M>;
    },
  };
  return stub as PageScriptStub;
}

function makeTarget(over: Partial<TargetState>): TargetState {
  const child = {
    frameId: "child",
    parentFrameId: "main",
    isCrossOrigin: true,
    ownerBackendNodeId: 17,
  };
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the fields DOM dispatch reads are set.
  return {
    type: "page",
    targetId: "t1",
    sessions: new Set(["s1"]),
    frames: new Map([["child", child]]),
    domEnabledSessions: new Set<string>(),
    pageScript: null,
    blankReady: null,
    dom: null,
    ...over,
  } as unknown as TargetState;
}

function getDocument(target: TargetState): Promise<unknown> {
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the fields DOM dispatch reads are set.
  const ctx = {
    browser: { targets: new Map([["t1", target]]) },
    emit: () => {},
  } as unknown as DispatchCtx;
  return handleDom(ctx, {
    id: 1,
    method: "DOM.getDocument",
    params: {},
    sessionId: "s1",
  } as CdpRequest);
}

describe("DOM replies from the page isolate", () => {
  it.each([
    ["shared children", chain(20, 2)],
    ["a cycle", cycle()],
    ["a deep chain", chain(600, 1)],
    ["an over-budget array", documentWith(node({ children: Array(2 ** 21) }))],
    ["an accessor", accessorChildren()],
  ])("rejects a reply graph with %s", async (_name, root) => {
    const target = makeTarget({ pageScript: makeStub({ getDocument: { root } }) });
    const error = await getDocument(target).then(
      () => null,
      (err: Error) => err,
    );
    expect(error?.message).toMatch(/DOM reply/);
  });

  it("keeps frame ids and strips sidecars from a valid tree", async () => {
    registerEnsurePageScript(() => null);
    const sidecar = () => [{ qualifiedName: "x", namespaceURI: "u", prefix: "x", localName: "x" }];
    const root = documentWith(
      node({
        attributeNamespaces: sidecar(),
        shadowRoots: [node({ attributeNamespaces: sidecar() })],
      }),
    );
    // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only getDocument is read.
    const dom = { getDocument: () => root } as unknown as DomHandle;
    const r = (await getDocument(makeTarget({ dom }))) as { root: CdpNode };
    const [frame, host] = r.root.children as CdpNode[];
    expect(frame?.frameId).toBe("child");
    expect(frame && "attributeNamespaces" in frame).toBe(false);
    expect(host && "attributeNamespaces" in ((host.shadowRoots as CdpNode[])[0] ?? {})).toBe(false);
  });
});
