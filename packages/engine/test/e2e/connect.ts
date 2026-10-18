// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Adapt @cloudflare/puppeteer to workerd's WebSocket with a plain CDP
// handshake, without Node `ws` or a session-acquire protocol.
import puppeteer from "@cloudflare/puppeteer";
import type { Browser, CDPSession } from "@cloudflare/puppeteer";
import { CdpCDPSession } from "@cloudflare/puppeteer/internal/cdp/CDPSession.js";
import type { WebSocket as WorkerdWebSocket } from "@cloudflare/workers-types";
import type { Protocol } from "devtools-protocol";

export type { WorkerdWebSocket };

export function upgradedSocket(resp: Response): WorkerdWebSocket | null {
  return (resp as Response & { webSocket?: WorkerdWebSocket | null }).webSocket ?? null;
}

function wrapWebSocket(ws: WorkerdWebSocket) {
  const transport: {
    send(m: string): void;
    close(): void;
    onmessage?: (m: string) => void;
    onclose?: () => void;
  } = {
    send: (m) => ws.send(m),
    close: () => ws.close(),
  };
  ws.addEventListener("message", (ev: { data: string | ArrayBuffer }) => {
    const data = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
    transport.onmessage?.(data);
  });
  ws.addEventListener("close", () => transport.onclose?.());
  return transport;
}

export async function connectEngine(
  fetcher: { fetch: typeof fetch },
  headers: Record<string, string> = {},
  query = "",
): Promise<Browser> {
  const resp = await fetcher.fetch(`https://ks.invalid/devtools/browser${query}`, {
    headers: { Upgrade: "websocket", ...headers },
  });
  const ws = upgradedSocket(resp);
  if (!ws) throw new Error(`no webSocket on /devtools/browser (status ${resp.status})`);
  ws.accept();
  return puppeteer.connect({ transport: wrapWebSocket(ws) as never });
}

export async function targetIdForSession(session: CDPSession): Promise<Protocol.Target.TargetID> {
  // Kitesurf resolves Target.getTargetInfo without an ID to the browser even on a page session.
  if (!(session instanceof CdpCDPSession)) {
    throw new TypeError("Expected a CDP session created by the engine harness");
  }
  return session._target()._targetId;
}
