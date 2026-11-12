// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { remoteObjectFromValue } from "../src/cdp/runtime.ts";

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
