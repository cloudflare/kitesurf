// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// `bazel run //scripts:workspace_checks` starts in its runfiles tree and checks the workspace.
const ROOT = resolve(process.env.BUILD_WORKSPACE_DIRECTORY ?? resolve(import.meta.dirname, ".."));
const GIT_FILE_LIST_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cts",
  ".css",
  ".h",
  ".htm",
  ".html",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".py",
  ".rs",
  ".sh",
  ".ts",
  ".tsx",
  ".xhtml",
]);
const VENDORED_MEMPROF = "vendor/wasm-memprof/instrumentor/src/";
const MEMPROF_MODIFIED = `${VENDORED_MEMPROF}lib.rs`;
const TODOMVC_SNAPSHOT = "packages/core/tests_data/angular_snapshot.html";
const GENERATED_WEBIDL = new Set([
  "packages/dom-shim/src/css-typed-om.webidl.generated.ts",
  "packages/dom-shim/src/idl/model.generated.ts",
  "packages/dom-shim/src/idl/runtime.generated.ts",
  "packages/dom-shim/src/idl/types.generated.ts",
]);

function exportedSourceFile(file) {
  return SOURCE_EXTENSIONS.has(extname(file).toLowerCase()) || file === ".githooks/post-checkout";
}

function licenseRequirements(file) {
  if (file === TODOMVC_SNAPSHOT) {
    return {
      copyright: ["Addy Osmani", "Sindre Sorhus", "Pascal Hartig", "Stephen Sawchuk"],
      license: ["MIT", "CC BY 4.0", "NOTICE"],
    };
  }
  if (GENERATED_WEBIDL.has(file)) {
    return {
      copyright: ["Cloudflare, Inc."],
      license: ["Apache 2.0", "WPT BSD-3-Clause", "Webref MIT", "NOTICE"],
    };
  }
  if (file.startsWith(VENDORED_MEMPROF)) {
    return {
      copyright: file === MEMPROF_MODIFIED ? ["Cloudflare, Inc.", "Yuta Saito"] : ["Yuta Saito"],
      license: ["MIT"],
    };
  }
  return {
    copyright: ["Cloudflare, Inc."],
    license: ["Apache 2.0"],
  };
}

/** @param {string} file @returns {string[]} */
export function copyrightHeaderLines(file) {
  if (file === TODOMVC_SNAPSHOT) {
    return [
      "TodoMVC Angular snapshot, adapted for Kitesurf regression tests.",
      "Copyright Addy Osmani, Sindre Sorhus, Pascal Hartig, and Stephen Sawchuk.",
      "TodoMVC is MIT-licensed; bundled app CSS is CC BY 4.0. See NOTICE and licenses/.",
    ];
  }
  if (GENERATED_WEBIDL.has(file)) {
    return [
      "Copyright (c) 2026 Cloudflare, Inc.",
      "Kitesurf generator output is licensed under Apache 2.0; see LICENSE.",
      "Derived IDL data retains WPT BSD-3-Clause and Webref MIT notices; see NOTICE and licenses/.",
    ];
  }
  if (file.startsWith(VENDORED_MEMPROF)) {
    if (file === MEMPROF_MODIFIED) {
      return [
        "Copyright (c) 2026 Cloudflare, Inc.",
        "Modifications are licensed under the MIT License; see LICENSE.",
        "Copyright (c) 2024 Yuta Saito.",
        "Licensed under the MIT License; see LICENSE.",
      ];
    }
    return ["Copyright (c) 2024 Yuta Saito.", "Licensed under the MIT License; see LICENSE."];
  }
  return [
    "Copyright (c) 2026 Cloudflare, Inc.",
    "Licensed under the Apache 2.0 license found in the LICENSE file or at:",
    "https://opensource.org/licenses/Apache-2.0",
  ];
}

/** @param {string} file
 * @param {string} [newline]
 * @returns {string} */
export function renderCopyrightHeader(file, newline = "\n") {
  const lines = copyrightHeaderLines(file);
  switch (commentStyle(file)) {
    case "html":
      return ["<!--", ...lines, "-->", "", ""].join(newline);
    case "block":
      return ["/*", ...lines.map((line) => ` * ${line}`), " */", "", ""].join(newline);
    case "hash":
      return [...lines.map((line) => `# ${line}`), "", ""].join(newline);
    case "line":
      return [...lines.map((line) => `// ${line}`), "", ""].join(newline);
  }
}

/** @param {string} file
 * @param {string} text
 * @returns {number} */
