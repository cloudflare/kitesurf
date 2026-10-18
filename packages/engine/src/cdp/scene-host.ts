// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Validates scene-host metadata and serves range-checked WebAssembly chunks over CDP.

import type { Protocol } from "devtools-protocol";
import { z } from "zod";
import type { CdpRequest } from "./types.ts";

const CHUNK_BYTES = 4 * 1024 * 1024;
const MANIFEST_BYTES = 16 * 1024;
const HOST_BYTES = 32 * 1024 * 1024;
const ASSET_BASE = "https://kitesurf.invalid/rbi/";
// Retain validated metadata, not I/O promises or Wasm bodies, for each CDP connection.
const manifests = new WeakMap<object, Protocol.Kitesurf.SceneHostManifest>();
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const Manifest = z.object({
  abi: z.number().int().positive(),
  wireVersion: z.number().int().nonnegative(),
  wasm: z.literal("scene_host.wasm"),
  sha256: Sha256,
  bytes: z.number().int().positive().max(HOST_BYTES),
  retainedFrames: z.boolean().optional(),
});
const ReadParams = z
  .object({
    sha256: Sha256,
    offset: z.number().int().nonnegative().max(HOST_BYTES),
    length: z.number().int().min(1).max(CHUNK_BYTES),
  })
  .strict();

async function readSpan(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) throw new Error("scene-host asset has no body");
  const reader = response.body.getReader();
  const bytes = new Uint8Array(limit);
  let written = 0;
  try {
    while (written < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      const take = Math.min(limit - written, value.byteLength);
      bytes.set(value.subarray(0, take), written);
      written += take;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return bytes.subarray(0, written);
}

async function manifest(
  assets: Pick<Fetcher, "fetch">,
  session: object,
): Promise<Protocol.Kitesurf.SceneHostManifest> {
  const cached = manifests.get(session);
  if (cached) return cached;
  const response = await assets.fetch(new Request(ASSET_BASE + "scene_host.json"));
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error("scene-host manifest is unavailable in this deployment");
  }
  const bytes = await readSpan(response, MANIFEST_BYTES + 1);
  if (bytes.byteLength > MANIFEST_BYTES) throw new Error("scene-host manifest is too large");
  const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const parsed = Manifest.safeParse(payload);
  if (!parsed.success) throw new Error("invalid deployed scene-host manifest");
  manifests.set(session, parsed.data);
  return parsed.data;
}

type SceneHostRequest = Extract<
  CdpRequest,
  { method: "Kitesurf.getSceneHostManifest" | "Kitesurf.readSceneHost" }
>;

export async function sceneHostCommand(
  assets: Pick<Fetcher, "fetch">,
  req: SceneHostRequest,
  session: object,
): Promise<Protocol.Kitesurf.SceneHostManifest | Protocol.Kitesurf.ReadSceneHostResponse> {
  if (req.method === "Kitesurf.getSceneHostManifest") return manifest(assets, session);
  const parsed = ReadParams.safeParse(req.params);
  if (!parsed.success) throw new Error("invalid scene-host chunk parameters");
  const { sha256, offset, length } = parsed.data;
  const info = await manifest(assets, session);
  if (sha256 !== info.sha256) throw new Error("scene-host hash changed; request a new manifest");
  if (offset >= info.bytes) throw new Error("scene-host offset is outside the artifact");
  const count = Math.min(length, info.bytes - offset);
  const end = offset + count - 1;
  const response = await assets.fetch(
    new Request(ASSET_BASE + "scene_host.wasm", {
      headers: { Range: `bytes=${offset}-${end}`, "Accept-Encoding": "identity" },
    }),
  );
  if (response.status !== 200 && response.status !== 206) {
    await response.body?.cancel();
    throw new Error("scene-host Wasm is unavailable in this deployment");
  }
  // Re-reading the full prefix for every chunk makes downloads quadratic.
  if (response.status === 200 && offset !== 0) {
    await response.body?.cancel();
    throw new Error("scene-host asset ignored the range request");
  }
  if (
    response.status === 206 &&
    response.headers.get("Content-Range") !== `bytes ${offset}-${end}/${info.bytes}`
  ) {
    await response.body?.cancel();
    throw new Error("scene-host asset returned an unexpected range");
  }
  const bytes = await readSpan(response, count);
  if (bytes.byteLength !== count) throw new Error("scene-host asset returned a short chunk");
  return {
    sha256: info.sha256,
    offset,
    totalBytes: info.bytes,
    dataB64: bytes.toBase64(),
  };
}
