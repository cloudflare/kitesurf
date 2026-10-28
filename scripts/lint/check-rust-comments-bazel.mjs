// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// runfiles twin of check-rust-comments.mjs: sources arrive as argv paths instead of git ls-files.

import { readFileSync } from "node:fs";
import { checkCommentBlocks } from "./comment-policy.mjs";
import { scanRustComments } from "./rust-comments.mjs";

let violations = 0;
const files = process.argv.slice(2);
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const findings = checkCommentBlocks(source, scanRustComments(source), { tabWidth: 4 });
  for (const finding of findings) {
    console.error(`${file}:${finding.line}:${finding.column + 1}: ${finding.message}`);
  }
  violations += findings.length;
}
console.log(`Rust comments: ${files.length} authored files, ${violations} violations`);
if (violations > 0) process.exitCode = 1;
