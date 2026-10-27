// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Fails on a written-out `any` in the TypeScript under the given directories:
// `node scripts/check-no-explicit-any.mjs <dir>...`. Use `unknown` and narrow instead. Where
// `any` is the only honest type, mark the line, or the line before, with `// any: <reason>`.
// Generated files are skipped. Parsing means `any` in a string or template never counts.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("usage: check-no-explicit-any.mjs <dir>...");
  process.exit(2);
}

const SOURCE = /\.[mc]?tsx?$/;
const GENERATED = /\.generated\.[mc]?tsx?$/;
function tsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") out.push(...tsFiles(file));
    } else if (SOURCE.test(entry.name) && !GENERATED.test(entry.name)) out.push(file);
  }
  return out;
}

const MARKER = /^\/\/\s*any:\s*\S/;

// The lines an `any` may sit on: a line holding an `// any:` comment, and
// the line after a line that holds nothing but that comment.
function allowedLines(ts, source, text) {
  const allowed = new Set();
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /*skipTrivia*/ false,
    source.languageVariant,
    text,
  );
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind !== ts.SyntaxKind.SingleLineCommentTrivia || !MARKER.test(scanner.getTokenText()))
      continue;
    const start = scanner.getTokenStart();
    const { line } = source.getLineAndCharacterOfPosition(start);
    allowed.add(line);
    const lineStart = source.getPositionOfLineAndCharacter(line, 0);
    if (text.slice(lineStart, start).trim() === "") allowed.add(line + 1);
  }
  return allowed;
}

const findings = [];
for (const dir of dirs) {
  const ts = createRequire(path.resolve(dir, "index.js"))("typescript");
  for (const file of tsFiles(dir)) {
    const text = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    let allowed = null;
    const visit = (node) => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        allowed ??= allowedLines(ts, source, text);
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        if (!allowed.has(line))
          findings.push(`${file}:${line + 1}: ${text.split("\n")[line].trim()}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

if (findings.length) {
  console.error(
    "Explicit `any` (use `unknown` and narrow, or add `// any: <reason>`):\n" +
      findings.map((f) => `  ${f}`).join("\n"),
  );
  process.exit(1);
}
