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

let nextId = 1;

function el(tag: string, attrs: Record<string, string>, children: FakeNode[] = []): FakeNode {
  const id = nextId++;
  const flat = Object.entries(attrs).flat();
  return {
    nodeId: id,
    backendNodeId: id,
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    localName: tag,
    nodeValue: "",
    attributes: flat,
    children,
  };
}

function text(value: string): FakeNode {
  const id = nextId++;
  return { nodeId: id, backendNodeId: id, nodeType: 3, nodeName: "#text", nodeValue: value };
}

function option(label: string, attrs: Record<string, string> = {}): FakeNode {
  return el("option", attrs, [text(label)]);
}

async function valueOf(select: FakeNode): Promise<unknown> {
  const doc: FakeNode = {
    ...el("#document", {}, [el("html", {}, [el("body", {}, [select])])]),
    nodeType: 9,
  };
  const stub = {
    async queryDom(method: string) {
      if (method === "getDocument") return { root: doc };
      if (method === "notRenderedNodeIds") return { displayNone: [], invisible: [] };
      return {};
    },
  };
  const target: Partial<TargetState> = {
    type: "page",
    sessions: new Set<string>(),
    // handleAccessibility calls only queryDom; PageScriptStub also carries the
    // isolate lifecycle and render-port RPCs that this unit fixture never invokes.
    // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- partial PageScript fixture.
    pageScript: stub as unknown as PageScriptStub,
    blankReady: null,
    frameId: "F",
    url: "",
  };
  const ctx = { browser: { targets: new Map([["t", target]]) } } as DispatchCtx;
  const reply = await handleAccessibility(ctx, { id: 1, method: "Accessibility.getFullAXTree" });
  const nodes: unknown = Reflect.get(Object(reply), "nodes");
  expect(Array.isArray(nodes)).toBe(true);
  if (!Array.isArray(nodes)) return undefined;
  const ax: unknown = nodes.find(
    (n: unknown) => Reflect.get(Object(n), "backendDOMNodeId") === select.backendNodeId,
  );
  return Reflect.get(Object(Reflect.get(Object(ax), "value")), "value");
}

describe("select value without live state", () => {
  it("takes the last option marked selected", async () => {
    expect(
      await valueOf(
        el("select", {}, [option("One", { selected: "" }), option("Two", { selected: "" })]),
      ),
    ).toBe("Two");
  });

  it("defaults to the first option whose optgroup is not disabled either", async () => {
    const select = el("select", {}, [
      el("optgroup", { label: "G", disabled: "" }, [option("Off")]),
      option("On"),
    ]);
    expect(await valueOf(select)).toBe("On");
  });

  it("gives a listbox no default choice", async () => {
    expect(await valueOf(el("select", { size: "3" }, [option("A"), option("B")]))).toBeUndefined();
  });

  it("still defaults a closed single select to its first enabled option", async () => {
    expect(
      await valueOf(el("select", { size: "1" }, [option("Nope", { disabled: "" }), option("Yes")])),
    ).toBe("Yes");
  });
});
