// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { test } from "node:test";
import assert from "node:assert/strict";

import { extractTopLevelDecls, hasUseStrictDirective } from "../src/classic-scan.ts";

test("a slash after a string, template or postfix operator is division", () => {
  assert.deepEqual(extractTopLevelDecls('var a="50"/2,B=1;function f(){}').names, ["a", "B", "f"]);
  assert.deepEqual(extractTopLevelDecls("var t = `x` / 1, u = 2; function g(){}").names, [
    "t",
    "u",
    "g",
  ]);
  assert.deepEqual(extractTopLevelDecls("var i = 0; i++ / 2; var after = 1;").names, [
    "i",
    "after",
  ]);
  assert.deepEqual(extractTopLevelDecls("var j = 0; j-- / 2; var after = 1;").names, [
    "j",
    "after",
  ]);
});

test("a fake regex never swallows a function's brace", () => {
  const scan = extractTopLevelDecls(
    'var q = "8" / 2; function g(n) { var h = n / 2; var local = h; return local; }',
  );
  assert.deepEqual(scan.names, ["q", "g"]);
  assert.deepEqual(scan.varNames, ["q"]);
  assert.equal(scan.varSites.length, 1);
});

test("a slash after an identifier spelled like a keyword is division", () => {
  const iifeScan = extractTopLevelDecls(
    "!function(){var of=g(4),x=of/2;function s(e){var t=e+1;return t/2}var k=5;}()",
  );
  assert.deepEqual(iifeScan.names, []);
  assert.deepEqual(
    extractTopLevelDecls("var of=4;var a=of/2;function f(){return 1}var b=a/3;var c=1;").names,
    ["of", "a", "f", "b", "c"],
  );
  for (const word of ["yield", "await"]) {
    assert.deepEqual(
      extractTopLevelDecls(`var ${word}=4;var a=${word}/2;function f(){}var b=a/3;`).names,
      [word, "a", "f", "b"],
    );
  }
});

test("a slash after a keyword used as a property name is division", () => {
  for (const word of ["in", "do", "return", "new", "typeof"]) {
    const source = `var x={};var a=x.${word}/2;function f(){}var b=a/3;var c=x?.${word} / 4;class K{#${word}=1;m(){return this.#${word}/2}}var d=1;`;
    assert.deepEqual(extractTopLevelDecls(source).names, ["x", "a", "f", "b", "c", "K", "d"], word);
  }
  assert.deepEqual(extractTopLevelDecls("var s=[...typeof /'/.x];var after=1;").names, [
    "s",
    "after",
  ]);
});

test("a regex that never closes is division, not the end of the scan", () => {
  assert.deepEqual(extractTopLevelDecls("var o = {} / 2, late = 1; function h(){}").names, [
    "o",
    "late",
    "h",
  ]);
});

test("a regex literal after an operator or a block still hides its quotes", () => {
  assert.deepEqual(extractTopLevelDecls("var xss = /[<>'\"]/, half = 4 / 2; var next = 1;").names, [
    "xss",
    "half",
    "next",
  ]);
  assert.deepEqual(extractTopLevelDecls('function f(){}/"/.test(s); var after = 1;').names, [
    "f",
    "after",
  ]);
});

test("a use strict directive is found only inside the prologue", () => {
  assert.equal(hasUseStrictDirective('"use strict"; var a;'), true);
  assert.equal(hasUseStrictDirective("// banner\n/* c */ 'use asm';\n'use strict'\nvar a;"), true);
  assert.equal(hasUseStrictDirective('"use strict"'), true);
  assert.equal(hasUseStrictDirective('var a; "use strict";'), false);
  assert.equal(hasUseStrictDirective('"use strict" + x;'), false);
  assert.equal(hasUseStrictDirective('"use strict"\n(function () {})();'), false);
  assert.equal(hasUseStrictDirective('"use\\x20strict";'), false);
  assert.equal(hasUseStrictDirective('"a"; b(); "use strict";'), false);
});

test("each strippable var site lists its own names", () => {
  const scan = extractTopLevelDecls("var exports = {}, a = 1; var b; var { c } = d;");
  assert.deepEqual(scan.varSiteNames, [["exports", "a"], ["b"]]);
});

test("lexical and class declarations report their sites", () => {
  const source = "let a = 1; const b = 2; class C {}";
  const scan = extractTopLevelDecls(source);
  assert.deepEqual(scan.lexicalNames, ["a", "b"]);
  assert.deepEqual(scan.classNames, ["C"]);
  assert.equal(scan.lexicalSites.length, 2);
  assert.equal(scan.classSites.length, 1);
  assert.deepEqual(
    scan.lexicalSites.map((site) => source.slice(site, site + 5)),
    ["let a", "const"],
  );
});
