// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { afterEach, describe, expect, it } from "vitest";
import {
  compileOutboundFilters,
  registerOutboundFilters,
  unregisterOutboundFilters,
} from "../src/cdp/outbound-filter-registry.ts";
import {
  SandboxOutbound,
  type OutboundProps,
  type SandboxOutboundEnv,
} from "../src/eval/outbound.ts";

const CONN = "ws-conn";

async function handshake(headers: Record<string, string>, props: Partial<OutboundProps> = {}) {
  const seen: Request[] = [];
  const resp = await SandboxOutbound.handle(
    {} as SandboxOutboundEnv,
    {
      connectionId: CONN,
      cookieKey: CONN,
      pageOrigin: "https://page.test",
      mainFrameId: "F",
      externalOutbound: {
        fetch: async (req: Request) => {
          seen.push(req);
          return new Response("reached");
        },
      },
      ...props,
    },
    new Request("https://socket.test/echo", { headers: { Upgrade: "websocket", ...headers } }),
  );
  return { status: resp.status, seen };
}

describe("WebSocket handshakes and outbound filters", () => {
  afterEach(() => unregisterOutboundFilters(CONN));

  const register = (rules: Parameters<typeof compileOutboundFilters>[0]) => {
    const compiled = compileOutboundFilters(rules);
    if (!compiled.ok) throw new Error(compiled.error);
    registerOutboundFilters(CONN, compiled.filters);
  };

  it.each(["Fetch", "Image", ""])("classifies a handshake labelled %j as websocket", async (t) => {
    register({ rejectResourceTypes: ["websocket"] });
    const { status, seen } = await handshake(t ? { "x-kitesurf-resource-type": t } : {});
    expect(status).toBe(451);
    expect(seen).toEqual([]);
  });

  it("does not let a fetch-only allow list admit a handshake", async () => {
    register({ allowResourceTypes: ["fetch"] });
    expect((await handshake({ "x-kitesurf-resource-type": "Fetch" })).status).toBe(451);
  });

  it("lets a websocket allow list admit a handshake", async () => {
    register({ allowResourceTypes: ["websocket"] });
    const { seen } = await handshake({ "x-kitesurf-resource-type": "Fetch" });
    expect(seen.map((r) => r.url)).toEqual(["https://socket.test/echo"]);
  });
});
