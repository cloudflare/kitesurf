// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Stamp a merged WPT report without parsing its potentially large per-test rows.

import { readFileSync, writeFileSync } from "node:fs";
import { isMain } from "./wpt-shared.mjs";

/** @param {Buffer} input @param {{commit?: string, ref?: string, date?: string}} metadata @returns {Buffer} */
export function stamp(input, metadata) {
  const head = input.subarray(0, 8192).toString("latin1");
  const end = head.search(/"(byFile|results)":/);
  if (end < 0) throw new Error("not a merged WPT report: no byFile or results near the top");
  const ascii = (value) =>
    JSON.stringify(value).replace(
      /[^\x20-\x7e]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  let prefix = head.slice(0, end);
  for (const [key, value] of Object.entries(metadata)) {
    if (value)
      prefix = prefix.replace(
        new RegExp(`("${key}":\\s*)(null|"[^"]*")`),
        (_, field) => field + ascii(value),
      );
  }
  return Buffer.concat([Buffer.from(prefix, "latin1"), input.subarray(end)]);
}

if (isMain(import.meta.url)) {
  const metadata = {
    commit: process.env.CI_COMMIT_SHORT_SHA,
    ref: process.env.CI_COMMIT_REF_NAME,
    date: new Date().toISOString(),
  };
  for (const file of process.argv.slice(2))
    writeFileSync(file, stamp(readFileSync(file), metadata));
}
