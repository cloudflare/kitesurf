// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0
import { describe, expect, it } from "vitest";
import { buildTree } from "../src/cdp/accessibility.ts";
import { handleDom } from "../src/cdp/dom.ts";
import { registerEnsurePageScript } from "../src/cdp/page-session.ts";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import type { CdpRequest, TargetState } from "../src/cdp/types.ts";
import type { DomHandle } from "../src/wasm.ts";
type Node = Record<string, unknown>;
const node = (over: Node = {}): Node => ({ nodeId: 2, nodeType: 1, nodeName: "DIV", ...over });
const doc = (...children: unknown[]): Node =>
  node({ nodeId: 1, nodeType: 9, nodeName: "#document", children });
const chain = (depth: number, branch: number): Node => {
  let child = node();
  for (let i = 0; i < depth; i++) child = node({ children: Array(branch).fill(child) });
  return child;
};
// The page-side sanitizer keeps an own `contentDocument`, so a DAG there expands.
const dag = (): Node => ({ ...doc(), contentDocument: chain(17, 2) });
const loop = doc();
(loop.children as Node[]).push(loop);
const ps = (root: Node) => ({ queryDom: async () => ({ root }) });
// The accessibility tree is built in Rust from the document snapshot, so the snapshot is the
// only page-shaped graph the builder walks.
const TREE = JSON.stringify({
  nodes: [
    {
      nodeId: "root-F",
      ignored: false,
      role: { type: "internalRole", value: "RootWebArea" },
      name: { type: "computedString", value: "" },
      backendDOMNodeId: 0,
      childIds: [],
    },
  ],
});
function treeBuilder(root: Node) {
  const treeStream = () =>
    Promise.resolve({
      byteLength: new TextEncoder().encode(TREE).byteLength,
      json: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(TREE));
          controller.close();
        },
      }),
    });
  return {
    call: { getDocument: async () => ({ root }), accessibilityTree: treeStream },
    tryCall: {
      getDocument: async () => ({ root }),
      notRenderedNodeIds: async () => ({ displayNone: [], invisible: [] }),
      formStateSnapshot: async () => ({ values: [], checked: [], selected: [] }),
    },
  };
}
const treeTarget = (): TargetState =>
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the fields buildTree reads.
  ({ type: "page", frameId: "F", url: "", title: "" }) as unknown as TargetState;
// A wide reply: every element has one attribute and no children. Before the reply budget
// counted each array element twice this exceeded the node budget at roughly this size.
const wideDocument = (count: number): Node =>
  doc(
    ...Array.from({ length: count }, (_, i) =>
      node({
        nodeId: i + 3,
        backendNodeId: i + 3,
        localName: "div",
        nodeValue: "",
        childNodeCount: 0,
        attributes: ["data-x", "1"],
        children: [],
      }),
    ),
  );
