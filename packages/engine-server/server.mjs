// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Serves the engine dist that `wpt-engine.mjs prepare` writes (//packages/engine:dist) on
// Miniflare.

import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Miniflare, compileModuleRules, convertV4MiniflareOptions, testRegExps } from "miniflare";

/** The Miniflare worker options that `prepare` writes beside the bundle. */
export const OPTIONS_FILE = "engine-mf.json";

const ENGINE_RULES = [
  { type: "CompiledWasm", include: ["**/*.wasm"] },
  { type: "Text", include: ["**/*.glue.js", "*.css", "**/*.css", "**/*.dat"] },
  { type: "Data", include: ["**/*.woff2", "**/*.bin"] },
];

function distModules(root, entry, compiledRules) {
  const modules = [{ type: "ESModule", path: resolve(root, entry) }];
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = resolve(dir, item.name);
      if (item.isDirectory()) {
        walk(full);
        continue;
      }
      const name = relative(root, full).replaceAll("\\", "/");
      if (name === entry) continue;
      const rule = compiledRules.find((candidate) => testRegExps(candidate.include, name));
      if (rule) modules.push({ type: rule.type, path: full });
    }
  };
  walk(root);
  return modules;
}

/** Starts the engine in `dist`; `assets` replaces its assets directory, `vars` its bindings.
 * @param {{dist: string, port: number, host?: string, assets?: string,
 *   inspectorPort?: number, vars?: Record<string, string>}} options
 * @returns {Promise<{miniflare: Miniflare, url: URL}>} */
export async function startEngine(options) {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error(`the engine needs a valid port, got ${options.port}`);
  }
  const workerOptions = JSON.parse(readFileSync(resolve(options.dist, OPTIONS_FILE), "utf8"));
  const assets = workerOptions.assets && {
    ...workerOptions.assets,
    directory: options.assets ?? resolve(options.dist, workerOptions.assets.directory),
  };
  const bindings = { ...workerOptions.bindings, ...options.vars };
  // Page isolates get native eval as an experimental flag, which only an engine with the
  // `experimental` flag may grant (pageScriptCompatOptions in the engine).
  const compatibilityFlags =
    bindings.KITESURF_NATIVE_EVAL === "1"
      ? [...new Set([...(workerOptions.compatibilityFlags ?? []), "experimental"])]
      : workerOptions.compatibilityFlags;
  const engine = {
    ...workerOptions,
    name: "kitesurf-engine",
    modulesRoot: options.dist,
    modules: distModules(options.dist, "index.js", compileModuleRules(ENGINE_RULES)),
    compatibilityFlags,
    bindings,
    assets,
  };
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      host: options.host ?? "127.0.0.1",
      port: options.port,
      inspectorPort: options.inspectorPort,
      cf: false,
      workers: [engine],
    }),
  );
  return { miniflare, url: await miniflare.ready };
}
