// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, it, vi } from "vitest";
import { DOMParser } from "../src/parser.js";

// The wasm handle is opaque to this suite, so a stand-in carries its identity: what
// matters is that no handle reaches a prototype method the page can replace.
const fake = vi.hoisted(() => {
  interface FakeNode {
    nodeType: number;
    nodeName: string;
    localName: string;
    nodeValue: string;
    attributes: string[];
    parent: number;
    children: number[];
  }
  class FakeHandle {
    nodes: FakeNode[] = [];
    constructor(_html = "", _baseUrl = "") {
      this.nodes.push(
        this.node(9, "#document"),
        this.node(1, "HTML", "html"),
        this.node(1, "BODY", "body"),
        this.node(1, "B", "b", "hi"),
        this.node(1, "I", "i", "yo"),
      );
      this.nodes[0].children = [1];
      this.nodes[1].children = [2];
      this.nodes[2].children = [3, 4];
      this.nodes[1].parent = 0;
      this.nodes[2].parent = 1;
      this.nodes[3].parent = 2;
      this.nodes[4].parent = 2;
      this.nodes[3].attributes = ["data-x", "1"];
    }
    node(nodeType: number, nodeName: string, localName = "", nodeValue = ""): FakeNode {
      return { nodeType, nodeName, localName, nodeValue, attributes: [], parent: -1, children: [] };
    }
    documentNodeId(): number {
      return 0;
    }
    nodeInfo(id: number): FakeNode | null {
      return this.nodes[id] ?? null;
    }
    childIds(id: number): number[] {
      return this.nodes[id]?.children ?? [];
    }
    parentId(id: number): number {
      return this.nodes[id]?.parent ?? -1;
    }
    textContent(id: number): string {
      return this.nodes[id]?.nodeValue ?? "";
    }
    querySelector(selector: string): number {
      return selector === "b" ? 3 : -1;
    }
    querySelectorAll(selector: string): number[] {
      return selector === "body" ? [2] : [];
    }
    querySelectorAllInSubtree(_id: number, selector: string): number[] {
      return selector === "b" ? [3] : [];
    }
    createElement(tag: string): number {
      this.nodes.push(this.node(1, tag.toUpperCase(), tag));
      return this.nodes.length - 1;
    }
    createTextNode(text: string): number {
      this.nodes.push(this.node(3, "#text", "", text));
      return this.nodes.length - 1;
    }
    setAttribute(id: number, name: string, value: string): void {
      const node = this.nodes[id];
      if (node) node.attributes.push(name, value);
    }
    appendChildNode(parent: number, child: number): void {
      const parentNode = this.nodes[parent];
      const childNode = this.nodes[child];
      if (!parentNode || !childNode) return;
      parentNode.children.push(child);
      childNode.parent = parent;
    }
  }
  return { FakeHandle, dom: new FakeHandle() };
});

vi.mock("../src/state.js", async (original) => ({
  ...(await original<typeof import("../src/state.js")>()),
  dom: fake.dom,
}));

it("parser caches never pass a handle to a replaced WeakMap or WeakSet method", () => {
  const seen: string[] = [];
  const restorers: Array<() => void> = [];
  const hook = (owner: object, key: string, label: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (!descriptor || typeof descriptor.value !== "function") return;
    const native = descriptor.value as Function;
    Object.defineProperty(owner, key, {
      configurable: true,
      writable: true,
      value: function (this: object, ...args: unknown[]) {
        if (args.some((arg) => arg instanceof fake.FakeHandle)) seen.push(label);
        return Reflect.apply(native, this, args);
      },
    });
    restorers.push(() => Object.defineProperty(owner, key, descriptor));
  };
  hook(WeakMap.prototype, "get", "WeakMap.get");
  hook(WeakMap.prototype, "set", "WeakMap.set");
  hook(WeakSet.prototype, "has", "WeakSet.has");
  hook(WeakSet.prototype, "add", "WeakSet.add");

  let parserCalls = 0;
  let controlCalls = 0;
  try {
    const first = new DOMParser().parseFromString('<b data-x="1">hi</b>', "text/html");
    const bold = first.querySelector("b")!;
    void bold.textContent;
    void bold.nextSibling;
    void first.documentElement;
    void first.childNodes;

    const second = new DOMParser().parseFromString("<p>yo</p>", "text/html");
    const target = second.body!;
    target.appendChild(bold);
    void bold.parentNode;
    void bold.getAttribute("data-x");
    void bold.nextSibling;

    const xml = new DOMParser().parseFromString("<svg/>", "image/svg+xml");
    void xml.documentElement;

    parserCalls = seen.length;

    // Positive control: the hooks do see a handle on a plain WeakMap and WeakSet.
    const probe = new fake.FakeHandle();
    const map = new WeakMap<object, number>();
    map.set(probe, 1);
    map.get(probe);
    const set = new WeakSet<object>();
    set.add(probe);
    set.has(probe);
    controlCalls = seen.length - parserCalls;
  } finally {
    for (const restore of restorers) restore();
  }

  expect(controlCalls).toBe(4);
  expect(seen.slice(0, parserCalls)).toEqual([]);
});

it("parser handle finalizer never calls a page-replaced register", () => {
  const seen: unknown[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(FinalizationRegistry.prototype, "register");
  if (!descriptor || typeof descriptor.value !== "function") {
    throw new Error("FinalizationRegistry.prototype.register is unavailable");
  }
  const native = descriptor.value as (...args: unknown[]) => unknown;
  let parserCalls = 0;
  let controlCalls = 0;
  Object.defineProperty(FinalizationRegistry.prototype, "register", {
    configurable: true,
    writable: true,
    value: function (this: unknown, ...args: unknown[]) {
      if (args.some((arg) => arg instanceof fake.FakeHandle)) seen.push(args[0]);
      return Reflect.apply(native, this, args);
    },
  });
  try {
    new DOMParser().parseFromString("<p>x</p>", "text/html");
    parserCalls = seen.length;
    // Positive control: the hook does see a handle registered directly.
    new FinalizationRegistry(() => {}).register(new fake.FakeHandle(), 1);
    controlCalls = seen.length - parserCalls;
  } finally {
    Object.defineProperty(FinalizationRegistry.prototype, "register", descriptor);
  }
  // The registry is created at module load; `register` must be captured there too.
  expect(parserCalls).toBe(0);
  expect(controlCalls).toBe(1);
});
