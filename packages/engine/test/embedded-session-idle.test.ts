// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";

import { handleWebSocket } from "../src/cdp/connection.ts";
import type { CdpRequest, CdpResponse } from "../src/cdp/types.ts";

const IDLE_MS = 1000;
const POLL_MS = 200;

interface Limits {
  maxSessionMs?: number;
  exemptIdleDeadline?: boolean;
}

async function openEmbeddedSession(limits: Limits = {}) {
  let dispatch: ((req: CdpRequest) => Promise<CdpResponse>) | undefined;
  const cap = limits.maxSessionMs === undefined ? "" : `&ksMaxSessionMs=${limits.maxSessionMs}`;
  const resp = await handleWebSocket(
    new Request(`https://ks.invalid/devtools/browser?ksIdleMs=${IDLE_MS}${cap}`, {
      headers: { Upgrade: "websocket" },
    }),
    env,
    createExecutionContext(),
    undefined,
    {
      exemptIdleDeadline: limits.exemptIdleDeadline === true,
      onDispatch: (fn) => {
        dispatch = fn;
      },
    },
  );
  const ws = resp.webSocket;
  if (!ws || !dispatch) throw new Error(`no embedded session (status ${resp.status})`);
  ws.accept();
  let open = true;
  const closed = new Promise<{ reason: string; at: number }>((resolve) => {
    ws.addEventListener("close", (ev) => {
      open = false;
      resolve({ reason: ev.reason, at: Date.now() });
    });
  });
  // A test that fails early would otherwise leave the session's timers running for their
  // whole budget, holding the worker open after the file is done.
  const close = () => {
    if (open) ws.close(1000, "test over");
  };
  return { dispatch, closed, isOpen: () => open, close };
}

async function dispatchFor(
  session: Awaited<ReturnType<typeof openEmbeddedSession>>,
  ms: number,
): Promise<number> {
  const started = Date.now();
  let lastSentAt = started;
  for (let id = 1; Date.now() - started < ms && session.isOpen(); id++) {
    lastSentAt = Date.now();
    await session.dispatch({ id, method: "Target.getTargets" });
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return lastSentAt;
}

test("commands through the embedder's dispatch renew the idle clock until they stop", async () => {
  const session = await openEmbeddedSession();
  try {
    const started = Date.now();
    let lastSentAt = started;
    for (let id = 1; Date.now() - started < 3 * IDLE_MS; id++) {
      lastSentAt = Date.now();
      const res = await session.dispatch({ id, method: "Target.getTargets" });
      expect(res).toMatchObject({ id, result: { targetInfos: expect.any(Array) } });
      expect(session.isOpen()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    expect(session.isOpen()).toBe(true);

    const ev = await session.closed;
    expect(ev.reason).toContain("idle");
    expect(ev.at - lastSentAt).toBeGreaterThanOrEqual(IDLE_MS);
  } finally {
    session.close();
  }
}, 20_000);

// The dispatch renews the idle clock only. Renewing the session's start as well would keep a
// busy embedder's session open past its wall-clock cap, and nothing else bounds it.
test("commands do not move the session's wall-clock cap", async () => {
  const maxSessionMs = 2 * IDLE_MS;
  const session = await openEmbeddedSession({ maxSessionMs });
  const opened = Date.now();
  try {
    await dispatchFor(session, 4 * IDLE_MS);
    const ev = await session.closed;
    expect(ev.reason).toContain(`session exceeded ${maxSessionMs} ms`);
    expect(ev.at - opened).toBeLessThan(4 * IDLE_MS);
  } finally {
    session.close();
  }
}, 20_000);

test("a session exempt from the idle deadline stays open with no commands", async () => {
  const maxSessionMs = 3 * IDLE_MS;
  const session = await openEmbeddedSession({ maxSessionMs, exemptIdleDeadline: true });
  try {
    const ev = await session.closed;
    expect(ev.reason).toContain(`session exceeded ${maxSessionMs} ms`);
  } finally {
    session.close();
  }
}, 20_000);
