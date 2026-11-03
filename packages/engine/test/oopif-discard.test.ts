// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { discardPrespawnedFrame } from "../src/eval/oopif-render.ts";

function prespawned() {
  const events: string[] = [];
  const stub = {
    async unload() {
      events.push("unload");
      return { ok: true as const, console: [], cookieWrites: [] };
    },
    close() {
      events.push("close");
    },
    killIsolate(_reason?: string, opts?: { atOnce?: boolean }) {
      events.push(opts?.atOnce ? "kill:atOnce" : "kill");
    },
  };
  return { pre: { stub, warmup: Promise.resolve() } as never, events };
}

describe("discardPrespawnedFrame", () => {
  it("unloads a stale prespawned frame before killing it", async () => {
    const { pre, events } = prespawned();
    await discardPrespawnedFrame(pre, "oopif prespawn stale");
    expect(events).toEqual(["unload", "close", "kill"]);
  });

  it("kills it at once when nothing will read the frame again", async () => {
    const { pre, events } = prespawned();
    await discardPrespawnedFrame(pre, "engine WS closed", true);
    expect(events).toEqual(["close", "kill:atOnce"]);
  });
});
