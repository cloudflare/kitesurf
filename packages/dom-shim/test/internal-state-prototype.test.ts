// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { afterEach, expect, it } from "vitest";
import { installCurrentScriptHook } from "../src/current-script.js";
import { createInternalState, getInternalState } from "../src/internal-state.js";

const KEYS = [
  "currentScriptSrc",
  "currentScriptDomIndex",
  "currentScriptBodyKey",
  "currentScriptRawSrc",
];
const receivers: unknown[] = [];

afterEach(() => {
  for (const key of KEYS) delete (Object.prototype as Record<string, unknown>)[key];
  receivers.length = 0;
});

it("internal state writes never reach a setter on Object.prototype", () => {
  for (const key of KEYS) {
    Object.defineProperty(Object.prototype, key, {
      configurable: true,
      set(this: unknown) {
        receivers.push(this);
      },
    });
  }
  installCurrentScriptHook();
  const state = getInternalState();
  state.setCurrentScript!("https://a.test/a.js", 1, "body", "/a.js");
  state.setCurrentScript!(null);
  expect(receivers).toEqual([]);
  expect(state.currentScriptSrc).toBeUndefined();
  expect(Object.getPrototypeOf(createInternalState())).toBeNull();
});
