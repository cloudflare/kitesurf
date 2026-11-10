// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, it } from "vitest";
import { SandboxOutbound, type SandboxOutboundEnv } from "../src/eval/outbound.ts";

it.each(["same-origin", "same-site"])("enforces %s CORP on a tainted script", async (policy) => {
  const response = await SandboxOutbound.handle(
    {} as SandboxOutboundEnv,
    {
      pageOrigin: "https://attacker.test",
      externalOutbound: {
        fetch: async () =>
          new Response("private()", {
            headers: { "cross-origin-resource-policy": policy },
          }),
      },
    },
    new Request("https://victim.test/script.js", {
      headers: {
        "x-kitesurf-page-origin": "null",
        "x-kitesurf-resource-type": "Script",
        "x-kitesurf-script-cors": "no-cors",
        "x-kitesurf-allow-cross-origin": "1",
      },
    }),
  );
  expect(response.status).toBe(403);
  expect(response.headers.get("x-kitesurf-blocked")).toBe("cors");
});
