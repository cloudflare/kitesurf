// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const GLUE = "export function import1(a,b,c,d){globalThis.__ks_state.fetchResource(a,b,c,d)}";
test("the generated import calls the private bridge directly", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "build-wasm-bridge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "kitesurf_core.js"), GLUE);
  writeFileSync(join(dir, "kitesurf_core.d.ts"), "");
  const source = readFileSync(new URL("./build-wasm.mjs", import.meta.url), "utf8");
  const at = source.indexOf("{", source.indexOf("hide fetchResource bridge"));
  const block = source.slice(at, source.indexOf("// Every trap"));
  new Function("resolve", "PKG_DIR", "readFileSync", "writeFileSync", block)(
    (...p) => p.join("/"),
    dir,
    readFileSync,
    writeFileSync,
  );
  const glue = await import(pathToFileURL(join(dir, "kitesurf_core.js")).href);
  const seen = [];
  const bridge = () => {};
  const nativeCall = Function.prototype.call;
  t.after(() => (Function.prototype.call = nativeCall));
  glue.__setBridgeFetchResource(bridge);
  Function.prototype.call = function (...args) {
    if (this === bridge) seen.push(this);
    return Reflect.apply(nativeCall, this, args);
  };
  glue.import1(7, "https://a.test/x.css", "stylesheet", "cors");
  assert.deepEqual(seen, []);
});
