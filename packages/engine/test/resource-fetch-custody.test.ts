// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { afterEach, expect, it, vi } from "vitest";

// The wasm-bindgen sibling is resolved from the Worker Loader's modules map at runtime.
vi.mock("../../page-script/src/wasm-glue.js", () => ({
  __setBridgeFetchResource: () => {},
  initSync: () => {},
  ks_bridge_install_desc_helpers: () => {},
  DomHandle: class {
    deliverResource(): boolean {
      return true;
    }
  },
}));

import { captureTrustedFetch } from "../../page-script/src/trusted-fetch.ts";

// Load the real loader and its shared state through Vitest's runtime resolver: static imports
// would add page-script and dom-shim sources to this package's type program under different
// compiler options.
const { fetchResource } = (await vi.importActual("../../page-script/src/resource-fetch.ts")) as {
  fetchResource: (id: number, url: string, kind: string) => Promise<void>;
};
const { state } = (await vi.importActual("../../page-script/src/state.ts")) as {
  state: { dom: unknown };
};

const SHEET = "https://ks.invalid/opaque.css";
const realFetch = globalThis.fetch;
const realDom = state.dom;
const nativeMapGet = Map.prototype.get;

afterEach(() => {
  globalThis.fetch = realFetch;
  state.dom = realDom;
  Map.prototype.get = nativeMapGet;
});

it("keeps coalesced opaque results away from page hooks", async () => {
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    return new Response("body{color:red}");
  }) as typeof globalThis.fetch;
  captureTrustedFetch();
  const dom = { deliverResource: () => true };
  state.dom = dom;

  // Both hooks forward through pre-captured intrinsics and record privileged values.
  const stolen: unknown[] = [];
  Map.prototype.get = function (this: Map<unknown, unknown>, key) {
    const value = Reflect.apply(nativeMapGet, this, [key]);
    if (typeof (value as { then?: unknown })?.then === "function") stolen.push("promise");
    return value;
  };
  (dom as { deliverResource: (id: number, bytes: Uint8Array) => boolean }).deliverResource = (
    _id,
    bytes,
  ) => (stolen.push(bytes), true);

  await Promise.all([fetchResource(1, SHEET, "Stylesheet"), fetchResource(2, SHEET, "Stylesheet")]);

  expect(stolen).toEqual([]);
  expect(fetches, "concurrent callers share one fetch").toBe(1);
});
