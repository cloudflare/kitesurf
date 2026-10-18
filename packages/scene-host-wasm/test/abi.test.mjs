// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const wasmPath = fileURLToPath(new URL("../../engine/public/rbi/scene_host.wasm", import.meta.url));
const manifestPath = fileURLToPath(
  new URL("../../engine/public/rbi/scene_host.json", import.meta.url),
);
const U32_MASK = 0xffff_ffffn;
const SCENE_HEADER_BYTES = 40;
const CROP_PREFIX_BYTES = 16;
const ANSI_PREFIX_BYTES = 16;

async function readRequiredFile(path, description) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Missing ${description} at ${path}; run \`pnpm run build\` first.`);
    }
    throw error;
  }
}

const manifestBytes = await readRequiredFile(manifestPath, "scene-host manifest");
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const wireVersion = manifest?.wireVersion;
if (!Number.isInteger(wireVersion) || wireVersion < 0 || wireVersion > 0xffff_ffff) {
  throw new Error(`Invalid wireVersion in ${manifestPath}; run \`pnpm run build\` first.`);
}
const wasmModule = await WebAssembly.compile(
  await readRequiredFile(wasmPath, "staged scene-host Wasm artifact"),
);

async function freshHost() {
  return { instance: await WebAssembly.instantiate(wasmModule) };
}

function callHost(host, operation, input = Buffer.alloc(0)) {
  const { memory, ks_alloc, ks_call, ks_free } = host.instance.exports;
  const inputLength = input.byteLength;
  assert.ok(inputLength <= 0xffff_ffff, "guest input length must fit the u32 ABI");

  let inputPointer = 0;
  let inputAllocated = false;
  try {
    if (inputLength > 0) {
      inputPointer = ks_alloc(inputLength) >>> 0;
      assert.notEqual(inputPointer, 0, "ks_alloc must return a pointer for nonempty input");
      inputAllocated = true;
      new Uint8Array(memory.buffer).set(input, inputPointer);
    }

    const packed = ks_call(operation, inputPointer, inputLength);
    assert.equal(typeof packed, "bigint", "ks_call returns a packed i64 result");
    if (packed === 0n) {
      return Buffer.alloc(0);
    }

    const outputPointer = Number(packed & U32_MASK);
    const outputLength = Number((packed >> 32n) & U32_MASK);
    assert.notEqual(outputPointer, 0, "nonempty ks_call result must have a pointer");
    assert.notEqual(outputLength, 0, "nonempty ks_call result must have a length");
    try {
      const outputMemory = new Uint8Array(memory.buffer);
      assert.ok(
        outputPointer + outputLength <= outputMemory.byteLength,
        "ks_call result must fit in guest memory",
      );
      return Buffer.from(outputMemory.subarray(outputPointer, outputPointer + outputLength));
    } finally {
      ks_free(outputPointer, outputLength);
    }
  } finally {
    if (inputAllocated || inputLength === 0) {
      ks_free(inputPointer, inputLength);
    }
  }
}

