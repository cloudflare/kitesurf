// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { env } from "cloudflare:test";

import { upgradedSocket } from "./connect";
import { expect, test } from "./harness";

// A client behind a proxy cannot close the engine's socket itself; it waits for the drop.
test("Browser.close replies, then the engine closes the socket", async () => {
  const resp = await env.ENGINE.fetch("https://ks.invalid/devtools/browser", {
    headers: { Upgrade: "websocket" },
  });
  const ws = upgradedSocket(resp);
  if (!ws) throw new Error(`no webSocket on /devtools/browser (status ${resp.status})`);
  ws.accept();

  const order: string[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.addEventListener("close", (ev: { code: number; reason: string }) => {
      order.push("close");
      resolve({ code: ev.code, reason: ev.reason });
    });
  });
  ws.addEventListener("message", (ev: { data: string | ArrayBuffer }) => {
    const data = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
    const msg = JSON.parse(data) as { id?: number; result?: unknown };
    if (msg.id === 1) order.push(`reply:${JSON.stringify(msg.result)}`);
  });

  ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
  const { code, reason } = await Promise.race([
    closed,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`socket still open; saw ${order.join(",")}`)), 5_000),
    ),
  ]);

  expect(order).toEqual(["reply:{}", "close"]);
  expect(code).toBe(1000);
  expect(reason).toBe("Browser.close");
});
