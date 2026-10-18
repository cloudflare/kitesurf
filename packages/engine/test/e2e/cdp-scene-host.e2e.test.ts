// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "vitest";
import { upgradedSocket } from "./connect";
import { engine } from "./harness";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function connection() {
  const response = await engine.fetch("https://ks.invalid/devtools/browser", {
    headers: { Upgrade: "websocket" },
  });
  const ws = upgradedSocket(response);
  if (!ws) throw new Error(`CDP upgrade failed: ${response.status}`);
  ws.accept();
  let nextId = 0;
  const send = (method: string, params: Record<string, unknown> = {}) => {
    const id = ++nextId;
    return new Promise<{
      result?: Record<string, unknown>;
      error?: { message: string };
    }>((resolve) => {
      const receive = (event: { data: string | ArrayBuffer }) => {
        if (typeof event.data !== "string") return;
        const payload: unknown = JSON.parse(event.data);
        if (!isRecord(payload) || payload.id !== id) return;
        const result = payload.result;
        const error = payload.error;
        ws.removeEventListener("message", receive);
        resolve({
          ...(isRecord(result) ? { result } : {}),
          ...(isRecord(error) && typeof error.message === "string"
            ? { error: { message: error.message } }
            : {}),
        });
      };
      ws.addEventListener("message", receive);
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  return { ws, send };
}

test("CDP supplies its deployed manifest and Wasm before page attachment", async () => {
  const { ws, send } = await connection();
  try {
    const reply = await send("Kitesurf.getSceneHostManifest");
    expect(reply.error).toBeUndefined();
    const manifest = reply.result;
    if (!manifest || typeof manifest.sha256 !== "string" || typeof manifest.bytes !== "number") {
      throw new Error("invalid scene-host manifest");
    }
    const httpManifest: unknown = await (
      await engine.fetch("https://ks.invalid/rbi/scene_host.json")
    ).json();
    expect(manifest).toEqual(httpManifest);
    const received = new Uint8Array(manifest.bytes);
    const chunkBytes = 4 * 1024 * 1024;
    for (let offset = 0; offset < received.length; offset += chunkBytes) {
      const chunk = await send("Kitesurf.readSceneHost", {
        sha256: manifest.sha256,
        offset,
        length: chunkBytes,
      });
      expect(chunk.error).toBeUndefined();
      expect(chunk.result).toMatchObject({
        sha256: manifest.sha256,
        offset,
        totalBytes: manifest.bytes,
      });
      if (typeof chunk.result?.dataB64 !== "string") throw new Error("missing Wasm chunk");
      const bytes = Uint8Array.from(atob(chunk.result.dataB64), (c) => c.charCodeAt(0));
      expect(bytes.length).toBe(Math.min(chunkBytes, received.length - offset));
      received.set(bytes, offset);
    }
    const deployed = await (
      await engine.fetch("https://ks.invalid/rbi/scene_host.wasm")
    ).arrayBuffer();
    expect(received).toEqual(new Uint8Array(deployed));
    const smallChunk = await send("Kitesurf.readSceneHost", {
      sha256: manifest.sha256,
      offset: 2,
      length: 4,
    });
    // The local assets binding ignores Range; never re-read the prefix to emulate it.
    expect(smallChunk.error).toMatchObject({
      message: "scene-host asset ignored the range request",
    });
    const hash = await crypto.subtle.digest("SHA-256", received);
    expect(Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("")).toBe(
      manifest.sha256,
    );
  } finally {
    ws.close();
  }
});

test("CDP scene-host reads reject invalid ranges, hashes, and asset paths", async () => {
  const { ws, send } = await connection();
  try {
    const manifest = (await send("Kitesurf.getSceneHostManifest")).result;
    if (!manifest || typeof manifest.sha256 !== "string" || typeof manifest.bytes !== "number") {
      throw new Error("invalid scene-host manifest");
    }
    for (const invalid of [
      { offset: -1 },
      { offset: 0.5 },
      { offset: "0" },
      { offset: manifest.bytes },
      { length: 0 },
      { length: 4 * 1024 * 1024 + 1 },
      { length: 1.5 },
      { sha256: "0".repeat(64) },
      { sha256: "../../other" },
      { path: "/fonts/NotoSans.ttf" },
    ]) {
      const reply = await send("Kitesurf.readSceneHost", {
        sha256: manifest.sha256,
        offset: 0,
        length: 16,
        ...invalid,
      });
      expect(reply.error, JSON.stringify(invalid)).toBeDefined();
    }
    const font = await engine.fetch("https://ks.invalid/rbi/fonts/NotoSans.ttf");
    await font.body?.cancel();
    expect(font.status).toBe(200);
  } finally {
    ws.close();
  }
});

test("RBI font assets revalidate matching ETags", async () => {
  const url = "https://ks.invalid/rbi/fonts/NotoSans.ttf";
  const font = await engine.fetch(url);
  const etag = font.headers.get("etag");
  await font.body?.cancel();
  expect(font.status).toBe(200);
  if (!etag) throw new Error("font asset did not provide an ETag");

  const revalidated = await engine.fetch(url, { headers: { "If-None-Match": etag } });
  await revalidated.body?.cancel();
  expect(revalidated.status).toBe(304);
  expect(revalidated.headers.get("etag")).toBe(etag);
});
