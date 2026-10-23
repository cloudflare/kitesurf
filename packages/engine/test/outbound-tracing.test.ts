// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, it } from "vitest";
import { SandboxOutbound, type SandboxOutboundEnv } from "../src/eval/outbound.ts";
import { createLocalTracerForTest } from "../src/tracing-local.ts";

it("untraced requests do not exhaust the budget for a later traced request", async () => {
  const posted: string[] = [];
  const { tracer, exporter } = createLocalTracerForTest({
    binding: {
      fetch: async (_url: string, init?: RequestInit) => {
        posted.push(String(init?.body));
        return new Response("ok");
      },
    },
  });
  const bindings: SandboxOutboundEnv = {
    HOST_TRACER: tracer,
    FONT_ASSETS: { fetch: async () => new Response("font") },
  };
  const props = {
    pageOrigin: "https://kitesurf-fonts",
    connectionId: "outbound-untraced-budget-regression",
  };
  const request = () => new Request("https://kitesurf-fonts/outbound-tracing-test.otf");
  const moreThanSpanBudget = 251;
  for (let i = 0; i < moreThanSpanBudget; i++) {
    const response = await SandboxOutbound.handle(bindings, props, request());
    expect(await response.text()).toBe("font");
  }
  await tracer.runTraced("a".repeat(32), "root", {}, async () => {
    const response = await SandboxOutbound.handle(bindings, props, request());
    expect(await response.text()).toBe("font");
  });
  await exporter.flushNow();
  expect(posted).toHaveLength(1);
  for (const body of posted) {
    expect(JSON.parse(body)).toMatchObject({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: expect.arrayContaining([
                expect.objectContaining({ name: "root" }),
                expect.objectContaining({ name: "subresource.fetch" }),
              ]),
            },
          ],
        },
      ],
    });
  }
});
