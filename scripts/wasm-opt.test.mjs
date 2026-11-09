// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BINARYEN_SHA256, BINARYEN_VERSION, sha256File } from "./wasm-opt.mjs";

test("sha256File hashes the exact file bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "wasm-opt-test-"));
  const file = join(dir, "fixture.bin");
  writeFileSync(file, "binaryen");
  assert.equal(
    sha256File(file),
    "332d98ba02b9d778bc0ad5f4e83ed11e213425dfecf5d7aaf42b9adc8d256222",
  );
});

test("the binaryen pin matches MODULE.bazel", () => {
  const module = readFileSync(new URL("../MODULE.bazel", import.meta.url), "utf8");
  const block = module.match(/name = "binaryen_linux_x86_64"[\s\S]*?\n\)/)?.[0] ?? "";
  assert.ok(block.includes(`sha256 = "${BINARYEN_SHA256}"`), block);
  assert.ok(block.includes(`binaryen-version_${BINARYEN_VERSION}`), block);
});
