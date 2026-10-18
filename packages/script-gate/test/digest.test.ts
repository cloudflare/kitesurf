// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { test } from "node:test";
import assert from "node:assert/strict";

import { scriptSourceDigest } from "../src/digest.ts";

test("equal sources share a digest, any edit changes it", async () => {
  const source = "var a = 1;\nwindow.b = function () { return a; };\n";
  const digest = await scriptSourceDigest(source);
  assert.equal(digest, await scriptSourceDigest(source.slice()));
  assert.notEqual(digest, await scriptSourceDigest(source.replace("1", "2")));
  assert.notEqual(digest, await scriptSourceDigest(source + " "));
  assert.match(await scriptSourceDigest(""), /^[0-9a-f]{64}$/);
});

test("lone surrogates stay distinct, where UTF-8 would fold them to U+FFFD", async () => {
  assert.notEqual(await scriptSourceDigest("x\ud800"), await scriptSourceDigest("x\udc00"));
});
