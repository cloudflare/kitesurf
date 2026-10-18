// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import { directExternalFetch, type ExternalOutbound } from "../src/eval/external-outbound.ts";

function outbound(reply: Response) {
  const seen: Request[] = [];
  const stub: ExternalOutbound & { seen: Request[] } = {
    seen,
    async fetch(req) {
      seen.push(req);
      return reply.clone();
    },
  };
  return stub;
}

describe("directExternalFetch", () => {
  it("uses the host egress hook exclusively when present", async () => {
    const stub = outbound(new Response("h1{}", { status: 200 }));
    const resp = await directExternalFetch(
      stub,
      new Request("https://127.0.0.1:1/app.css", {
        headers: { accept: "text/css" },
      }),
    );
    expect(await resp.text()).toBe("h1{}");
    expect(stub.seen[0]!.url).toBe("https://127.0.0.1:1/app.css");
    expect(stub.seen[0]!.headers.get("accept")).toBe("text/css");
  });

  it("passes the host's error response through untouched", async () => {
    const stub = outbound(
      new Response("unavailable", {
        status: 503,
        headers: { "x-host-reason": "unavailable" },
      }),
    );
    const resp = await directExternalFetch(stub, new Request("https://unreachable.example/"));
    expect(resp.status).toBe(503);
    expect(resp.headers.get("x-host-reason")).toBe("unavailable");
  });

  it("uses plain fetch when no host egress hook exists", async () => {
    await expect(
      directExternalFetch(undefined, new Request("https://127.0.0.1:1/unroutable")),
    ).rejects.toThrow();
  });
});
