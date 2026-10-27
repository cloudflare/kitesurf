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
import { fileURLToPath } from "node:url";

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

// The lines an `any` may sit on: a line with an `// any:` comment, and the line after a line
// that holds only that comment. Comments come from each token's leading and trailing trivia in
// the parse tree; a bare scanner misreads the code after a template with a `${…}` in it.
// JSDoc and JSX text are skipped: their children sit inside a comment or are text.
function allowedLines(ts, source) {
  const text = source.text;
  const allowed = new Set();
  const seen = new Set();
  const take = (ranges) => {
    for (const range of ranges ?? []) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      if (
        range.kind !== ts.SyntaxKind.SingleLineCommentTrivia ||
        !MARKER.test(text.slice(range.pos, range.end))
      )
        continue;
      const { line } = source.getLineAndCharacterOfPosition(range.pos);
      allowed.add(line);
      const lineStart = source.getPositionOfLineAndCharacter(line, 0);
      if (text.slice(lineStart, range.pos).trim() === "") allowed.add(line + 1);
    }
  };
  const visit = (node) => {
    if (ts.isJSDoc(node) || ts.isJsxText(node)) return;
    if (ts.isToken(node)) {
      take(ts.getLeadingCommentRanges(text, node.pos));
      take(ts.getTrailingCommentRanges(text, node.end));
      return;
    }
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return allowed;
}

/**
 * `file:line: text` for each explicit `any` in `text` that no marker allows, parsed with `ts`.
 * @returns {string[]}
 */
export function explicitAnyFindings(ts, file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const findings = [];
  let allowed = null;
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      allowed ??= allowedLines(ts, source);
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      if (!allowed.has(line))
        findings.push(`${file}:${line + 1}: ${text.split("\n")[line].trim()}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

function main(dirs) {
  if (dirs.length === 0) {
    console.error("usage: check-no-explicit-any.mjs <dir>...");
    process.exit(2);
  }
  const findings = [];
  for (const dir of dirs) {
    const ts = createRequire(path.resolve(dir, "index.js"))("typescript");
    for (const file of tsFiles(dir))
      findings.push(...explicitAnyFindings(ts, file, fs.readFileSync(file, "utf8")));
  }
  if (findings.length) {
    console.error(
      "Explicit `any` (use `unknown` and narrow, or add `// any: <reason>`):\n" +
        findings.map((f) => `  ${f}`).join("\n"),
    );
    process.exit(1);
  }
}

// The test imports explicitAnyFindings, so the CLI only runs when this is
// the entry point.
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(self))
  main(process.argv.slice(2));
