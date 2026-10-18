// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";

export const wsEcho = new Hono();

wsEcho.all("/ws-echo", (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return c.text("expected websocket upgrade", 426);
  }
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.addEventListener("message", async (event) => {
    const data: unknown = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
    if (data === "close-me") {
      server.close(4001, "bye");
    } else if (typeof data === "string") {
      server.send("echo:" + data);
    } else if (data instanceof ArrayBuffer) {
      server.send(data);
    }
  });
  return new Response(null, { status: 101, webSocket: client });
});
