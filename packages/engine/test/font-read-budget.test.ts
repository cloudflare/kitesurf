// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, it } from "vitest";
import { SandboxOutbound, type SandboxOutboundEnv } from "../src/eval/outbound.ts";
import { inFlightReadBytes, readCappedBudgeted } from "../src/read-capped.ts";

it("releases the charge of a capped read whose replay is never read", async () => {
  const body = new ReadableStream<Uint8Array>({
    pull: (c) => c.enqueue(new Uint8Array(1024)),
  });
  const got = await readCappedBudgeted(body, 2048, "font-read-abandoned");
  expect([got.failure, inFlightReadBytes()]).toEqual(["cap", 0]);
  await got.rest?.cancel();
});

it("charges the shared budget while a font body is in flight", async () => {
  let release: (() => void) | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(256).fill(7));
    },
    async pull(c) {
      await new Promise<void>((r) => (release = r));
      c.close();
    },
  });
  const pending = SandboxOutbound.handle(
    {} as SandboxOutboundEnv,
    {
      connectionId: "font-read-budget",
      pageOrigin: "https://page.test",
      externalOutbound: { fetch: async () => new Response(body) },
    },
    new Request("https://page.test/f.woff2", {
      headers: { "x-kitesurf-resource-type": "Font" },
    }),
  );
  await expect.poll(() => inFlightReadBytes()).toBe(256);
  release!();
  await pending;
  expect(inFlightReadBytes()).toBe(0);
});
