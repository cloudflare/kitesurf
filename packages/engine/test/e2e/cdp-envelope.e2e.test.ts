// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, engine, test } from "./harness";
import { openCdpWireSession } from "./cdp-wire";

test("a malformed envelope gets -32600 and echoes the id", async () => {
  const { ws, next } = await openCdpWireSession(engine);
  const invalid = { code: -32600, message: "Invalid Request" };

  ws.send(JSON.stringify({ id: "abc", method: "Browser.getVersion" }));
  expect(await next()).toEqual({ id: "abc", error: invalid });

  ws.send(JSON.stringify({ id: 1, method: "Browser.getVersion", sessionId: 7 }));
  expect(await next()).toEqual({ id: 1, error: invalid });

  ws.send(JSON.stringify({ id: 2, method: "Browser.getVersion", params: "x" }));
  expect(await next()).toEqual({ id: 2, error: invalid });

  ws.send(JSON.stringify([1, 2]));
  expect(await next()).toEqual({ id: 0, error: invalid });

  ws.send("{");
  expect(await next()).toMatchObject({ id: 0, error: { code: -32700 } });

  ws.send(JSON.stringify({ id: 3, method: "Browser.getVersion", params: null, sessionId: null }));
  expect(await next()).toMatchObject({ id: 3, result: { product: expect.any(String) } });
  ws.close();
});

test.each([undefined, null])("Debugger.getScriptSource rejects %s params", async (params) => {
  const { ws, next } = await openCdpWireSession(engine);
  try {
    ws.send(JSON.stringify({ id: 1, method: "Debugger.getScriptSource", params }));
    expect(await next()).toEqual({
      id: 1,
      error: {
        code: -32000,
        message: "Cannot read properties of undefined (reading 'scriptId')",
      },
    });

    ws.send(
      JSON.stringify({
        id: 2,
        method: "Debugger.getScriptSource",
        params: { scriptId: "unknown-script" },
      }),
    );
    expect(await next()).toEqual({ id: 2, result: { scriptSource: "" } });
  } finally {
    ws.close();
  }
});

test("Kitesurf.setOutboundFilters rejects a non-string filter entry", async () => {
  const { ws, next } = await openCdpWireSession(engine);
  ws.send(
    JSON.stringify({
      id: 1,
      method: "Kitesurf.setOutboundFilters",
      params: { allowRequestPattern: ["^https://a/", null] },
    }),
  );
  expect(await next()).toEqual({
    id: 1,
    result: { ok: false, error: "allowRequestPattern must be an array of strings" },
  });

  ws.send(
    JSON.stringify({
      id: 2,
      method: "Kitesurf.setOutboundFilters",
      params: { allowRequestPattern: ["^https://a/"] },
    }),
  );
  expect(await next()).toEqual({ id: 2, result: { ok: true } });
  ws.close();
});
