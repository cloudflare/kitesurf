// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { engineIsolateId, isForeignIsolate } from "../src/eval/isolate-id.ts";

describe("engine isolate identity", () => {
  it("is stable for the life of the isolate", () => {
    expect(engineIsolateId()).toBe(engineIsolateId());
  });

  it("recognises its own stamp", () => {
    expect(isForeignIsolate(engineIsolateId())).toBe(false);
  });

  it("flags another isolate's stamp as foreign", () => {
    expect(isForeignIsolate(crypto.randomUUID())).toBe(true);
  });

  it("treats a missing stamp as local: callers with no owning session", () => {
    expect(isForeignIsolate(undefined)).toBe(false);
    expect(isForeignIsolate("")).toBe(false);
  });
});
