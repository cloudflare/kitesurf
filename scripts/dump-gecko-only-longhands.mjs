#!/usr/bin/env node
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const stylo = execSync('find ~/.cargo/registry/src -name "longhands.toml" -path "*stylo-*"', {
  encoding: "utf8",
})
  .trim()
  .split("\n")[0];

if (!stylo) {
  console.error(
    "Couldn't find stylo's longhands.toml. Run `cargo fetch` from " + "packages/core first.",
  );
  process.exit(1);
}

const text = readFileSync(stylo, "utf8");
const re = /\n\[([a-z][a-z0-9-]*)\]\n([\s\S]*?)(?=\n\[[a-z]|\n*$)/g;
const gecko = [];
for (const m of text.matchAll(re)) {
  if (/engine\s*=\s*"gecko"/.test(m[2])) gecko.push(m[1]);
}
console.log(`Source: ${stylo}`);
console.log(`Total gecko-only longhands: ${gecko.length}`);
for (const name of gecko) console.log("  " + name);
