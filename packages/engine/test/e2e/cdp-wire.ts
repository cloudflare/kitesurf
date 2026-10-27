// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

interface CfWebSocket {
  accept(): void;
  send(message: string): void;
  close(): void;
  addEventListener(type: string, callback: (event: { data: string | ArrayBuffer }) => void): void;
}

function isCfWebSocket(value: unknown): value is CfWebSocket {
  return (
    typeof value === "object" &&
    value !== null &&
    "accept" in value &&
    typeof value.accept === "function" &&
    "send" in value &&
    typeof value.send === "function" &&
    "close" in value &&
    typeof value.close === "function" &&
    "addEventListener" in value &&
    typeof value.addEventListener === "function"
  );
}

function isCdpReply(message: unknown): message is { id: unknown } {
  return typeof message === "object" && message !== null && "id" in message;
}

function receiveCdpMessage(
  event: { data: string | ArrayBuffer },
  waiters: Array<(message: unknown) => void>,
  queue: unknown[],
): void {
  const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
  const message: unknown = JSON.parse(text);
  if (!isCdpReply(message)) return;
  const waiter = waiters.shift();
  if (waiter) waiter(message);
  else queue.push(message);
}

export async function openCdpWireSession(engine: {
  fetch: typeof fetch;
}): Promise<{ ws: CfWebSocket; next: () => Promise<unknown> }> {
  const response = await engine.fetch("https://ks.invalid/devtools/browser", {
    headers: { Upgrade: "websocket" },
  });
  const socket: unknown = Reflect.get(response, "webSocket");
  if (!isCfWebSocket(socket)) {
    throw new Error(`no webSocket (status ${response.status})`);
  }
  socket.accept();
  const queue: unknown[] = [];
  const waiters: Array<(message: unknown) => void> = [];
  socket.addEventListener("message", (event) => receiveCdpMessage(event, waiters, queue));
  const next = () =>
    queue.length > 0
      ? Promise.resolve(queue.shift())
      : new Promise<unknown>((resolve) => waiters.push(resolve));
  return { ws: socket, next };
}
