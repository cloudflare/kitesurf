// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkCommentBlocks } from "./comment-policy.mjs";
import { scanRustComments } from "./rust-comments.mjs";
import { conciseCommentsRule } from "./rules/concise-comments.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

/** @param {string[]} lines
 * @returns {{source: string, spans: {start: number, end: number}[]}}
 */
function lineCommentFixture(lines) {
  const source = lines.join("\n");
  /** @type {{start: number, end: number}[]} */
  const spans = [];
  let start = 0;
  for (const line of lines) {
    const commentStart = line.indexOf("//");
    if (commentStart >= 0) {
      spans.push({ start: start + commentStart, end: start + line.length });
    }
    start += line.length + 1;
  }
  return { source, spans };
}

/** @param {string} source @returns {{start: number, end: number}[]} */
function blockCommentSpans(source) {
  const start = source.indexOf("/*");
  const end = source.lastIndexOf("*/") + 2;
  return [{ start, end }];
}

/** @param {{line: number, column: number, message: string}[]} violations
 * @returns {{line: number, column: number, message: string}}
 */
function firstViolation(violations) {
  const violation = violations.at(0);
  if (violation === undefined) throw new Error("expected a comment-policy violation");
  return violation;
}

test("reports excessive lines, width, and blank interior lines", () => {
  const fixture = lineCommentFixture([
    `// ${"x".repeat(98)}`,
    "",
    "// one",
    "// two",
    "// three",
    "// four",
    "// five",
    "",
    "// first",
    "//",
    "// last",
  ]);
  const violations = checkCommentBlocks(fixture.source, fixture.spans, { tabWidth: 2 });
  assert.deepEqual(
    violations.map(({ line, message }) => [
      line,
      message.includes("columns"),
      message.includes("physical lines"),
      message.includes("blank interior"),
    ]),
    [
      [1, true, false, false],
      [3, false, true, false],
      [10, false, false, true],
    ],
  );
  assert.ok(violations.every(({ column }) => column === 0));
});

test("groups adjacent line comments and ignores delimiter-only boundary lines", () => {
  const joined = lineCommentFixture(["//", "// first", "// second", "//"]);
  assert.deepEqual(checkCommentBlocks(joined.source, joined.spans, { tabWidth: 2 }), []);

  const tooDeep = lineCommentFixture(["// one", "// two", "// three", "// four", "// five"]);
  const violations = checkCommentBlocks(tooDeep.source, tooDeep.spans, { tabWidth: 2 });
  assert.equal(violations.length, 1);
  assert.match(firstViolation(violations).message, /5 physical lines/);

  const separated = lineCommentFixture(["// one", "", "// two"]);
  assert.deepEqual(checkCommentBlocks(separated.source, separated.spans, { tabWidth: 2 }), []);

  const blockBoundary = "/*\n *\n * text\n */";
  assert.deepEqual(
    checkCommentBlocks(blockBoundary, blockCommentSpans(blockBoundary), { tabWidth: 2 }),
    [],
  );
  const blockInterior = "/*\n * first\n *\n * last\n */";
  const blockViolations = checkCommentBlocks(blockInterior, blockCommentSpans(blockInterior), {
    tabWidth: 2,
  });
  assert.ok(
    blockViolations.some(({ line, message }) => line === 3 && message.includes("blank interior")),
  );
});

test("counts tabs at tab stops and Unicode code points as one column", () => {
  const exact = lineCommentFixture([`// ${"x".repeat(97)}`]);
  assert.deepEqual(checkCommentBlocks(exact.source, exact.spans, { tabWidth: 2 }), []);

  const over = lineCommentFixture([`// ${"x".repeat(98)}`]);
  assert.equal(
    firstViolation(checkCommentBlocks(over.source, over.spans, { tabWidth: 2 })).line,
    1,
  );

  const tabbed = lineCommentFixture([`\t// ${"x".repeat(93)}`]);
  assert.deepEqual(checkCommentBlocks(tabbed.source, tabbed.spans, { tabWidth: 4 }), []);
  const tabbedOver = lineCommentFixture([`\t// ${"x".repeat(94)}`]);
  assert.match(
    firstViolation(checkCommentBlocks(tabbedOver.source, tabbedOver.spans, { tabWidth: 4 }))
      .message,
    /101 columns/,
  );

  const unicode = lineCommentFixture([`// ${"😀".repeat(97)}`]);
  assert.deepEqual(checkCommentBlocks(unicode.source, unicode.spans, { tabWidth: 2 }), []);
  const unicodeOver = lineCommentFixture([`// ${"😀".repeat(98)}`]);
  assert.match(
    firstViolation(checkCommentBlocks(unicodeOver.source, unicodeOver.spans, { tabWidth: 2 }))
      .message,
    /101 columns/,
  );
});

