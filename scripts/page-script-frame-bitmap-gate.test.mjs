// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(
  new URL("../packages/page-script/src/frame-bitmap-gate.ts", import.meta.url),
  "utf8",
);
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
runInContext(code, createContext({ exports }));

test("held OOPIF bitmaps apply in arrival order after the final release", async () => {
  const applied = [];
  const gate = exports.createFrameBitmapDeliveryGate((params) => {
    applied.push(params.ownerBackendNodeId);
    return { ok: true, rc: params.ownerBackendNodeId };
  });
  const releaseFirst = gate.hold();
  const releaseSecond = gate.hold();
  const first = gate.deliver({
    ownerBackendNodeId: 12,
    width: 1,
    height: 1,
    rgba: new Uint8Array(4),
  });
  const second = gate.deliver({
    ownerBackendNodeId: 13,
    width: 1,
    height: 1,
    rgba: new Uint8Array(4),
  });

  assert.deepEqual(applied, []);
  releaseFirst();
  assert.deepEqual(applied, []);
  releaseFirst();
  releaseSecond();

  assert.deepEqual(applied, [12, 13]);
  assert.deepEqual(await Promise.all([first, second]), [
    { ok: true, rc: 12 },
    { ok: true, rc: 13 },
  ]);
});
