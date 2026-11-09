// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import { upgradedSocket } from "./connect";
import { engine } from "./harness";

async function upgradeStatus(origin?: string): Promise<number> {
  const headers: Record<string, string> = { upgrade: "websocket" };
  if (origin !== undefined) headers.origin = origin;
  const res = await engine.fetch(
    new Request("http://engine.test/devtools/browser/kitesurf", { headers }),
  );
  const ws = upgradedSocket(res);
  ws?.accept();
  ws?.close();
  return res.status;
}

describe("CDP upgrade origin check", () => {
  it("admits clients without an Origin, the engine's own origin and the bundled inspector", async () => {
    expect(await upgradeStatus()).toBe(101);
    expect(await upgradeStatus("http://engine.test")).toBe(101);
    expect(await upgradeStatus("devtools://devtools")).toBe(101);
  });

  it("refuses an upgrade from another web origin or an opaque one", async () => {
    expect(await upgradeStatus("https://page.example")).toBe(403);
    expect(await upgradeStatus("null")).toBe(403);
  });
});
