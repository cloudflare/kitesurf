// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A boa typed array reaches V8 as the bridge's proxy, which jsg's decode rejected;
// protobuf runtimes decode descriptors from boa-built bytes.
import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("TextDecoder.decode reads boa-built buffer sources", async ({ page }) => {
  await setContent(page, "<!doctype html><title>t</title>");
  const decoded = await page.evaluate(() => {
    const bytes = new Uint8Array([0, 104, 105, 0]);
    const decoder = new TextDecoder();
    return [
      decoder.decode(new Uint8Array([104, 105])),
      decoder.decode(bytes.subarray(1, 3)),
      decoder.decode(new DataView(bytes.buffer, 1, 2)),
      decoder.decode(new Uint8Array([104, 105]).buffer),
      decoder.decode(new Uint16Array([0x6968])),
      decoder.decode(new TextEncoder().encode("v8")),
    ];
  });
  expect(decoded).toEqual(["hi", "hi", "hi", "hi", "hi", "v8"]);
}, 60_000);
