// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkCommentBlocks } from "./comment-policy.mjs";
import { scanRustComments } from "./rust-comments.mjs";
import { ROOT, sourceFiles } from "./scope.mjs";

let violations = 0;
const files = sourceFiles(["rs"]);
for (const file of files) {
  const source = readFileSync(resolve(ROOT, file), "utf8");
  const findings = checkCommentBlocks(source, scanRustComments(source), { tabWidth: 4 });
  for (const finding of findings) {
    console.error(`${file}:${finding.line}:${finding.column + 1}: ${finding.message}`);
  }
  violations += findings.length;
}
console.log(`Rust comments: ${files.length} authored files, ${violations} violations`);
if (violations > 0) process.exitCode = 1;
