// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { afterEach, beforeEach, expect, it, vi } from "vitest";

// A stand-in for the wasm DOM: the id a node carries, the ids under a node, the connected nodes,
// and the flat attribute list of each. `getElementById` answers the first connected node with
// that id, as blitz's id map does, so a name leaves it when its last owner does.
const DOC_ID = 1;
const state = vi.hoisted(() => ({
  ids: new Map<number, string>(),
  subtrees: new Map<number, number[]>(),
  connected: new Set<number>(),
  wrappers: new Map<number, unknown>(),
  attributes: new Map<number, string[]>(),
}));

vi.mock("../src/state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/state.js")>();
  return {
    ...actual,
    elementFor: (nodeId: number) => state.wrappers.get(nodeId) ?? null,
    get dom() {
      return {
        documentNodeId: () => DOC_ID,
        isInclusiveAncestor: (ancestor: number, nodeId: number) =>
          ancestor === DOC_ID && (nodeId === DOC_ID || state.connected.has(nodeId)),
        idAttribute: (nodeId: number) => state.ids.get(nodeId) ?? null,
        getElementById: (name: string) => {
          for (const [nodeId, id] of state.ids) {
            if (id === name && state.connected.has(nodeId)) return nodeId;
          }
          return -1;
        },
        attributeList: (nodeId: number) => ({
          attributes: state.attributes.get(nodeId) ?? [],
        }),
        querySelectorAllInSubtree: (rootId: number) => state.subtrees.get(rootId) ?? [],
        querySelectorAll: () =>
          [...state.ids.keys()].filter((nodeId) => state.connected.has(nodeId)),
      };
    },
  };
});

import {
  installConnectedNamedGlobals,
  installNamedPropertiesObject,
  syncNamedGlobals,
} from "../src/window.js";

const NAME = "lazyNamedProbe";
const NODE = 11;
let originalProto: object | null = null;

beforeEach(() => {
  originalProto = Object.getPrototypeOf(globalThis);
  state.ids.clear();
  state.subtrees.clear();
  state.connected.clear();
  state.wrappers.clear();
  state.attributes.clear();
});

afterEach(() => {
  Object.setPrototypeOf(globalThis, originalProto);
  state.ids.clear();
  state.subtrees.clear();
  state.connected.clear();
  state.wrappers.clear();
  state.attributes.clear();
  Reflect.deleteProperty(globalThis, NAME);
  Reflect.deleteProperty(globalThis, "namedProbeSloppy");
});

const globalValue = (name: string): unknown => Reflect.get(globalThis, name);

// An element with an id, in the document.
function connect(nodeId: number, name: string, value: unknown = { localName: "div" }): void {
  state.ids.set(nodeId, name);
  state.wrappers.set(nodeId, value);
  state.connected.add(nodeId);
}

// The same element out of the document: its id attribute stays, the id map stops answering it.
function detach(nodeId: number): void {
  state.connected.delete(nodeId);
}

it("resolves a live id without defining an own global", () => {
  const element = { localName: "div" };
  connect(NODE, NAME, element);
  installNamedPropertiesObject();
  installConnectedNamedGlobals(NODE);

  expect(globalValue(NAME)).toBe(element);
  expect(NAME in globalThis).toBe(true);
  // Chrome keeps named properties off the global's own-property surface.
  expect(Object.getOwnPropertyDescriptor(globalThis, NAME)).toBeUndefined();
  expect(Object.keys(globalThis)).not.toContain(NAME);
  expect(Object.getOwnPropertyNames(globalThis)).not.toContain(NAME);
});

it("hides an id that is not in the document", () => {
  installNamedPropertiesObject();
  state.ids.set(NODE, NAME);
  installConnectedNamedGlobals(NODE);

  expect(NAME in globalThis).toBe(false);
  expect(globalValue(NAME)).toBeUndefined();
  expect(Object.getOwnPropertyDescriptor(globalThis, NAME)).toBeUndefined();
});

it("drops the accessor when the id leaves the document", () => {
  installNamedPropertiesObject();
  const first = { localName: "div" };
  connect(NODE, NAME, first);
  installConnectedNamedGlobals(NODE);
  expect(globalValue(NAME)).toBe(first);

  detach(NODE);
  syncNamedGlobals(NODE);
  expect(NAME in globalThis).toBe(false);
  expect(globalValue(NAME)).toBeUndefined();

  const second = { localName: "span" };
  connect(NODE, NAME, second);
  installConnectedNamedGlobals(NODE);
  expect(globalValue(NAME)).toBe(second);
});

it("keeps the accessor while another owner of the id is connected", () => {
  installNamedPropertiesObject();
  const first = { localName: "div" };
  const second = { localName: "span" };
  connect(NODE, NAME, first);
  connect(NODE + 1, NAME, second);
  installConnectedNamedGlobals(NODE);
  installConnectedNamedGlobals(NODE + 1);
  expect(globalValue(NAME)).toBe(first);

  // The id map answers the first owner in the document until it goes.
  detach(NODE);
  syncNamedGlobals(NODE);
  expect(NAME in globalThis).toBe(true);
  expect(globalValue(NAME)).toBe(second);

  detach(NODE + 1);
  syncNamedGlobals(NODE + 1);
  expect(NAME in globalThis).toBe(false);
});

