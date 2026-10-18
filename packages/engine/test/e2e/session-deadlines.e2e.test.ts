// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { env } from "cloudflare:test";

import { upgradedSocket, type WorkerdWebSocket } from "./connect";
import { expect, test } from "./harness";

async function openSession(query: string): Promise<WorkerdWebSocket> {
  const fetcher = env.ENGINE;
  const resp = await fetcher.fetch(`https://ks.invalid/devtools/browser${query}`, {
    headers: { Upgrade: "websocket" },
  });
  const ws = upgradedSocket(resp);
  if (!ws) throw new Error(`no webSocket (status ${resp.status})`);
  ws.accept();
  return ws;
}

function closeEvent(ws: WorkerdWebSocket): Promise<{ code?: number; reason?: string }> {
  return new Promise((resolve) => {
    ws.addEventListener("close", (ev) => resolve({ code: ev.code, reason: ev.reason }));
  });
}

test("an idle session is closed with a reason the client can read", async () => {
  const ws = await openSession("?ksIdleMs=600");
  const ev = await closeEvent(ws);
  expect(ev.code).toBe(1001);
  expect(ev.reason).toContain("idle");
}, 20_000);

test("page JS alone does not renew the idle clock", async () => {
  const ws = await openSession("?ksIdleMs=1500");
  const closed = closeEvent(ws);
  ws.send(
    JSON.stringify({
      id: 1,
      method: "Page.navigate",
      params: {
        url:
          "data:text/html," +
          encodeURIComponent("<script>setInterval(() => fetch('/'), 100)</script>"),
      },
    }),
  );
  const ev = await closed;
  expect(ev.reason).toContain("idle");
}, 30_000);

test("client traffic renews the idle clock, and the wall clock still fires", async () => {
  const ws = await openSession("?ksIdleMs=800&ksMaxSessionMs=3000");
  const closed = closeEvent(ws);
  let ticks = 0;
  const poll = setInterval(() => {
    ticks++;
    try {
      ws.send(JSON.stringify({ id: 100 + ticks, method: "Target.getTargets" }));
    } catch {}
  }, 300);
  const started = Date.now();
  const ev = await closed;
  clearInterval(poll);
  expect(Date.now() - started).toBeGreaterThan(1200);
  expect(ev.reason).toContain("session exceeded");
}, 30_000);