function u32LE(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function u64LE(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

function i16LE(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeInt16LE(value);
  return bytes;
}

function q3Point(tag, x, y) {
  return Buffer.concat([Buffer.from([tag]), i16LE(x * 8), i16LE(y * 8)]);
}

function fillRect(x0, y0, x1, y1, paint) {
  return Buffer.concat([
    Buffer.from([0x04, 0x00, 0x00, 0x00]),
    paint,
    Buffer.from([0x00]),
    q3Point(0x00, x0, y0),
    q3Point(0x01, x1, y0),
    q3Point(0x01, x1, y1),
    q3Point(0x01, x0, y1),
    Buffer.from([0x04, 0xff]),
  ]);
}

function framedScene(width, height, operations, resourceTable) {
  const operationBytes = Buffer.concat(operations);
  const resourceOffset =
    resourceTable === undefined ? 0 : SCENE_HEADER_BYTES + operationBytes.length;
  const header = Buffer.alloc(SCENE_HEADER_BYTES);
  header.write("KSC0", 0, "ascii");
  header.writeUInt32LE(wireVersion, 4);
  header.writeUInt32LE(width, 8);
  header.writeUInt32LE(height, 12);
  header.writeUInt32LE(operations.length, 24);
  header.writeUInt32LE(resourceOffset, 28);
  header.writeUInt32LE(height, 36);
  return Buffer.concat([header, operationBytes, resourceTable ?? Buffer.alloc(0)]);
}

function quadrantScene() {
  return framedScene(8, 8, [
    fillRect(0, 0, 4, 4, Buffer.from([0x00, 231, 35, 47, 255])),
    fillRect(4, 0, 8, 4, Buffer.from([0x00, 23, 197, 61, 255])),
    fillRect(0, 4, 4, 8, Buffer.from([0x00, 37, 83, 219, 255])),
    fillRect(4, 4, 8, 8, Buffer.from([0x00, 243, 191, 17, 255])),
  ]);
}

function rgbaAt(pixels, width, x, y) {
  const start = (y * width + x) * 4;
  return Array.from(pixels.subarray(start, start + 4));
}

function cropInput(left, top, width, height, scene) {
  return Buffer.concat([u32LE(left), u32LE(top), u32LE(width), u32LE(height), scene]);
}

function imageReferenceTable(hash) {
  const width = 2;
  const height = 4;
  const payload = Buffer.concat([
    u32LE(width),
    u32LE(height),
    Buffer.from([3]),
    u32LE(width),
    u32LE(height),
  ]);
  return Buffer.concat([
    u32LE(1),
    u64LE(hash),
    u32LE(width),
    u32LE(height),
    Buffer.from([0, 3, 0, 0]),
    u32LE(payload.length),
    payload,
  ]);
}

function imageResourceBatch(hash, pngBytes) {
  const payload = Buffer.concat([
    u32LE(2),
    u32LE(4),
    Buffer.from([2]),
    u32LE(2),
    u32LE(4),
    pngBytes,
  ]);
  return Buffer.concat([u32LE(1), Buffer.from([2]), u64LE(hash), u32LE(payload.length), payload]);
}

function solidRedPng(width, height) {
  const png = new PNG({ width, height });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = 255;
    png.data[offset + 1] = 0;
    png.data[offset + 2] = 0;
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
}

function ansiInput(scene) {
  const prefix = Buffer.alloc(ANSI_PREFIX_BYTES);
  prefix.writeUInt32LE(2, 0);
  prefix.writeUInt32LE(2, 4);
  prefix.writeFloatLE(8, 8);
  prefix.writeFloatLE(16, 12);
  return Buffer.concat([prefix, scene]);
}

test("op11 crops from the requested origin and op3/op10 return the full PNG", async () => {
  const host = await freshHost();
  const scene = quadrantScene();
  const rgbaFrame = callHost(host, 14, scene);

  assert.equal(rgbaFrame.readUInt32LE(0), 8);
  assert.equal(rgbaFrame.readUInt32LE(4), 8);
  assert.equal(rgbaFrame.length, 8 + 8 * 8 * 4);
  const rawPixels = rgbaFrame.subarray(8);
  const fullSamples = [
    { x: 1, y: 1, rgba: [231, 35, 47, 255] },
    { x: 6, y: 1, rgba: [23, 197, 61, 255] },
    { x: 1, y: 6, rgba: [37, 83, 219, 255] },
    { x: 6, y: 6, rgba: [243, 191, 17, 255] },
  ];
  for (const { x, y, rgba } of fullSamples) {
    assert.deepEqual(rgbaAt(rawPixels, 8, x, y), rgba, `op14 pixel at (${x}, ${y})`);
  }

  for (const operation of [3, 10]) {
    const pngBytes = callHost(host, operation, scene);
    const image = PNG.sync.read(pngBytes);
    assert.equal(image.width, 8, `op${operation} PNG width`);
    assert.equal(image.height, 8, `op${operation} PNG height`);
    assert.deepEqual(image.data, rawPixels, `op${operation} full-frame pixels`);
    for (const { x, y, rgba } of fullSamples) {
      assert.deepEqual(
        rgbaAt(image.data, image.width, x, y),
        rgba,
        `op${operation} pixel at (${x}, ${y})`,
      );
    }
  }

  const crop = PNG.sync.read(callHost(host, 11, cropInput(3, 2, 4, 3, scene)));
  assert.equal(crop.width, 4);
  assert.equal(crop.height, 3);
  assert.deepEqual(
    crop.data,
    Buffer.from([
      231, 35, 47, 255, 23, 197, 61, 255, 23, 197, 61, 255, 23, 197, 61, 255, 231, 35, 47, 255, 23,
      197, 61, 255, 23, 197, 61, 255, 23, 197, 61, 255, 37, 83, 219, 255, 243, 191, 17, 255, 243,
      191, 17, 255, 243, 191, 17, 255,
    ]),
  );
  const shiftedCrop = PNG.sync.read(callHost(host, 11, cropInput(4, 2, 4, 3, scene)));
  assert.notDeepEqual(shiftedCrop.data, crop.data, "op11 must honor the requested crop origin");
});

test("ANSI activation routes decoded image resources through its separate store", async () => {
  const host = await freshHost();
  const hash = 0x0123_4567_89ab_cdefn;
  const resourceImage = solidRedPng(2, 4);
  const imagePaint = Buffer.concat([Buffer.from([0x02]), u64LE(hash)]);
  const scene = framedScene(
    16,
    32,
    [fillRect(0, 0, 16, 32, imagePaint)],
    imageReferenceTable(hash),
  );
  const batch = imageResourceBatch(hash, resourceImage);

  assert.deepEqual(callHost(host, 1, batch), u32LE(1));
  assert.deepEqual(callHost(host, 2, scene), u32LE(0));
  assert.deepEqual(callHost(host, 13, ansiInput(scene)), Buffer.alloc(0));

  assert.deepEqual(callHost(host, 12), Buffer.alloc(0));
  assert.deepEqual(
    callHost(host, 2, scene),
    Buffer.concat([u32LE(1), Buffer.from([2]), u64LE(hash)]),
  );
  const missingImageAnsi = callHost(host, 13, ansiInput(scene)).toString("utf8");
  assert.ok(missingImageAnsi.includes("░"), "a valid ANSI scene marks its missing image");

  assert.deepEqual(callHost(host, 1, batch), u32LE(1));
  assert.deepEqual(callHost(host, 2, scene), u32LE(0));
  const renderedAnsi = callHost(host, 13, ansiInput(scene)).toString("utf8");
  assert.ok(renderedAnsi.includes("\x1b[48;2;255;0;0m"));
  assert.equal(renderedAnsi.includes("░"), false);
});

test("malformed host envelopes return exactly empty output", async () => {
  const host = await freshHost();
  const scene = quadrantScene();
  const malformedCases = [
    {
      name: "op6 rejects a font prefix shorter than four bytes",
      operation: 6,
      input: Buffer.alloc(3),
    },
    {
      name: "op6 rejects a declared font path longer than its payload",
      operation: 6,
      input: u32LE(1),
    },
    {
      name: "op11 rejects a crop prefix shorter than sixteen bytes",
      operation: 11,
      input: Buffer.alloc(CROP_PREFIX_BYTES - 1),
    },
    {
      name: "op11 rejects a zero-width crop of a valid scene",
      operation: 11,
      input: cropInput(2, 2, 0, 4, scene),
    },
    {
      name: "op11 rejects an out-of-bounds crop of a valid scene",
      operation: 11,
      input: cropInput(6, 2, 4, 4, scene),
    },
    {
      name: "op13 rejects a short ANSI prefix after activation",
      operation: 13,
      input: Buffer.alloc(ANSI_PREFIX_BYTES - 1),
    },
  ];

  assert.deepEqual(callHost(host, 12), Buffer.alloc(0));
  for (const { name, operation, input } of malformedCases) {
    assert.deepEqual(callHost(host, operation, input), Buffer.alloc(0), name);
  }
});

test("op6 returns a four-byte status for a complete font envelope", async () => {
  const host = await freshHost();
  const result = callHost(host, 6, Buffer.concat([u32LE(1), Buffer.from("a")]));

  assert.deepEqual(result, u32LE(0));
});
