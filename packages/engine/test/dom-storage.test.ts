// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import { storageIdOrigin } from "../src/cdp/dom-storage.ts";

const A = "https://a.test";

describe("storageIdOrigin", () => {
  it.each([
    [
      { securityOrigin: A, isLocalStorage: true },
      { origin: A, isLocalStorage: true },
    ],
    [
      { storageKey: `${A}/`, isLocalStorage: false },
      { origin: A, isLocalStorage: false },
    ],
    [
      { securityOrigin: "https://b.test", storageKey: `${A}/`, isLocalStorage: true },
      { origin: A, isLocalStorage: true },
    ],
  ])("reads %j", (id, expected) => {
    expect(storageIdOrigin(id)).toEqual(expected);
  });

  it.each([
    [null, "Invalid storageId format"],
    [{ securityOrigin: A }, "Invalid storageId format"],
    [{ securityOrigin: 1, isLocalStorage: true }, "Invalid storageId format"],
    [{ securityOrigin: "", isLocalStorage: true }, "Invalid storageId format"],
    [{ storageKey: `${A}/^0https://b.test`, isLocalStorage: true }, "Partitioned storage keys"],
    [{ securityOrigin: "about:blank", isLocalStorage: true }, "Frame not found"],
    [{ securityOrigin: "not a url", isLocalStorage: true }, "Frame not found"],
  ])("rejects %j", (id, message) => {
    expect(() => storageIdOrigin(id)).toThrow(message);
  });
});
