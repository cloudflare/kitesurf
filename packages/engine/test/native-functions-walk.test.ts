// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";

import {
  installNativeToString,
  markEngineFunctions,
} from "../../page-script/src/native-functions.ts";

const source = (fn: unknown): string => Function.prototype.toString.call(fn);

function unnamed(): () => void {
  return [() => {}][0] ?? (() => {});
}

describe("markEngineFunctions", () => {
  it("survives entries whose name, prototype or prototype chain throw", () => {
    installNativeToString();
    const boom = (): never => {
      throw new Error("exotic");
    };
    const badName = unnamed();
    Object.defineProperty(badName, "name", { get: boom });
    const badPrototype = new Proxy(function () {}, {
      get: (t, k) => (k === "prototype" ? boom() : Reflect.get(t, k)),
    });
    const badChain = new Proxy({}, { getPrototypeOf: boom });
    const sibling = unnamed();
    const root = { badName, badPrototype, badChain, sibling };
    expect(() =>
      markEngineFunctions([root, new Proxy({}, { getPrototypeOf: boom })]),
    ).not.toThrow();
    expect(source(sibling)).toBe("function sibling() { [native code] }");
  });

  it("does not walk into arrays or typed arrays", () => {
    installNativeToString();
    const inArray = unnamed();
    const inBytes = unnamed();
    const list: unknown[] = [];
    const bytes = new Uint8Array(4);
    Object.defineProperty(list, "probe", { get: inArray });
    Object.defineProperty(bytes, "probe", { get: inBytes });
    markEngineFunctions([{ list, bytes }]);
    expect(source(inArray)).not.toContain("[native code]");
    expect(source(inBytes)).not.toContain("[native code]");
  });
});
