// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Writes the vars that the Docker image sets over the engine's production ones
// (//docker:container_vars): the dev server's DevTools frontend pair, pinned in wrangler.jsonc.

import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const KEYS = ["KITESURF_INSPECTOR_BASE_URL", "KITESURF_INSPECTOR_FALLBACK_URL"];

const [config, out] = process.argv.slice(2);
if (!config || !out) {
  console.error("usage: node scripts/container-vars.mjs <wrangler.jsonc> <out.json>");
  process.exit(2);
}
const fromEngine = createRequire(resolve(import.meta.dirname, "../packages/engine/package.json"));
const { experimental_readRawConfig } = await import(
  pathToFileURL(fromEngine.resolve("wrangler")).href
);
const { rawConfig } = experimental_readRawConfig({ config: resolve(config) });
const local = rawConfig.env?.local?.vars ?? {};
const vars = {};
for (const key of KEYS) {
  if (typeof local[key] !== "string") throw new Error(`env.local.vars.${key} is not a string`);
  vars[key] = local[key];
}
writeFileSync(resolve(out), JSON.stringify(vars, null, 2) + "\n");
