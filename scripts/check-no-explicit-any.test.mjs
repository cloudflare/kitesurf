// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";

import { explicitAnyFindings } from "./check-no-explicit-any.mjs";

const lines = (text) => explicitAnyFindings(ts, "f.ts", text).map((f) => Number(f.split(":")[1]));

test("an `any` needs a marker on its line or alone on the line before", () => {
  assert.deepEqual(lines("let a: any = 1;\n"), [1]);
  assert.deepEqual(lines("let a: any = 1; // any: reason\n"), []);
  assert.deepEqual(lines("// any: reason\nlet a: any = 1;\n"), []);
  assert.deepEqual(lines("f(); // any: reason\nlet a: any = 1;\n"), [2]);
  assert.deepEqual(lines("// any:\nlet a: any = 1;\n"), [2]);
  assert.deepEqual(lines("/* any: reason */ let a: any = 1;\n"), [1]);
});

test("an `any` or a marker inside a string, template or regex doesn't count", () => {
  assert.deepEqual(lines('const s = "x: any"; const t = `any`;\n'), []);
  assert.deepEqual(lines('const s = "// any: no"; let a: any = 1;\n'), [1]);
  assert.deepEqual(lines("const r = /\\/\\/ any: no/; let a: any = 1;\n"), [1]);
});

test("a template with a substitution doesn't throw off the code after it", () => {
  // The marker after the template still counts...
  assert.deepEqual(lines('const t = `x: ${"y"}`;\n// any: reason\nlet a: any = 1;\n'), []);
  // ...and one inside its text still doesn't.
  assert.deepEqual(
    lines("const v = 1;\nconst t = `${v} // any: not a comment`; let z: any = 1;\n"),
    [2],
  );
  assert.deepEqual(lines("const t = `${`${1}`} ${2}`; let a: any = 1; // any: reason\n"), []);
});
