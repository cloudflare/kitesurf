// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";

import { handleAccessibility } from "../src/cdp/accessibility.ts";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import type { TargetState } from "../src/cdp/types.ts";
import type { PageScriptStub } from "../src/eval/page-script.ts";

interface FakeNode {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  localName?: string;
  nodeValue: string;
  attributes?: string[];
  children?: FakeNode[];
}

interface AxNode {
  ignored: boolean;
  backendDOMNodeId: number;
  role?: { value: unknown };
  name?: { value: unknown };
  ignoredReasons?: Array<{ name: string }>;
}

let nextId = 1;

function el(tag: string, attrs: Record<string, string>, children: FakeNode[] = []): FakeNode {
  const id = nextId++;
  return {
    nodeId: id,
    backendNodeId: id,
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    localName: tag,
    nodeValue: "",
    attributes: Object.entries(attrs).flat(),
    children,
  };
}

function text(value: string): FakeNode {
  const id = nextId++;
  return { nodeId: id, backendNodeId: id, nodeType: 3, nodeName: "#text", nodeValue: value };
}

const icon = el("span", { "aria-hidden": "true" }, [text("decorative icon")]);
const skip = el("button", { "aria-hidden": "true" }, [text("Skip")]);
const trap = el("div", { tabindex: "-1" }, [
  el("input", { "aria-label": "To" }),
  el("button", {}, [text("Send"), icon]),
]);
const dialog = el("div", { role: "dialog", "aria-label": "Compose" }, [trap]);
const app = el("div", { "aria-hidden": "true" }, [el("button", {}, [text("Outside")]), dialog]);
const elsewhere = el("button", {}, [text("Elsewhere")]);
const body = el("body", {}, [app, elsewhere, skip]);
const html = el("html", {}, [body]);
const doc: FakeNode = { ...el("#document", {}, [html]), nodeType: 9 };

type FakeTarget = Partial<TargetState>;

function newTarget(): FakeTarget {
  return {
    type: "page",
    sessions: new Set<string>(),
    blankReady: null,
    frameId: "F",
    url: "",
    navigateGeneration: 1,
  };
}

async function axTree(focused: FakeNode[], target: FakeTarget = newTarget()): Promise<AxNode[]> {
  const focusPath = [...focused, body, html, doc].map((n) => n.backendNodeId);
  const stub = {
    async queryDom(method: string) {
      if (method === "getDocument") return { root: doc };
      if (method === "notRenderedNodeIds") return { displayNone: [], invisible: [], focusPath };
      return {};
    },
  };
  // handleAccessibility calls only queryDom; PageScriptStub also carries the
  // isolate lifecycle and render-port RPCs that this unit fixture never invokes.
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- partial PageScript fixture.
  target.pageScript = stub as unknown as PageScriptStub;
  const ctx = { browser: { targets: new Map([["t", target]]) } } as DispatchCtx;
  const reply = await handleAccessibility(ctx, { id: 1, method: "Accessibility.getFullAXTree" });
  const nodes: unknown = Reflect.get(Object(reply), "nodes");
  if (!Array.isArray(nodes)) throw new Error("getFullAXTree returned no nodes");
  return nodes;
}

function exposed(nodes: AxNode[]): string[] {
  return nodes
    .filter((n) => !n.ignored && ["button", "textbox", "dialog"].includes(String(n.role?.value)))
    .map((n) => `${String(n.role?.value)}:${String(n.name?.value ?? "")}`);
}

function reasonsOf(nodes: AxNode[], node: FakeNode): string[] {
  const ax = nodes.find((n) => n.backendDOMNodeId === node.backendNodeId);
  return (ax?.ignoredReasons ?? []).map((r) => r.name);
}

describe("aria-hidden on the focus path", () => {
  it("hides an aria-hidden subtree that does not hold focus", async () => {
    const nodes = await axTree([elsewhere]);
    expect(exposed(nodes)).toEqual(["button:Elsewhere"]);
    expect(reasonsOf(nodes, app)).toEqual(["ariaHiddenElement"]);
    expect(reasonsOf(nodes, dialog)).toEqual(["ariaHiddenSubtree"]);
  });

  it("exposes an aria-hidden ancestor of the focused element and its other descendants", async () => {
    const nodes = await axTree([trap, dialog, app]);
    expect(exposed(nodes)).toEqual([
      "button:Outside",
      "dialog:Compose",
      "textbox:To",
      "button:Send",
      "button:Elsewhere",
    ]);
    expect(reasonsOf(nodes, app)).toEqual([]);
    expect(reasonsOf(nodes, icon)).toEqual(["ariaHiddenElement"]);
  });

  it("exposes a focused element that is itself aria-hidden", async () => {
    const nodes = await axTree([skip]);
    expect(exposed(nodes)).toEqual(["button:Elsewhere", "button:Skip"]);
    expect(reasonsOf(nodes, app)).toEqual(["ariaHiddenElement"]);
  });

  // Chrome discards the mark for good, so the tree does not flip back when focus moves on, and
  // the ids it remembers are one document's.
  it("keeps an ancestor exposed after focus leaves it, until the next document", async () => {
    const target = newTarget();
    expect(reasonsOf(await axTree([trap, dialog, app], target), app)).toEqual([]);
    const after = await axTree([elsewhere], target);
    expect(reasonsOf(after, app)).toEqual([]);
    expect(reasonsOf(after, skip)).toEqual(["ariaHiddenElement"]);

    target.navigateGeneration = 2;
    expect(reasonsOf(await axTree([elsewhere], target), app)).toEqual(["ariaHiddenElement"]);
  });
});
