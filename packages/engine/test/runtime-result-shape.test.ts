// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import type { PackedResult } from "@kitesurf/jsrpc-types/shared";
import { remoteObjectFromValue } from "../src/cdp/runtime.ts";
import { pageScriptResultToCdp } from "../src/eval/page-script.ts";

const packed = (fields: Partial<PackedResult> & Pick<PackedResult, "type">): PackedResult => ({
  ok: true,
  serializationError: null,
  ...fields,
});

const OBJECT = packed({
  type: "object",
  className: "Object",
  description: "Object",
  valueJson: '{"a":1}',
  objectId: "obj-1",
});
const ARRAY = packed({
  type: "object",
  subtype: "array",
  className: "Array",
  description: "Array(2)",
  valueJson: "[1,2]",
  objectId: "obj-2",
});
const ERROR = packed({
  type: "object",
  subtype: "error",
  className: "RangeError",
  description: "RangeError: r",
  valueJson: "{}",
  objectId: "obj-3",
});
const FUNCTION = packed({
  type: "function",
  className: "Function",
  description: "function named() {}",
  valueJson: "{}",
  objectId: "obj-4",
});
const UNDEFINED = packed({ type: "undefined", description: "undefined" });
const NULL = packed({ type: "object", subtype: "null", description: "null", valueJson: "null" });

describe("a result returned by value", () => {
  // The expected replies are what Chrome sends for the same expression with returnByValue: true,
  // recorded from Chrome rather than read off the protocol description.
  it.each([
    ["an object", OBJECT, { type: "object", value: { a: 1 } }],
    ["an array", ARRAY, { type: "object", value: [1, 2] }],
    ["an error", ERROR, { type: "object", value: {} }],
    ["a function", FUNCTION, { type: "function", value: {} }],
  ])("sends %s as its type and value alone", (_name, result, expected) => {
    expect(pageScriptResultToCdp(result, true)).toEqual({ result: expected });
  });

  it("keeps a number's description, which Chrome sends with the value", () => {
    const number = packed({ type: "number", description: "42", valueJson: "42" });
    expect(pageScriptResultToCdp(number, true)).toEqual({
      result: { type: "number", value: 42, description: "42" },
    });
  });

  it("still describes an object whose value could not be serialized", () => {
    const unserializable = packed({
      type: "object",
      className: "Window",
      description: "Window",
      serializationError: "cyclic",
      objectId: "obj-5",
    });
    expect(pageScriptResultToCdp(unserializable, true)).toEqual({
      result: { type: "object", className: "Window", description: "Window", objectId: "obj-5" },
    });
  });
});

describe("a result returned as a handle", () => {
  it.each([
    [
      "an object",
      OBJECT,
      { type: "object", className: "Object", description: "Object", objectId: "obj-1" },
    ],
    [
      "an array",
      ARRAY,
      {
        type: "object",
        subtype: "array",
        className: "Array",
        description: "Array(2)",
        objectId: "obj-2",
      },
    ],
    [
      "a function",
      FUNCTION,
      {
        type: "function",
        className: "Function",
        description: "function named() {}",
        objectId: "obj-4",
      },
    ],
  ])("still describes %s", (_name, result, expected) => {
    expect(pageScriptResultToCdp(result, false)).toEqual({ result: expected });
  });
});

describe.each([true, false])("undefined and null with returnByValue %s", (returnByValue) => {
  it("carry no description", () => {
    expect(pageScriptResultToCdp(UNDEFINED, returnByValue)).toEqual({
      result: { type: "undefined" },
    });
    expect(pageScriptResultToCdp(NULL, returnByValue)).toEqual({
      result: { type: "object", subtype: "null", value: null },
    });
  });
});

describe.each([true, false])("a literal answered with returnByValue %s", (returnByValue) => {
  it("gives null its subtype and no object id", () => {
    expect(remoteObjectFromValue(null, returnByValue)).toEqual({
      result: { type: "object", subtype: "null", value: null },
    });
  });

  it("describes a number", () => {
    expect(remoteObjectFromValue(42, returnByValue)).toEqual({
      result: { type: "number", value: 42, description: "42" },
    });
    expect(remoteObjectFromValue(1.5, returnByValue)).toEqual({
      result: { type: "number", value: 1.5, description: "1.5" },
    });
  });

  it("sends a string or a boolean as its type and value", () => {
    expect(remoteObjectFromValue("s", returnByValue)).toEqual({
      result: { type: "string", value: "s" },
    });
    expect(remoteObjectFromValue(true, returnByValue)).toEqual({
      result: { type: "boolean", value: true },
    });
  });
});
