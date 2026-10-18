// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { decodePng } from "./png";

test("renderer canvas pixels survive full, clipped, and interleaved external records", async ({
  page,
  cdpSession,
}) => {
  await page.setViewport({ width: 64, height: 64 });
  await setContent(
    page,
    `<!doctype html><style>body{margin:0}canvas{display:block}</style>
      <canvas width=64 height=64></canvas><script>
      const ctx = document.querySelector('canvas').getContext('2d');
      ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = '#0000ff'; ctx.fillRect(32, 0, 32, 64);
      </script>`,
  );
  const full = await decodePng(new Uint8Array(await page.screenshot()));
  expect([full.width, full.height]).toEqual([64, 64]);
  expect([...full.data.slice((16 * 64 + 16) * 4, (16 * 64 + 16) * 4 + 4)]).toEqual([
    255, 0, 0, 255,
  ]);
  expect([...full.data.slice((16 * 64 + 48) * 4, (16 * 64 + 48) * 4 + 4)]).toEqual([
    0, 0, 255, 255,
  ]);
  const session: { send(method: string, params?: unknown): Promise<unknown> } = cdpSession;
  const record = async () => {
    const reply = await session.send("Kitesurf.recordScene", { inlineResources: true });
    if (
      typeof reply !== "object" ||
      reply === null ||
      !("sceneB64" in reply) ||
      typeof reply.sceneB64 !== "string" ||
      !("resourceBatchB64" in reply) ||
      typeof reply.resourceBatchB64 !== "string"
    ) {
      throw new Error("Kitesurf.recordScene: expected sceneB64 and resourceBatchB64 strings");
    }
    return { sceneB64: reply.sceneB64, resourceBatchB64: reply.resourceBatchB64 };
  };
  const first = await record();
  const clipped = await decodePng(
    new Uint8Array(await page.screenshot({ clip: { x: 32, y: 0, width: 32, height: 32 } })),
  );
  expect([clipped.width, clipped.height]).toEqual([32, 32]);
  expect([...clipped.data.slice((16 * 32 + 16) * 4, (16 * 32 + 16) * 4 + 4)]).toEqual([
    0, 0, 255, 255,
  ]);
  const second = await record();
  expect(second.sceneB64).toBe(first.sceneB64);
  expect(second.resourceBatchB64).toBe(first.resourceBatchB64);
  expect(first.resourceBatchB64.length).toBeGreaterThan(0);
  const after = await decodePng(new Uint8Array(await page.screenshot()));
  expect(after.data).toEqual(full.data);
});
