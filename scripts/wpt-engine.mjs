// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Build and launch the public Worker dist used by local and Bazel WPT runs.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const ENGINE_DIR = resolve(ROOT, "packages/engine");
export const DEFAULT_DIST = resolve(ENGINE_DIR, ".wpt-dist");
const OPTIONS_FILE = "engine-mf.json";
const fromEngine = createRequire(resolve(ENGINE_DIR, "package.json"));
const engineDep = (name) => import(pathToFileURL(fromEngine.resolve(name)).href);
const USAGE = `usage: node scripts/wpt-engine.mjs prepare [--dist <dir>]
       node scripts/wpt-engine.mjs serve --port <n> [--dist <dir>] [--assets <dir>]
                                  [--inspector-port <n>] [--var KEY:VALUE]...`;

const ENGINE_RULES = [
  { type: "CompiledWasm", include: ["**/*.wasm"] },
  { type: "Text", include: ["**/*.glue.js", "*.css", "**/*.css"] },
  { type: "Data", include: ["**/*.woff2"] },
];

const DROP = new Set([
  "rootPath",
  "modulesRules",
  "unsafeBindings",
  "zone",
  "access",
  "versionMetadata",
]);

function parseArgs(argv) {
  const options = { dist: DEFAULT_DIST, vars: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--dist") options.dist = resolve(next());
    else if (arg === "--assets") options.assets = resolve(next());
    else if (arg === "--port") options.port = Number(next());
    else if (arg === "--inspector-port") options.inspectorPort = Number(next());
    else if (arg === "--var") {
      const value = next();
      const at = value.indexOf(":");
      if (at < 1) throw new Error(`--var wants KEY:VALUE, got ${value}`);
      options.vars[value.slice(0, at)] = value.slice(at + 1);
    } else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

/** @param {string} dist @returns {Promise<object>} */
export async function prepare(dist = DEFAULT_DIST) {
  const wranglerPackage = fromEngine.resolve("wrangler/package.json");
  const wrangler = resolve(
    dirname(wranglerPackage),
    JSON.parse(readFileSync(wranglerPackage, "utf8")).bin.wrangler,
  );
  execFileSync(
    process.execPath,
    [wrangler, "deploy", "--dry-run", "--config", "wrangler.jsonc", "--outdir", dist],
    {
      cwd: ENGINE_DIR,
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  rmSync(resolve(dist, "README.md"), { force: true });
  const mapFile = resolve(dist, "index.js.map");
  const map = JSON.parse(readFileSync(mapFile, "utf8"));
  writeFileSync(mapFile, JSON.stringify({ ...map, sourceRoot: "" }));
  const { unstable_getMiniflareWorkerOptions } = await engineDep("wrangler");
  const { workerOptions } = unstable_getMiniflareWorkerOptions(
    resolve(ENGINE_DIR, "wrangler.jsonc"),
  );
  const options = {};
  for (const [key, value] of Object.entries(workerOptions)) {
    if (DROP.has(key) || value === undefined) continue;
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    )
      continue;
    options[key] = value;
  }
  if (options.assets)
    options.assets = { ...options.assets, directory: relative(dist, options.assets.directory) };
  writeFileSync(resolve(dist, OPTIONS_FILE), JSON.stringify(options, null, 1) + "\n");
  return options;
}

function distModules(root, entry, testRegExps, compiledRules) {
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

async function serve(options) {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("serve needs a valid --port");
  }
  const { Miniflare, compileModuleRules, convertV4MiniflareOptions, testRegExps } =
    await engineDep("miniflare");
  const workerOptions = JSON.parse(readFileSync(resolve(options.dist, OPTIONS_FILE), "utf8"));
  const assets = workerOptions.assets && {
    ...workerOptions.assets,
    directory: options.assets ?? resolve(options.dist, workerOptions.assets.directory),
  };
  const engine = {
    ...workerOptions,
    name: "kitesurf-engine",
    modulesRoot: options.dist,
    modules: distModules(options.dist, "index.js", testRegExps, compileModuleRules(ENGINE_RULES)),
    bindings: { ...workerOptions.bindings, ...options.vars },
    assets,
  };
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      host: "127.0.0.1",
      port: options.port,
      inspectorPort: options.inspectorPort,
      cf: false,
      workers: [engine],
    }),
  );
  const url = await miniflare.ready;
  console.log(`[wpt-engine] ready on ${url.href} (dist ${options.dist})`);
  const stop = async () => {
    await miniflare.dispose().catch(() => {});
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const options = parseArgs(args);
  if (command === "prepare") await prepare(options.dist);
  else if (command === "serve") await serve(options);
  else {
    console.error(USAGE);
    process.exit(2);
  }
}
