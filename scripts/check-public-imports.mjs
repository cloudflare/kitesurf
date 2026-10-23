// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// `bazel run //scripts:workspace_checks` starts in its runfiles tree and checks the workspace.
const ROOT = resolve(process.env.BUILD_WORKSPACE_DIRECTORY ?? resolve(import.meta.dirname, ".."));
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
const EXPLICITLY_EXCLUDED_FILES = new Set(["packages/dom-shim/src/editing/implementation.js"]);
const EXPLICITLY_EXCLUDED_PREFIXES = ["packages/engine/test/fixtures-worker/assets/"];

const PACKAGE_SCOPE = "@kitesurf/";

// Every @kitesurf/* package that is not a workspace package here belongs to the private
// overlay, which lives in a separate repository, so allow-list the public ones by reading
// their manifests instead of naming the private ones.
/** @param {string} [root]
 * @returns {Set<string>} */
export function readPublicPackageNames(root = ROOT) {
  const names = new Set();
  for (const dir of readdirSync(resolve(root, "packages"), { withFileTypes: true })) {
    addPublicPackageName(names, root, dir);
  }
  return names;
}

function addPublicPackageName(names, root, dir) {
  if (!dir.isDirectory()) return;
  const manifest = resolve(root, "packages", dir.name, "package.json");
  if (!existsSync(manifest)) return;
  const { name } = JSON.parse(readFileSync(manifest, "utf8"));
  if (typeof name === "string") names.add(name);
}

function hasExcludedPathSegment(file) {
  return file.split("/").some((segment) => EXCLUDED_SOURCE_SEGMENTS.has(segment));
}

function explicitlyExcluded(file) {
  return (
    EXPLICITLY_EXCLUDED_FILES.has(file) ||
    EXPLICITLY_EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix))
  );
}

function isPublicSourceFile(file) {
  if (file.startsWith("internal/")) return false;
  if (!SOURCE_EXTENSIONS.has(extname(file).toLowerCase())) return false;
  if (isDeclarationOrGenerated(file)) return false;
  if (explicitlyExcluded(file)) return false;
  return !hasExcludedPathSegment(file);
}

function isDeclarationOrGenerated(file) {
  return DECLARATION_FILE.test(file) || GENERATED_FILE.test(file);
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

function recordCallSpecifier(node, record) {
  const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
  if (isImport || isRequire) record(node, node.arguments[0]);
}

function recordImportTypeSpecifier(node, record) {
  if (!ts.isLiteralTypeNode(node.argument)) return;
  record(node, node.argument.literal);
}

function recordImportEqualsSpecifier(node, record) {
  if (!ts.isImportEqualsDeclaration(node)) return;
  if (!ts.isExternalModuleReference(node.moduleReference)) return;
  record(node, node.moduleReference.expression);
}

function recordModuleSpecifier(node, record) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    record(node, node.moduleSpecifier);
    return;
  }
  if (ts.isImportTypeNode(node)) {
    recordImportTypeSpecifier(node, record);
    return;
  }
  if (ts.isCallExpression(node)) {
    recordCallSpecifier(node, record);
    return;
  }
  recordImportEqualsSpecifier(node, record);
}

function visitImports(source, record) {
  function visit(node) {
    recordModuleSpecifier(node, record);
    ts.forEachChild(node, visit);
  }
  visit(source);
}

function recordReference(file, source, violations, position, specifier, isInternal) {
  if (!isInternal) return;
  const { line } = source.getLineAndCharacterOfPosition(position);
  violations.push({ file, line: line + 1, specifier });
}

function recordSourceReferences(file, source, publicPackageNames, violations) {
  for (const { pos, fileName } of source.referencedFiles) {
    recordReference(file, source, violations, pos, fileName, targetsInternalPath(file, fileName));
  }
  for (const { pos, fileName } of source.typeReferenceDirectives) {
    recordReference(
      file,
      source,
      violations,
      pos,
      fileName,
      targetsInternal(file, fileName, publicPackageNames),
    );
  }
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

  function record(node, literal) {
    const specifier = literalSpecifier(literal);
    if (specifier === undefined || !targetsInternal(file, specifier, publicPackageNames)) return;
    recordReference(file, source, violations, node.getStart(source), specifier, true);
  }

  visitImports(source, record);
  recordSourceReferences(file, source, publicPackageNames, violations);
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
