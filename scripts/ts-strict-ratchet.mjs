// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const TSC_OUTPUT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

function missingOption(required) {
  if (!required) return null;
  console.error(
    `usage: ts-strict-ratchet.mjs --project <tsconfig> [--baseline <json>] [--only <dir>] [--update]`,
  );
  process.exit(2);
}

function option(name, { required = true } = {}) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) {
    return missingOption(required);
  }
  return path.resolve(process.argv[index + 1]);
}

const project = option("--project");
const update = process.argv.includes("--update");
const baselinePath = option("--baseline", { required: update });
const only = option("--only", { required: false });
const projectDir = path.dirname(project);
const onlyPrefix = only ? `${path.relative(projectDir, only).split(path.sep).join("/")}/` : null;
const tsc = createRequire(project).resolve("typescript/bin/tsc");

let output = "";
try {
  output = execFileSync(process.execPath, [tsc, "--noEmit", "--pretty", "false", "-p", project], {
    cwd: projectDir,
    encoding: "utf8",
    maxBuffer: TSC_OUTPUT_MAX_BUFFER_BYTES,
  });
} catch (error) {
  output = String(error.stdout ?? "");
  if (!output) throw error;
}

const counts = {};
for (const line of output.split("\n")) {
  const match = /^(.+?)\(\d+,\d+\): error TS\d+:/.exec(line);
  if (!match) continue;
  const file = path
    .relative(projectDir, path.resolve(projectDir, match[1]))
    .split(path.sep)
    .join("/");
  if (onlyPrefix && !file.startsWith(onlyPrefix)) continue;
  counts[file] = (counts[file] ?? 0) + 1;
}
const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)));
const total = Object.values(sorted).reduce((sum, count) => sum + count, 0);

if (update) {
  fs.writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(
    `[strict-ratchet] wrote ${path.relative(process.cwd(), baselinePath)}: ${total} errors in ${Object.keys(sorted).length} files`,
  );
  process.exit(0);
}

const baseline =
  baselinePath && fs.existsSync(baselinePath)
    ? JSON.parse(fs.readFileSync(baselinePath, "utf8"))
    : {};
const problems = [];
for (const file of new Set([...Object.keys(baseline), ...Object.keys(sorted)])) {
  const was = baseline[file] ?? 0;
  const now = sorted[file] ?? 0;
  if (now > was) problems.push(`${file}: ${now} strict errors, baseline allows ${was}`);
  else if (now < was) problems.push(`${file}: ${now} strict errors, below the baseline of ${was}`);
}
if (problems.length) {
  for (const problem of problems) console.error(`[strict-ratchet] ${problem}`);
  console.error(
    "[strict-ratchet] fix the new errors" +
      (baselinePath
        ? ", or after an intended change run\n" +
          `  node ${path.relative(process.cwd(), fileURLToPath(import.meta.url))} --project ${path.relative(process.cwd(), project)} ` +
          `--baseline ${path.relative(process.cwd(), baselinePath)} --update`
        : ""),
  );
  process.exit(1);
}
console.log(`[strict-ratchet] ${total} strict errors, matching the baseline`);
