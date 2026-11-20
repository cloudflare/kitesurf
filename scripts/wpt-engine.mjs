// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Build and launch the public Worker dist used by local and Bazel WPT runs.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { OPTIONS_FILE, startEngine } from "../packages/engine-server/server.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const ENGINE_DIR = resolve(ROOT, "packages/engine");
export const DEFAULT_DIST = resolve(ENGINE_DIR, ".wpt-dist");
const fromEngine = createRequire(resolve(ENGINE_DIR, "package.json"));
const engineDep = (name) => import(pathToFileURL(fromEngine.resolve(name)).href);
const USAGE = `usage: node scripts/wpt-engine.mjs prepare [--dist <dir>] [--config <file>]
       node scripts/wpt-engine.mjs serve --port <n> [--dist <dir>] [--assets <dir>]
                                  [--inspector-port <n>] [--var KEY:VALUE]...
                                  [--v8-flags "<flags>"]`;

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
    if (arg === "--config") options.config = resolve(next());
    else if (arg === "--dist") options.dist = resolve(next());
    else if (arg === "--assets") options.assets = resolve(next());
    else if (arg === "--port") options.port = Number(next());
    else if (arg === "--inspector-port") options.inspectorPort = Number(next());
    else if (arg === "--v8-flags") {
      // An empty value is allowed: it turns off flags the environment would pass.
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      options.v8Flags = argv[++i];
    } else if (arg === "--var") {
      const value = next();
      const at = value.indexOf(":");
      if (at < 1) throw new Error(`--var wants KEY:VALUE, got ${value}`);
      options.vars[value.slice(0, at)] = value.slice(at + 1);
    } else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

/** @param {string} dist @param {string} config @returns {Promise<object>} */
export async function prepare(dist = DEFAULT_DIST, config = resolve(ENGINE_DIR, "wrangler.jsonc")) {
  const wranglerPackage = fromEngine.resolve("wrangler/package.json");
  const wrangler = resolve(
    dirname(wranglerPackage),
    JSON.parse(readFileSync(wranglerPackage, "utf8")).bin.wrangler,
  );
  execFileSync(
    process.execPath,
    [wrangler, "deploy", "--dry-run", "--config", config, "--outdir", dist],
    {
      cwd: dirname(config),
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  rmSync(resolve(dist, "README.md"), { force: true });
  const mapFile = resolve(dist, "index.js.map");
  const map = JSON.parse(readFileSync(mapFile, "utf8"));
  writeFileSync(mapFile, JSON.stringify({ ...map, sourceRoot: "" }));
  const { unstable_getMiniflareWorkerOptions } = await engineDep("wrangler");
  const { workerOptions } = unstable_getMiniflareWorkerOptions(config);
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

async function serve(options) {
  // Miniflare reads workerd's V8 flags from this variable, split on single spaces.
  if (options.v8Flags !== undefined)
    process.env.MINIFLARE_WORKERD_V8_FLAGS = options.v8Flags.trim().split(/\s+/).join(" ");
  const { miniflare, url } = await startEngine(options);
  const v8Flags = process.env.MINIFLARE_WORKERD_V8_FLAGS;
  console.log(
    `[wpt-engine] ready on ${url.href} (dist ${options.dist}${v8Flags ? `, V8 flags ${v8Flags}` : ""})`,
  );
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
  if (command === "prepare") await prepare(options.dist, options.config);
  else if (command === "serve") await serve(options);
  else {
    console.error(USAGE);
    process.exit(2);
  }
}
