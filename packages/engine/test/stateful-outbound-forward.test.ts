// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import type { OutboundProps } from "../src/eval/outbound.ts";
import { forwardToStatefulSession } from "../src/state/outbound-forward.ts";

const SESSION = "a".repeat(64);
const props: OutboundProps = { pageOrigin: "https://ks.invalid", statefulSessionId: SESSION };

describe("forwardToStatefulSession", () => {
  it("leaves a stateless request to the loopback", () => {
    const request = new Request("https://ks.invalid/");
    expect(forwardToStatefulSession({}, { pageOrigin: "" }, request)).toBeNull();
  });

  it("fails a stateful request it cannot forward instead of sending it", async () => {
    const request = new Request("https://ks.invalid/", { method: "POST", body: "x" });
    const forwarded = forwardToStatefulSession({}, props, request);
    expect(forwarded).not.toBeNull();
    const response = await forwarded;
    expect(response?.status).toBe(502);
  });

  it("sends a stateful request to its session's object", async () => {
    let seen: Request | null = null;
    const exports = {
      StatefulBrowser: {
        idFromString: (id: string) => id,
        get: () => ({
          fetch: async (req: Request) => {
            seen = req;
            return new Response("ok");
          },
        }),
      },
    };
    const response = await forwardToStatefulSession(
      exports,
      props,
      new Request("https://ks.invalid/"),
    );
    expect(response?.status).toBe(200);
    expect(seen).not.toBeNull();
  });
});