test("allows only file-header legal text and labeled required explanations", () => {
  const legal = lineCommentFixture([
    `// Copyright 2026 ${"Kitesurf Contributors ".repeat(6)}`,
    '// Licensed under the Apache License, Version 2.0 (the "License");',
    "// you may not use this file except in compliance with the License.",
    "// You may obtain a copy of the License at",
    "// https://www.apache.org/licenses/LICENSE-2.0",
    "// Unless required by applicable law or agreed to in writing, software",
    '// distributed under the License is distributed on an "AS IS" BASIS,',
    "// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.",
    "// See the License for the specific language governing permissions and",
    "// limitations under the License.",
  ]);
  assert.deepEqual(checkCommentBlocks(legal.source, legal.spans, { tabWidth: 2 }), []);

  const notHeader = lineCommentFixture(legal.source.split("\n"));
  const prefix = "const value = 1;\n";
  const prefixed = `${prefix}${notHeader.source}`;
  const shiftedSpans = notHeader.spans.map(({ start, end }) => ({
    start: start + prefix.length,
    end: end + prefix.length,
  }));
  assert.ok(
    checkCommentBlocks(prefixed, shiftedSpans, { tabWidth: 2 }).some(({ message }) =>
      message.includes("physical lines"),
    ),
  );

  const safety = lineCommentFixture([
    `// SAFETY: the pointer belongs to the host allocation, which remains live ${"owner-held ".repeat(8)}`,
    "// until the caller releases it after this operation completes.",
    "// The buffer cannot be resized while this borrow is active.",
    "// The caller validates its length before calling this function.",
    "// This invariant is checked at the FFI boundary.",
  ]);
  assert.deepEqual(checkCommentBlocks(safety.source, safety.spans, { tabWidth: 2 }), []);

  const rustSafety = lineCommentFixture([
    "/// # Safety",
    "/// The caller must keep the allocation alive for the entire borrow.",
    "/// The pointer is not stored after this function returns.",
    "/// The length is validated before the host buffer is read.",
    "/// A null pointer is valid only when the length is zero.",
  ]);
  assert.deepEqual(checkCommentBlocks(rustSafety.source, rustSafety.spans, { tabWidth: 2 }), []);

  const ffi = lineCommentFixture([
    "// FFI: the host owns this allocation until the response is copied.",
    "// The pointer is never retained beyond the synchronous call.",
    "// The caller checks the returned length before reading it.",
    "// This function does not take ownership of the buffer.",
    "// A null pointer is accepted only for an empty payload.",
  ]);
  assert.deepEqual(checkCommentBlocks(ffi.source, ffi.spans, { tabWidth: 2 }), []);

  const lifetime =
    "/*\n * LIFETIME INVARIANT: the borrowed slice cannot outlive its owner.\n * The owner is retained by the task until the response is drained.\n * No callback stores the reference after this call.\n */";
  assert.deepEqual(checkCommentBlocks(lifetime, blockCommentSpans(lifetime), { tabWidth: 2 }), []);

  const ordinary = lineCommentFixture([
    "// This ordinary comment mentions safety only after its first sentence.",
    "// line two",
    "// line three",
    "// line four",
    "// line five",
  ]);
  assert.ok(
    checkCommentBlocks(ordinary.source, ordinary.spans, { tabWidth: 2 }).some(({ message }) =>
      message.includes("physical lines"),
    ),
  );

  const lateSafety = lineCommentFixture([
    "// Ordinary ownership commentary comes first.",
    "// SAFETY: this marker appears only after ordinary prose.",
    "// line three",
    "// line four",
    "// line five",
  ]);
  assert.ok(
    checkCommentBlocks(lateSafety.source, lateSafety.spans, { tabWidth: 2 }).some(({ message }) =>
      message.includes("physical lines"),
    ),
  );
});