// CDP sends attributes as a flat [name, value, …] array, so an ordinary element with many
// attributes is many property slots but one array. A 50k-element page with 96 entries is
// 5.2M properties and only 150k containers, which is what large list pages look like.
const attributedDocument = (elements: number, entries: number): Node => {
  const flat = Array.from({ length: entries }, (_, i) => (i % 2 === 0 ? `data-a${i}` : "v"));
  return doc(
    ...Array.from({ length: elements }, (_, i) =>
      node({
        nodeId: i + 3,
        backendNodeId: i + 3,
        localName: "div",
        nodeValue: "",
        childNodeCount: 0,
        attributes: flat.slice(),
        children: [],
      }),
    ),
  );
};
function call(handler: typeof handleDom, method: string, over: Record<string, unknown> = {}) {
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the fields these handlers read are set.
  const target = {
    sessions: new Set(["s1"]),
    domEnabledSessions: new Set<string>(),
    ...over,
  } as unknown as TargetState;
  const ctx = { browser: { targets: new Map([["t1", target]]) }, emit: () => {} };
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- partial dispatch fixture.
  return handler(ctx as unknown as DispatchCtx, { method, sessionId: "s1" } as CdpRequest);
}
describe("DOM replies from the page isolate", () => {
  it.each([
    ["an aliased DAG", handleDom, "DOM.getDocument", dag()],
    ["a cycle", handleDom, "DOM.getDocument", loop],
    // 600 levels is a legitimate document, so this now exceeds the raised reply depth limit.
    ["a deep chain", handleDom, "DOM.getDocument", doc(chain(900, 1))],
  ])("rejects a reply graph with %s", async (_name, handler, method, root) => {
    const error = await call(handler, method, { pageScript: ps(root), frames: new Map() }).then(
      () => null,
      (err: Error) => err,
    );
    expect(error?.message).toMatch(/DOM reply/);
  });
  it("rejects an aliased document snapshot in the accessibility tree builder", async () => {
    const error = await buildTree(treeBuilder(dag()), treeTarget()).then(
      () => null,
      (err: Error) => err,
    );
    expect(error?.message).toMatch(/DOM reply/);
  });
  it("accepts a wide document whose JSON is under the document cap", async () => {
    const root = wideDocument(100_000);
    const r = (await call(handleDom, "DOM.getDocument", {
      pageScript: ps(root),
      frames: new Map(),
    })) as { root: Node };
    expect((r.root.children as Node[]).length).toBe(100_000);
    expect(JSON.stringify(r).length).toBeLessThan(16 * 1024 * 1024);
  });
  it("accepts a page-shaped attributed document with 50k elements", async () => {
    const root = attributedDocument(50_000, 96);
    const r = (await call(handleDom, "DOM.getDocument", {
      pageScript: ps(root),
      frames: new Map(),
    })) as { root: Node };
    expect((r.root.children as Node[]).length).toBe(50_000);
  });
  it("rejects a reply with more containers than the budget", async () => {
    // 1.2M records plus the root and its children array is ~14% over the container budget.
    const root = doc();
    root.children = Array.from({ length: 1_200_000 }, () => node());
    const error = await call(handleDom, "DOM.getDocument", {
      pageScript: ps(root),
      frames: new Map(),
    }).then(
      () => null,
      (err: Error) => err,
    );
    expect(error?.message).toMatch(/is too large/);
  });
  it("rejects a reply with a sparse array", async () => {
    // A hole-only `children`, hidden from `Object.keys`, costs consumers one visit and
    // 21M JSON chars per slot.
    const children: Node[] = [];
    children.length = 4_194_304;
    const root = doc();
    Object.defineProperty(root, "children", { value: children, enumerable: false });
    const error = await call(handleDom, "DOM.getDocument", {
      pageScript: ps(root),
      frames: new Map(),
    }).then(
      () => null,
      (err: Error) => err,
    );
    expect(error?.message).toMatch(/sparse array/);
  });
  it("rejects a non-enumerable accessor without running it", async () => {
    // `annotateIframeFrameIds` reads `children` on every node it walks, so a hidden
    // accessor must be rejected before that walk and never invoked.
    let getterCalls = 0;
    const child = node();
    Object.defineProperty(child, "children", {
      enumerable: false,
      configurable: true,
      get() {
        getterCalls += 1;
        return [];
      },
    });
    const frames = new Map([["c", { frameId: "c", isCrossOrigin: true, ownerBackendNodeId: 17 }]]);
    const error = await call(handleDom, "DOM.getDocument", {
      pageScript: ps(doc(child)),
      frames,
    }).then(
      () => null,
      (err: Error) => err,
    );
    expect(error?.message).toMatch(/accessor/);
    expect(getterCalls).toBe(0);
  });
  it("accepts the symbol keys an RPC result carries", async () => {
    const root = doc(node());
    Object.defineProperty(root, Symbol.dispose, { value: () => {}, enumerable: false });
    const r = (await call(handleDom, "DOM.getDocument", {
      pageScript: ps(root),
      frames: new Map(),
    })) as { root: Node };
    expect(r.root).toBeDefined();
  });
  it("accepts nesting depth 600", async () => {
    const root = doc(chain(600, 1));
    const r = (await call(handleDom, "DOM.getDocument", {
      pageScript: ps(root),
      frames: new Map(),
    })) as { root: Node };
    expect(r.root).toBeTruthy();
  });
  it("accepts a document snapshot at nesting depth 600 in the tree builder", async () => {
    const built = await buildTree(treeBuilder(doc(chain(600, 1))), treeTarget());
    expect(built?.nodes.length).toBe(1);
  });
  it("keeps frame ids and strips sidecars from a valid tree", async () => {
    registerEnsurePageScript(() => null);
    const frame = { frameId: "child", isCrossOrigin: true, ownerBackendNodeId: 17 };
    const frames = new Map([["c", frame]]);
    const root = doc(node({ backendNodeId: 17, nodeName: "IFRAME", attributeNamespaces: [] }));
    // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only getDocument is stubbed.
    const dom = {
      documentBudgetError: () => null,
      getDocument: () => root,
    } as unknown as DomHandle;
    const r = (await call(handleDom, "DOM.getDocument", { dom, frames })) as { root: Node };
    expect((r.root.children as Node[])[0]?.frameId).toBe("child");
    expect(JSON.stringify(r.root)).not.toContain("attributeNamespaces");
  });
});