it("installs the ids a subtree brings in", () => {
  installNamedPropertiesObject();
  const child = { localName: "p" };
  state.ids.set(NODE, "");
  connect(NODE + 1, NAME, child);
  state.subtrees.set(NODE, [NODE + 1]);
  state.connected.add(NODE);
  installConnectedNamedGlobals(NODE);

  expect(globalValue(NAME)).toBe(child);
});

it("keeps an existing global over a same-named id", () => {
  installNamedPropertiesObject();
  connect(NODE, "Object", { localName: "div" });
  installConnectedNamedGlobals(NODE);

  expect(globalValue("Object")).toBe(Object);
  expect(globalValue(NAME)).toBeUndefined();
});

it("never installs over a prototype member", () => {
  installNamedPropertiesObject();
  const element = { localName: "div" };
  connect(NODE, "toString", element);
  installConnectedNamedGlobals(NODE);

  expect(globalValue("toString")).toBe(Object.prototype.toString);
});

it("lets an assignment shadow the named property", () => {
  installNamedPropertiesObject();
  connect(NODE, NAME, { localName: "div" });
  installConnectedNamedGlobals(NODE);

  Reflect.set(globalThis, NAME, 7);
  expect(Object.getOwnPropertyDescriptor(globalThis, NAME)?.value).toBe(7);
  expect(globalValue(NAME)).toBe(7);
});

// Chrome's named property is writable, so an assignment makes an own data property on the
// receiver. A getter-only accessor would throw TypeError in strict code and drop the value in
// sloppy code.
it("assigns an own property in strict and sloppy code", () => {
  installNamedPropertiesObject();
  const element = { localName: "div" };
  connect(NODE, NAME, element);
  installConnectedNamedGlobals(NODE);

  expect(() => Function(`"use strict"; ${NAME} = 1;`)()).not.toThrow();
  expect(Object.getOwnPropertyDescriptor(globalThis, NAME)).toEqual({
    value: 1,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  expect(globalValue(NAME)).toBe(1);
  // The element is still connected, so the named property is still behind the own property.
  expect(state.wrappers.get(NODE)).toBe(element);
  Reflect.deleteProperty(globalThis, NAME);
  expect(globalValue(NAME)).toBe(element);

  Function(`${NAME} = 2;`)();
  expect(Object.getOwnPropertyDescriptor(globalThis, NAME)?.value).toBe(2);
  expect(globalValue(NAME)).toBe(2);
});

// The iframe's name is read from wasm, so a page-replaced getAttribute cannot answer for it.
it("returns an iframe contentWindow for an iframe id with a matching name", () => {
  const contentWindow = {};
  connect(NODE, NAME, { localName: "iframe", contentWindow });
  state.attributes.set(NODE, ["id", NAME, "name", NAME]);
  installNamedPropertiesObject();
  installConnectedNamedGlobals(NODE);

  expect(globalValue(NAME)).toBe(contentWindow);
});

it("does not expose numeric, underscore, or dollar names", () => {
  installNamedPropertiesObject();
  for (const [index, name] of ["_probe", "$probe", "0"].entries()) {
    connect(NODE + index, name, { localName: "div" });
    installConnectedNamedGlobals(NODE + index);
  }

  for (const name of ["_probe", "$probe", "0"]) {
    expect(name in globalThis).toBe(false);
    expect(globalValue(name)).toBeUndefined();
  }
});

// The named-properties object must be an ordinary object: a Proxy in the global's prototype
// chain makes V8 resolve an unresolvable reference through `set` instead of throwing.
it("keeps an undeclared assignment a ReferenceError in strict code", () => {
  installNamedPropertiesObject();
  connect(NODE, NAME, { localName: "div" });
  installConnectedNamedGlobals(NODE);

  expect(() => Function('"use strict"; namedProbeUndeclared = 1;')()).toThrow(ReferenceError);
  expect(Object.hasOwn(globalThis, "namedProbeUndeclared")).toBe(false);

  // Sloppy code still creates the global, as it does without a named property in reach.
  Function("namedProbeSloppy = 1")();
  expect(Object.getOwnPropertyDescriptor(globalThis, "namedProbeSloppy")?.value).toBe(1);
});

it("installs once", () => {
  installNamedPropertiesObject();
  const installed = Object.getPrototypeOf(globalThis);
  installNamedPropertiesObject();

  expect(Object.getPrototypeOf(globalThis)).toBe(installed);
});

// A second document in one isolate keeps the object but none of the old document's names.
it("clears the previous document's names when a second document installs", () => {
  installNamedPropertiesObject();
  connect(NODE, NAME, { localName: "div" });
  installConnectedNamedGlobals(NODE);
  expect(globalValue(NAME)).not.toBeUndefined();

  state.ids.clear();
  state.connected.clear();
  installNamedPropertiesObject();

  expect(NAME in globalThis).toBe(false);
  expect(globalValue(NAME)).toBeUndefined();
});