export function headerInsertionOffset(file, text) {
  const extension = extname(file).toLowerCase();
  let offset = text.startsWith("\uFEFF") ? 1 : 0;
  const consumeLine = (pattern) => {
    const end = text.indexOf("\n", offset);
    const line = text.slice(offset, end === -1 ? text.length : end).replace(/\r$/, "");
    if (!pattern.test(line)) return false;
    offset = end === -1 ? text.length : end + 1;
    return true;
  };

  consumeLine(/^#!/);
  if (extension === ".py") consumeLine(/^\s*#.*coding[:=]/);
  consumeLine(/^\s*<\?xml\b/);
  if (commentStyle(file) === "block") consumeLine(/^\s*@charset\b/i);
  if (extension === ".ts" || extension === ".tsx" || extension === ".mts" || extension === ".cts") {
    while (consumeLine(/^\s*\/\/\/?\s*<(?:reference|reference types)\b/i)) {}
  }
  if (extension === ".js" || extension === ".jsx" || extension === ".mjs" || extension === ".cjs") {
    while (consumeLine(/^\s*\/\/\s*@ts-(?:check|nocheck)\b/i)) {}
  }
  while (text.slice(offset).startsWith("\n") || text.slice(offset).startsWith("\r\n")) {
    offset += text.slice(offset).startsWith("\r\n") ? 2 : 1;
  }
  return offset;
}

function commentStyle(file) {
  const extension = extname(file).toLowerCase();
  if (extension === ".html" || extension === ".htm" || extension === ".xhtml") {
    return "html";
  }
  if (extension === ".css" || extension === ".c" || extension === ".h") {
    return "block";
  }
  if (extension === ".py" || extension === ".sh" || file === ".githooks/post-checkout") {
    return "hash";
  }
  return "line";
}

function initialCommentBlock(file, text) {
  const style = commentStyle(file);
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let start = 0;
  if (lines[start]?.startsWith("#!")) start += 1;
  if (extname(file).toLowerCase() === ".py" && /^\s*#.*coding[:=]/.test(lines[start] ?? "")) {
    start += 1;
  }
  if (/^\s*<\?xml\b/.test(lines[start] ?? "")) start += 1;
  if (style === "block" && /^\s*@charset\b/i.test(lines[start] ?? "")) start += 1;
  if ([".ts", ".tsx", ".mts", ".cts"].includes(extname(file).toLowerCase())) {
    while (/^\s*\/\/\/?\s*<(?:reference|reference types)\b/i.test(lines[start] ?? "")) start += 1;
  }
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extname(file).toLowerCase())) {
    while (/^\s*\/\/\s*@ts-(?:check|nocheck)\b/i.test(lines[start] ?? "")) start += 1;
  }
  while (lines[start] === "") start += 1;

  if (style === "html") {
    if (!lines[start]?.trimStart().startsWith("<!--")) return "";
    const block = [];
    for (let i = start; i < lines.length; i += 1) {
      block.push(lines[i]);
      if (lines[i].includes("-->")) break;
    }
    return block.join("\n");
  }
  if (style === "block") {
    if (!lines[start]?.trimStart().startsWith("/*")) return "";
    const block = [];
    for (let i = start; i < lines.length; i += 1) {
      block.push(lines[i]);
      if (lines[i].includes("*/")) break;
    }
    return block.join("\n");
  }

  const marker = style === "hash" ? /^\s*#/ : /^\s*\/\//;
  const block = [];
  for (let i = start; i < lines.length && marker.test(lines[i]); i += 1) {
    block.push(lines[i]);
  }
  return block.join("\n");
}

/** @param {string} file @returns {boolean} */
export function isExportedSourceFile(file) {
  return exportedSourceFile(file);
}

/** @param {string} file
 * @param {string} text
 * @returns {boolean} */
export function hasCopyrightLicenseHeader(file, text) {
  if (!exportedSourceFile(file)) return true;
  const block = initialCommentBlock(file, text);
  if (!block) return false;
  const requirements = licenseRequirements(file);
  return (
    requirements.copyright.every((holder) => block.includes(holder)) &&
    requirements.license.every((license) => block.includes(license))
  );
}

/** @param {string[]} files
 * @param {(file: string) => string} readFile
 * @returns {string[]} */
export function findMissingHeaders(files, readFile) {
  return files
    .filter(exportedSourceFile)
    .filter((file) => !hasCopyrightLicenseHeader(file, readFile(file)))
    .sort();
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
  const missing = findMissingHeaders(files, (file) => readFileSync(resolve(ROOT, file), "utf8"));
  if (missing.length) {
    console.error(
      `Missing copyright/license headers in ${missing.length} source files:\n` +
        missing.map((file) => `  ${file}`).join("\n"),
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `Copyright/license headers are present in ${files.filter(exportedSourceFile).length} source files.`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main();
}
