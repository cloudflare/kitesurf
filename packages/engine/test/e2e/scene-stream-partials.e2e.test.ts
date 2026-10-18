// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { engine, expect, test } from "./harness";
import { decodePng } from "./png";
import { setContent } from "./set-content";
import { env } from "cloudflare:test";

test("scene patches composite through the CLI wasm and recover with full frames", async ({
  page,
  cdpSession,
}) => {
  const manifest = await (await engine.fetch("https://ks.invalid/rbi/scene_host.json")).json();
  expect(manifest).toHaveProperty("retainedFrames", true);
  const call = async (op: number, input: Uint8Array): Promise<Uint8Array> => {
    const response = await env.SCENE_HOST_WASM.fetch(`https://scene-host.invalid/${op}`, {
      method: "POST",
      body: input.slice().buffer,
    });
    return new Uint8Array(await response.arrayBuffer());
  };
  const input = (fields: number[], scene: Uint8Array) => {
    const bytes = new Uint8Array(fields.length * 4 + scene.length);
    const view = new DataView(bytes.buffer);
    fields.forEach((field, index) => view.setUint32(index * 4, field, true));
    bytes.set(scene, fields.length * 4);
    return bytes;
  };
  const frames: Uint8Array[] = [];
  const resources: Uint8Array[] = [];
  cdpSession.on("Kitesurf.sceneFrame", (event) => {
    const bytes = Uint8Array.from(atob(event.data), (char) => char.charCodeAt(0));
    if (bytes[0] === 4) resources.push(bytes.subarray(11));
    if (bytes[0] === 3 || bytes[0] === 5) frames.push(bytes);
  });
  let consumed = 0;
  const next = async (painted = true) => {
    await expect.poll(() => frames.length, { timeout: 5000 }).toBeGreaterThan(consumed);
    const frame = frames[consumed++];
    if (!frame) throw new Error("missing scene frame");
    for (const batch of resources.splice(0)) await call(1, batch);
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const seq = view.getUint32(3, true);
    const partial = frame[0] === 5;
    const fields = partial
      ? [seq, view.getUint32(27, true), view.getInt32(11, true), view.getInt32(15, true), 1]
      : [seq, 1];
    const raw = await call(partial ? 16 : 15, input(fields, frame.subarray(partial ? 31 : 11)));
    await cdpSession.send("Kitesurf.sceneFrameAck", { seq, painted });
    return { frame, seq, raw };
  };
  await page.setViewport({ width: 800, height: 600 });
  // Unchanged boxes make a full scene substantially larger than the checkbox patch.
  const boxes = Array.from(
    { length: 40 },
    (_, i) => `<div style="position:absolute;
    left:${400 + (i % 5) * 50}px;top:${i * 10}px;width:20px;height:20px;background:blue"></div>`,
  ).join("");
  await setContent(
    page,
    `<body style="margin:0;min-height:2000px;background:white">
    <input id="check" type="checkbox" style="position:absolute;left:100px;top:100px;width:40px;height:40px;accent-color:red">
    ${boxes}`,
  );
  await cdpSession.send("Kitesurf.startSceneStream", {
    width: 800,
    height: 600,
    fps: 30,
    allowPartial: true,
  });
  try {
    expect((await next()).frame[0]).toBe(3);
    // Commit the first cascade's damage before measuring a paint-only update.
    await page.evaluate(() => {
      const checkbox = document.querySelector<HTMLInputElement>("#check");
      if (checkbox) checkbox.style.left = "101px";
    });
    const base = await next();
    expect(base.frame[0]).toBe(3);
    await page.evaluate(() => {
      const checkbox = document.querySelector<HTMLInputElement>("#check");
      if (checkbox) checkbox.checked = true;
    });
    const patch = await next();
    expect(patch.frame[0]).toBe(5);
    expect(new DataView(patch.frame.buffer).getUint32(27, true)).toBe(base.seq);
    expect(patch.frame.length).toBeLessThan(base.frame.length);
    expect(patch.raw.length).toBe(8 + 800 * 600 * 4);
    const reference = await decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
    const pixels = patch.raw.subarray(8);
    expect(pixels.length).toBe(reference.data.length);
    let differences = 0;
    // Clip-local origins can round an antialiased edge channel by one.
    for (let i = 0; i < pixels.length; i++) {
      if (Math.abs((pixels[i] ?? 0) - (reference.data[i] ?? 0)) > 1) differences++;
    }
    expect(differences).toBe(0);

    // Lose the local base: the rejected patch must be followed by a full recovery,
    // even though the document has not changed again.
    await call(15, input([0xffffffff, 1], base.frame.subarray(11)));
    await page.evaluate(() => {
      const checkbox = document.querySelector<HTMLInputElement>("#check");
      if (checkbox) checkbox.checked = false;
    });
    const rejected = await next(false);
    expect(rejected.frame[0]).toBe(5);
    expect(rejected.raw.length).toBe(0);
    expect((await next()).frame[0]).toBe(3);
    await page.evaluate(() => scrollTo(0, 80));
    expect((await next()).frame[0]).toBe(3);

    await cdpSession.send("Emulation.setDeviceMetricsOverride", {
      width: 640,
      height: 480,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdpSession.send("Kitesurf.startSceneStream", {
      width: 640,
      height: 480,
      fps: 30,
      allowPartial: true,
    });
    const resized = await next();
    expect(resized.frame[0]).toBe(3);
    expect(resized.raw.length).toBe(8 + 640 * 480 * 4);
    await setContent(
      page,
      "<body style='background:green'><div style='width:40px;height:40px'></div>",
    );
    const navigated = await next();
    expect(navigated.frame[0]).toBe(3);
    expect(navigated.seq).toBeGreaterThan(resized.seq);
  } finally {
    await cdpSession.send("Kitesurf.stopSceneStream");
  }
});
