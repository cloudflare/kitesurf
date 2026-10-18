// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test, vi } from "vitest";
import { sceneHostCommand } from "../src/cdp/scene-host.ts";

const wasm = new Uint8Array([0, 97, 115, 109, 1, 2, 3, 4]);
const info = {
  abi: 4,
  wireVersion: 16,
  wasm: "scene_host.wasm",
  sha256: "a".repeat(64),
  bytes: wasm.length,
};

// Control Range handling and malformed responses that a real asset binding may not produce.
function assets(status: number, body = wasm, manifest: unknown = info): Pick<Fetcher, "fetch"> {
  return {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith("scene_host.json")) {
        return Response.json(manifest);
      }
      expect(new URL(request.url).pathname).toBe("/rbi/scene_host.wasm");
      expect(request.headers.get("Range")).toBe("bytes=2-5");
      expect(request.headers.get("Accept-Encoding")).toBe("identity");
      return new Response(body, {
        status,
        headers: status === 206 ? { "Content-Range": `bytes 2-5/${info.bytes}` } : {},
      });
    },
  };
}

const read = {
  id: 1,
  method: "Kitesurf.readSceneHost",
  params: { sha256: info.sha256, offset: 2, length: 4 },
} as const;

test("scene-host accepts 4 MiB chunks and rejects oversized requests", async () => {
  const length = 4 * 1024 * 1024;
  const bytes = new Uint8Array(length + 73).fill(7);
  const binding = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith("scene_host.json")) {
        return Response.json({ ...info, bytes: bytes.length });
      }
      expect(request.headers.get("Range")).toBe(`bytes=0-${length - 1}`);
      return new Response(bytes);
    },
  };
  const reply = await sceneHostCommand(
    binding,
    { ...read, params: { ...read.params, offset: 0, length } },
    {},
  );
  if (!("dataB64" in reply)) throw new Error("missing chunk response");
  expect(atob(reply.dataB64).length).toBe(length);
  expect(reply.totalBytes).toBe(bytes.length);
  await expect(
    sceneHostCommand(
      binding,
      { ...read, params: { ...read.params, offset: 0, length: length + 1 } },
      {},
    ),
  ).rejects.toThrow("invalid scene-host chunk parameters");
});

test("scene-host metadata is cached only within its CDP connection", async () => {
  let manifestReads = 0;
  const binding = assets(206, wasm.slice(2, 6));
  const counted = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(new Request(input, init).url).pathname.endsWith("scene_host.json")) {
        manifestReads++;
      }
      return binding.fetch(input, init);
    },
  };
  const session = {};
  await sceneHostCommand(counted, { id: 1, method: "Kitesurf.getSceneHostManifest" }, session);
  await sceneHostCommand(counted, read, session);
  await sceneHostCommand(counted, read, session);
  expect(manifestReads).toBe(1);
  await sceneHostCommand(counted, read, {});
  expect(manifestReads).toBe(2);
});

test("scene-host chunks handle ranged asset-binding responses", async () => {
  const reply = await sceneHostCommand(assets(206, wasm.slice(2, 6)), read, {});
  expect(reply).toEqual({
    sha256: info.sha256,
    offset: 2,
    totalBytes: wasm.length,
    dataB64: btoa("sm\x01\x02"),
  });
});

test("scene-host rejects ignored nonzero ranges without reading the body", async () => {
  const response = new Response(wasm);
  if (!response.body) throw new Error("missing response body");
  const getReader = vi.spyOn(response.body, "getReader");
  const cancel = vi.spyOn(response.body, "cancel");
  const binding = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith("scene_host.json")) return Response.json(info);
      expect(request.headers.get("Range")).toBe("bytes=2-5");
      return response;
    },
  };
  await expect(sceneHostCommand(binding, read, {})).rejects.toThrow(
    "scene-host asset ignored the range request",
  );
  expect(getReader).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
});

test("scene-host chunks fail on stale hashes, missing and short assets", async () => {
  await expect(
    sceneHostCommand(
      assets(200),
      { ...read, params: { ...read.params, sha256: "b".repeat(64) } },
      {},
    ),
  ).rejects.toThrow("hash changed");
  await expect(sceneHostCommand(assets(404), read, {})).rejects.toThrow("unavailable");
  await expect(sceneHostCommand(assets(206, wasm.slice(2, 4)), read, {})).rejects.toThrow(
    "short chunk",
  );
});

test("scene-host manifests reject invalid or oversized deployment metadata", async () => {
  const invalidManifests = [
    { ...info, bytes: 0 },
    { ...info, bytes: 32 * 1024 * 1024 + 1 },
    { ...info, wasm: "../other.wasm" },
    { ...info, sha256: "bad" },
  ];
  for (const manifest of invalidManifests) {
    await expect(
      sceneHostCommand(
        assets(200, wasm, manifest),
        { id: 1, method: "Kitesurf.getSceneHostManifest" },
        {},
      ),
    ).rejects.toThrow("invalid deployed");
  }
  const oversized = { fetch: async () => new Response(" ".repeat(16 * 1024 + 1)) };
  await expect(
    sceneHostCommand(oversized, { id: 1, method: "Kitesurf.getSceneHostManifest" }, {}),
  ).rejects.toThrow("too large");
  const missing = { fetch: async () => new Response(null, { status: 404 }) };
  await expect(
    sceneHostCommand(missing, { id: 1, method: "Kitesurf.getSceneHostManifest" }, {}),
  ).rejects.toThrow("unavailable");
});
