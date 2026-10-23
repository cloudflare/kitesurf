// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { afterEach, expect, it, vi } from "vitest";
import { forgetNodeIds, nodeIdName, stampedNames } from "../src/registries.js";
import { stampConnectedNamedGlobals, stampNamedGlobal } from "../src/window.js";

const DOCUMENT = 0;
const FIRST_OWNER = 1;
const SECOND_OWNER = 2;
const DETACHED_OWNER = 3;
const NAME = "registryNamedProbe";
const RENAMED = "registryRenamedProbe";
const connected = new Set([FIRST_OWNER, SECOND_OWNER]);

vi.mock("../src/state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/state.js")>()),
  dom: {
    documentNodeId: () => DOCUMENT,
    isInclusiveAncestor: (ancestor: number, node: number) =>
      ancestor === DOCUMENT && connected.has(node),
    nodeInfo: (node: number) =>
      node === DETACHED_OWNER ? { attributes: ["id", NAME] } : undefined,
    querySelectorAllInSubtree: () => [],
  },
}));

afterEach(() => {
  for (const owner of [FIRST_OWNER, SECOND_OWNER, DETACHED_OWNER]) nodeIdName.delete(owner);
  connected.delete(DETACHED_OWNER);
  for (const name of [NAME, RENAMED]) {
    Reflect.deleteProperty(globalThis, name);
    stampedNames.delete(name);
  }
});

it("keeps a shared name until its last owner is forgotten", () => {
  stampNamedGlobal(FIRST_OWNER, NAME);
  stampNamedGlobal(SECOND_OWNER, NAME);
  const getter = Object.getOwnPropertyDescriptor(globalThis, NAME)?.get;
  expect(getter).toBeTypeOf("function");
  forgetNodeIds([FIRST_OWNER]);
  expect(Object.getOwnPropertyDescriptor(globalThis, NAME)?.get).toBe(getter);
  expect(stampedNames.get(NAME)?.nodeIds).toEqual(new Set([SECOND_OWNER]));
  forgetNodeIds([SECOND_OWNER]);
  expect(Object.getOwnPropertyDescriptor(globalThis, NAME)).toBeUndefined();
  expect(stampedNames.has(NAME)).toBe(false);
  expect(nodeIdName.size).toBe(0);
});

it("prunes the old accessor when an owner is renamed", () => {
  stampNamedGlobal(FIRST_OWNER, NAME);
  stampNamedGlobal(FIRST_OWNER, RENAMED);
  expect(Object.getOwnPropertyDescriptor(globalThis, NAME)).toBeUndefined();
  expect([...stampedNames.keys()]).toEqual([RENAMED]);
  expect(nodeIdName.get(FIRST_OWNER)).toBe(RENAMED);
});

it("does not call or delete a page-defined getter during cleanup", () => {
  stampNamedGlobal(FIRST_OWNER, NAME);
  const getter = vi.fn(() => 7);
  Object.defineProperty(globalThis, NAME, { get: getter, configurable: true });
  forgetNodeIds([FIRST_OWNER]);
  expect(getter).not.toHaveBeenCalled();
  expect(Object.getOwnPropertyDescriptor(globalThis, NAME)?.get).toBe(getter);
  expect(stampedNames.has(NAME)).toBe(false);
});

it("installs a detached owner's accessor only once the owner is connected", () => {
  stampNamedGlobal(DETACHED_OWNER, NAME);
  expect(NAME in globalThis).toBe(false);
  connected.add(DETACHED_OWNER);
  stampConnectedNamedGlobals(DETACHED_OWNER);
  expect(Object.getOwnPropertyDescriptor(globalThis, NAME)?.get).toBe(
    stampedNames.get(NAME)?.getter,
  );
});