test("recognizes exact directives and typed JSDoc without hiding nearby prose", () => {
  const typeDirective = lineCommentFixture([`// @ts-expect-error ${"reason ".repeat(20)}`]);
  assert.deepEqual(
    checkCommentBlocks(typeDirective.source, typeDirective.spans, { tabWidth: 2 }),
    [],
  );

  const metadata = lineCommentFixture([
    "// META: variant=?mode=a",
    "// META: timeout=long",
    "// META: script=/resources/testharness.js",
    "// META: title=fixture metadata",
    "// META: global=window",
  ]);
  assert.deepEqual(checkCommentBlocks(metadata.source, metadata.spans, { tabWidth: 2 }), []);

  const toolDirectives = lineCommentFixture([
    "// eslint-disable-next-line no-unused-vars -- generated by a test harness",
    "//@ check-pass",
    "// compile-flags: -C opt-level=3",
    "// run-rustfix",
    "// go:build linux && amd64",
  ]);
  assert.deepEqual(
    checkCommentBlocks(toolDirectives.source, toolDirectives.spans, { tabWidth: 2 }),
    [],
  );

  const ordinary = lineCommentFixture([`// ordinary @ts-expect-error ${"x".repeat(110)}`]);
  assert.ok(
    checkCommentBlocks(ordinary.source, ordinary.spans, { tabWidth: 2 }).some(({ message }) =>
      message.includes("columns"),
    ),
  );

  const jsdoc = `/**\n * @param {Map<string, {value: number}>} item - ${"x".repeat(120)}\n * @returns {Promise<{result: string}>}\n * Keep the declaration attached to this typed helper.\n */`;
  assert.deepEqual(checkCommentBlocks(jsdoc, blockCommentSpans(jsdoc), { tabWidth: 2 }), []);

  const typedef = `/**\n * @typedef {{id: string}} Item\n * ${"x".repeat(120)}\n * Keep the declared shape available to tooling.\n */`;
  assert.deepEqual(checkCommentBlocks(typedef, blockCommentSpans(typedef), { tabWidth: 2 }), []);

  const typeTag = `/**\n * @type {{id: string}}\n * ${"x".repeat(120)}\n * Retain the type annotation for checkJs.\n */`;
  assert.deepEqual(checkCommentBlocks(typeTag, blockCommentSpans(typeTag), { tabWidth: 2 }), []);

  const prose = `/**\n * A normal explanation comes first.\n * @param {string} item\n * More ordinary text.\n */`;
  assert.ok(
    checkCommentBlocks(prose, blockCommentSpans(prose), { tabWidth: 2 }).some(({ message }) =>
      message.includes("physical lines"),
    ),
  );
});

test("scans Rust comments without mistaking strings, characters, lifetimes, or labels", () => {
  const source = String.raw`let ordinary = "// ordinary string /* not a comment */";
let escaped = "quote: \" // still in the string";
let bytes = b"// byte string";
let c_string = c"// C string";
let raw = r#"// raw string /* contents */"#;
let raw_hashes = r###"quote: "## // still raw"###;
let byte_raw = br##"// byte raw /* contents */"##;
let c_raw = cr###"// C raw string"###;
let character = '\''; // line comment
let byte_character = b'\x27'; /* block comment */
fn borrow<'a>(value: &'a str) { 'label: loop { break 'label; } // lifetime line
/// doc line
//! inner doc line
/* outer /* nested // hidden */ outer end */`;
  const spans = scanRustComments(source);
  assert.deepEqual(
    spans.map(({ start, end }) => source.slice(start, end)),
    [
      "// line comment",
      "/* block comment */",
      "// lifetime line",
      "/// doc line",
      "//! inner doc line",
      "/* outer /* nested // hidden */ outer end */",
    ],
  );
});

