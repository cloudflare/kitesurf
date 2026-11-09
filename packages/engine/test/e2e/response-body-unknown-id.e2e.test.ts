// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, engine, test } from "./harness";
import { openCdpWireSession } from "./cdp-wire";
import { setContent } from "./set-content";

test("Network.getResponseBody fails for an id the engine never issued", async () => {
  const { ws, next } = await openCdpWireSession(engine);
  ws.send(
    JSON.stringify({
      id: 1,
      method: "Network.getResponseBody",
      params: { requestId: "never-issued" },
    }),
  );
  expect(await next()).toEqual({
    id: 1,
    error: { code: -32000, message: "No resource with given identifier found" },
  });
  ws.close();
});

test("Network.getResponseBody still answers a request the engine issued", async ({
  page,
  cdpSession: cdp,
}) => {
  await cdp.send("Network.enable");
  let documentId = "";
  cdp.on("Network.responseReceived", (e) => {
    if (e.type === "Document") documentId = e.requestId;
  });
  await setContent(page, "<p>kept</p>");
  expect(documentId).not.toBe("");
  const kept = await cdp.send("Network.getResponseBody", { requestId: documentId });
  expect(kept.body).toContain("<p>kept</p>");
});
