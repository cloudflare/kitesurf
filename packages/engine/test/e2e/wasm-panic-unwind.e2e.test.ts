// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { env } from "cloudflare:test";
import { expect, test } from "vitest";

interface HandleState {
  nodeCount: number;
  isPoisoned: boolean;
}

interface PanicReport {
  before: HandleState;
  threw: boolean;
  after: HandleState;
}

test("a panic under a borrow guard unwinds and leaves the handle usable", async () => {
  const res = await env.CORE_WASM.fetch("https://core.invalid/panic-unwind");
  expect(res.status).toBe(200);
  const { before, threw, after } = (await res.json()) as PanicReport;
  expect(before.isPoisoned).toBe(false);
  expect(threw).toBe(true);
  expect(after).toEqual(before);
});