test("keeps raw Rust fixture data out of policy checks and remains iterative", () => {
  const source = `let fixture = r###"\n// ${"x".repeat(120)}\n<!-- ${"y".repeat(120)} -->\n"###;\n// ${"z".repeat(98)}`;
  const spans = scanRustComments(source);
  assert.equal(spans.length, 1);
  assert.equal(checkCommentBlocks(source, spans, { tabWidth: 4 }).length, 1);

  const depth = 12000;
  const nested = `${"/*".repeat(depth)} body ${"*/".repeat(depth)}\n// after`;
  const nestedSpans = scanRustComments(nested);
  assert.equal(nestedSpans.length, 2);
  assert.equal(nested.slice(nestedSpans[0].start, nestedSpans[0].end).length, depth * 4 + 6);
});

test("Oxlint rule reports actionable diagnostics without autofixing", () => {
  const source = `#!/usr/bin/env node\nconst html = \`<!-- ${"x".repeat(120)} // ${"y".repeat(120)} -->\`;\n// ${"z".repeat(98)}`;
  const commentStart = source.lastIndexOf("//");
  const commentLine = source.slice(0, commentStart).split("\n").length;
  const lineStart = source.lastIndexOf("\n", commentStart - 1) + 1;
  /** @type {import("@oxlint/plugins").Comment[]} */
  const comments = [
    {
      type: "Shebang",
      value: "/usr/bin/env node",
      start: 0,
      end: 19,
      range: [0, 19],
      loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 19 } },
    },
    {
      type: "Line",
      value: source.slice(commentStart + 2),
      start: commentStart,
      end: source.length,
      range: [commentStart, source.length],
      loc: {
        start: { line: commentLine, column: commentStart - lineStart },
        end: { line: commentLine, column: source.length - lineStart },
      },
    },
  ];
  let getAllCommentsCalls = 0;
  /** @type {Pick<import("@oxlint/plugins").SourceCode, "text" | "getAllComments">} */
  const sourceCode = {
    text: source,
    getAllComments() {
      getAllCommentsCalls++;
      return comments;
    },
  };
  /** @type {import("@oxlint/plugins").Diagnostic[]} */
  const diagnostics = [];
  const visitor = conciseCommentsRule.create({
    sourceCode,
    report(diagnostic) {
      diagnostics.push(diagnostic);
    },
  });
  visitor.Program();

  assert.equal(getAllCommentsCalls, 1);
  assert.equal(diagnostics.length, 1);
  const diagnostic = diagnostics.at(0);
  assert.ok(diagnostic);
  assert.deepEqual(diagnostic.loc, { line: commentLine, column: 0 });
  assert.match(diagnostic.message ?? "", /101 columns/);
  assert.equal("fix" in diagnostic, false);
});

test("Oxlint parser ignores comment-like template fixture text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kitesurf-comment-policy-"));
  try {
    const pluginPath = join(directory, "plugin.mjs");
    const configPath = join(directory, "oxlint.config.json");
    const sourcePath = join(directory, "fixture.ts");
    const ruleSpecifier = new URL("./rules/concise-comments.ts", import.meta.url).href;
    await writeFile(
      pluginPath,
      `import rule from ${JSON.stringify(ruleSpecifier)};\n` +
        'export default { meta: { name: "comment-policy-test" }, rules: { "concise-comments": rule } };\n',
    );
    await writeFile(
      configPath,
      JSON.stringify({
        jsPlugins: [{ name: "comment-policy-test", specifier: pluginPath }],
        rules: { "comment-policy-test/concise-comments": "error" },
      }),
    );
    await writeFile(
      sourcePath,
      `const html = \`<!-- ${"x".repeat(120)} // ${"y".repeat(120)} -->\`;\n// ${"z".repeat(98)}\n`,
    );

    const result = spawnSync(
      process.execPath,
      [
        resolve(repositoryRoot, "node_modules/oxlint/bin/oxlint"),
        "--config",
        configPath,
        "--format=json",
        "--threads=1",
        sourcePath,
      ],
      { cwd: repositoryRoot, encoding: "utf8", timeout: 30_000 },
    );
    if (result.error !== undefined) throw result.error;
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 1, output);
    assert.equal(output.split("comment-policy-test(concise-comments)").length - 1, 1, output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
