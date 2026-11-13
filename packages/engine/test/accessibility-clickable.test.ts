// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, it } from "vitest";

import { ACTIVATION_HANDLER_ATTRS } from "../src/cdp/accessibility.ts";

// Loaded by path at run time: a static import would put dom-shim's sources under this
// package's compiler options, which they are not written for.
const DISPATCH = new URL("../../dom-shim/src/events/dispatch.ts", import.meta.url).href;

// The page lists the elements with a listener for these events and the engine reads the handler
// attributes off the DOM: an event added to one list only would make the two forms disagree.
it("reads a handler attribute for each event whose listener makes a node clickable", async () => {
  const dispatch: unknown = await import(/* @vite-ignore */ DISPATCH);
  const types: unknown = Reflect.get(Object(dispatch), "ACTIVATION_EVENT_TYPES");
  if (!(types instanceof Set)) throw new Error("dom-shim no longer exports its activation events");
  expect(ACTIVATION_HANDLER_ATTRS).toEqual([...types].map((type) => `on${String(type)}`));
});
