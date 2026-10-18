// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = resolve(import.meta.dirname, "..");
const GIT_FILE_LIST_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const SOURCE_EXTENSIONS = new Set([".js", ".ts", ".tsx", ".mjs", ".mts", ".cts"]);
const EXCLUDED_SOURCE_SEGMENTS = new Set([
  "build",
  "dist",
  "generated",
  "node_modules",
  "out",
  "output",
  "patches",
  "pkg",
  "target",
  "vendor",
  "vendor-patched",
]);
const DECLARATION_FILE = /\.d(?:\.[^/]+)?\.(?:ts|mts|cts)$/i;
const GENERATED_FILE = /\.generated\./i;

const PACKAGE_SCOPE = "@kitesurf/";

// Every @kitesurf/* package that is not a workspace package here belongs to the private
// overlay, which lives in a separate repository, so allow-list the public ones by reading
// their manifests instead of naming the private ones.
/** @param {string} [root]
 * @returns {Set<string>} */
export function readPublicPackageNames(root = ROOT) {
  const names = new Set();
  for (const dir of readdirSync(resolve(root, "packages"), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const manifest = resolve(root, "packages", dir.name, "package.json");
    if (!existsSync(manifest)) continue;
    const { name } = JSON.parse(readFileSync(manifest, "utf8"));
    if (typeof name === "string") names.add(name);
  }
  return names;
}

function isPublicSourceFile(file) {
  if (file.startsWith("internal/")) return false;
  if (!SOURCE_EXTENSIONS.has(extname(file).toLowerCase())) return false;
  if (DECLARATION_FILE.test(file) || GENERATED_FILE.test(file)) return false;
  if (file === "packages/dom-shim/src/editing/implementation.js") return false;
  if (file.startsWith("packages/engine/test/fixtures-worker/assets/")) return false;
  return !file.split("/").some((segment) => EXCLUDED_SOURCE_SEGMENTS.has(segment));
}

function isRelativeSpecifier(specifier) {
  return /^(?:\.{1,2})(?:\/|$)/.test(specifier);
}

function matchesInternalPackage(specifier, publicPackageNames) {
  if (!specifier.startsWith(PACKAGE_SCOPE)) return false;
  const slash = specifier.indexOf("/", PACKAGE_SCOPE.length);
  const packageName = slash === -1 ? specifier : specifier.slice(0, slash);
  return !publicPackageNames.has(packageName);
}

function targetsInternalPath(file, specifier) {
  const target = posix.normalize(posix.join(posix.dirname(file), specifier));
  return target === "internal" || target.startsWith("internal/");
}

function targetsInternal(file, specifier, publicPackageNames) {
  if (isRelativeSpecifier(specifier)) return targetsInternalPath(file, specifier);
  return matchesInternalPackage(specifier, publicPackageNames);
}

// Computed targets are out of scope; only source-level literal specifiers are checked.
function literalSpecifier(node) {
  if (!node) return undefined;
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;
}

function scriptKind(file) {
  const extension = extname(file).toLowerCase();
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".js" || extension === ".mjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** @param {string} file
 * @param {string} text
 * @param {ReadonlySet<string>} publicPackageNames
 * @returns {Array<{file: string, line: number, specifier: string}>} */
export function scanPublicImports(file, text, publicPackageNames) {
  if (!isPublicSourceFile(file)) return [];

  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const violations = [];

  function recordViolation(position, specifier) {
    const { line } = source.getLineAndCharacterOfPosition(position);
    violations.push({ file, line: line + 1, specifier });
  }

  function record(node, literal) {
    const specifier = literalSpecifier(literal);
    if (specifier === undefined || !targetsInternal(file, specifier, publicPackageNames)) return;
    recordViolation(node.getStart(source), specifier);
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      record(node, node.moduleSpecifier);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      record(node, node.argument.literal);
    } else if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isImport || isRequire) record(node, node.arguments[0]);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      record(node, node.moduleReference.expression);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  for (const { pos, fileName } of source.referencedFiles) {
    if (targetsInternalPath(file, fileName)) recordViolation(pos, fileName);
  }
  for (const { pos, fileName } of source.typeReferenceDirectives) {
    if (targetsInternal(file, fileName, publicPackageNames)) recordViolation(pos, fileName);
  }
  return violations;
}

function main() {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: GIT_FILE_LIST_MAX_BUFFER_BYTES,
    },
  )
    .split("\0")
    .filter((file) => file && existsSync(resolve(ROOT, file)));
  const sourceFiles = files.filter(isPublicSourceFile);
  const publicPackageNames = readPublicPackageNames();
  const violations = sourceFiles.flatMap((file) =>
    scanPublicImports(file, readFileSync(resolve(ROOT, file), "utf8"), publicPackageNames),
  );

  if (violations.length) {
    console.error(
      "Public import boundary check failed:\n" +
        violations
          .map(
            ({ file, line, specifier }) =>
              `  ${file}:${line}: import target ${JSON.stringify(specifier)} crosses into the internal workspace; ` +
              "move the integration under internal/ or extract shared code to a public package.",
          )
          .join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `Public import boundary is clear across ${sourceFiles.length} working-tree source files.`,
  );
}

// Preserve the public/internal import boundary documented in AGENTS.md.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main();
}
