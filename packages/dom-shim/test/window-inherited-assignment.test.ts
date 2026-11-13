// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { afterEach, beforeEach, expect, it } from "vitest";
import type { DocumentImpl } from "../src/document.js";
import { installWindow, type ShimWindow } from "../src/window.js";

type Bag = Record<PropertyKey, unknown>;

const GLOBALS = [
  "fetch",
  "Headers",
  "Request",
  "Response",
  "inheritedProbe",
  "pageAccessor",
  "proxiedProbe",
];
let saved: Map<string, PropertyDescriptor | undefined>;
let win: ShimWindow;

beforeEach(() => {
  saved = new Map(GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  win = installWindow({} as DocumentImpl).window;
});

afterEach(() => {
  for (const [name, desc] of saved) {
    if (desc) Object.defineProperty(globalThis, name, desc);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function heirOf(proto: object): Bag {
  return Object.create(proto) as Bag;
}

it("keeps a ponyfill's fetch, Headers, Request and Response on its own scope object", () => {
  const native = { fetch, Headers, Request, Response };
  const windowFetch = win.fetch;
  const scope = heirOf(win);
  scope.fetch = false;
  expect(Object.getOwnPropertyNames(scope)).toEqual(["fetch"]);
  expect(scope.fetch).toBe(false);
  const polyfill = { fetch() {}, Headers() {}, Request() {}, Response() {} };
  if (!scope.fetch) Object.assign(scope, polyfill);
  expect(scope.Request).toBe(polyfill.Request);
  expect({ fetch, Headers, Request, Response }).toEqual(native);
  expect(win.fetch).toBe(windowFetch);
  expect(win.Headers).toBe(native.Headers);
});

it("shadows a page global and an unknown name on the inheriting object", () => {
  Reflect.set(globalThis, "inheritedProbe", "page");
  const heir = heirOf(win);
  heir.inheritedProbe = "heir";
  heir.heirOnly = 1;
  expect(Reflect.get(globalThis, "inheritedProbe")).toBe("page");
  expect(heir.inheritedProbe).toBe("heir");
  expect("heirOnly" in win).toBe(false);
  expect(Object.getOwnPropertyDescriptor(heir, "heirOnly")).toEqual({
    value: 1,
    writable: true,
    enumerable: true,
    configurable: true,
  });
});

it("refuses read-only members and brand-checks event handler setters", () => {
  const heir = heirOf(win);
  expect(Reflect.set(heir, "document", 1)).toBe(false);
  expect(Reflect.set(heir, "NaN", 1)).toBe(false);
  expect(Object.getOwnPropertyNames(heir)).toEqual([]);
  expect(() => {
    heir.onload = () => {};
  }).toThrow(TypeError);
  expect(win.onload).toBe(null);
});

it("calls a page-defined window setter with the inheriting object", () => {
  let seen: unknown;
  Object.defineProperty(win, "pageAccessor", {
    configurable: true,
    get() {
      return 0;
    },
    set(this: unknown) {
      seen = this;
    },
  });
  const heir = heirOf(win);
  heir.pageAccessor = 1;
  expect(seen).toBe(heir);
});

it("still writes through the window and a transparent Proxy over it", () => {
  win.inheritedProbe = "window";
  expect(Reflect.get(globalThis, "inheritedProbe")).toBe("window");
  const view = new Proxy(win, {});
  view.proxiedProbe = "proxy";
  expect(Reflect.get(globalThis, "proxiedProbe")).toBe("proxy");
});
