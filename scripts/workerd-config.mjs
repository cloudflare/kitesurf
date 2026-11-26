// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Writes the Docker image's workerd config (//docker:workerd_config), which runs the engine dist
// on workerd alone, behind docker/front.js, and env.sh, the vars' defaults for the entry point.
// Both come from the engine's wrangler.jsonc. `--root` is the image directory that holds dist/,
// public/ and front.js.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The module types of packages/engine-server/server.mjs's ENGINE_RULES, by file name suffix.
const MODULE_TYPES = [
  [".wasm", "wasm"],
  [".glue.js", "text"],
  [".css", "text"],
  [".dat", "text"],
  [".woff2", "data"],
  [".bin", "data"],
];
// The top-level wrangler.jsonc keys that this config translates, and those that do not apply to
// the image: the bundle is already built, the image has no Cloudflare limits or observability,
// and it runs the top-level config, not an env.
const TRANSLATED = new Set([
  "compatibility_date",
  "compatibility_flags",
  "vars",
  "worker_loaders",
  "assets",
]);
const IGNORED = new Set(["$schema", "name", "main", "rules", "observability", "limits", "env"]);
// The `assets` keys that docker/front.js implements.
const ASSET_KEYS = new Set(["binding", "directory", "run_worker_first"]);
// Wrangler's `run_worker_first` routes, which docker/front.js sends to the engine first.
const WORKER_FIRST = ["/", "/rbi/*"];
// The vars that the image takes from env.local: the dev server's DevTools frontend pair.
const LOCAL_VARS = ["KITESURF_INSPECTOR_BASE_URL", "KITESURF_INSPECTOR_FALLBACK_URL"];
// The secret that wrangler.jsonc documents but cannot list among its vars.
const SECRETS = ["WEB_BOT_AUTH_JWK"];

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const flag = (name) =>
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith(`--${name}=`))
    .map((arg) => arg.slice(name.length + 3));
const [dist, wranglerConfig, configOut, envOut] = positional;
const [root] = flag("root");
if (!dist || !wranglerConfig || !configOut || !envOut || !root) {
  console.error(
    "usage: node scripts/workerd-config.mjs <dist> <wrangler.jsonc> <config.capnp> " +
      "<env.sh> --root=<image dir> [--v8-flag=<flag>]...",
  );
  process.exit(2);
}

const fromEngine = createRequire(resolve(import.meta.dirname, "../packages/engine/package.json"));
const { experimental_readRawConfig } = await import(
  pathToFileURL(fromEngine.resolve("wrangler")).href
);
const { rawConfig: wrangler } = experimental_readRawConfig({ config: resolve(wranglerConfig) });
for (const key of Object.keys(wrangler)) {
  if (TRANSLATED.has(key) || IGNORED.has(key)) continue;
  throw new Error(
    `wrangler.jsonc sets ${key}, which the image's workerd config does not translate`,
  );
}
const assets = wrangler.assets ?? {};
for (const key of Object.keys(assets)) {
  if (!ASSET_KEYS.has(key)) throw new Error(`assets.${key} is not translated; update front.js`);
}
const runWorkerFirst = assets.run_worker_first ?? [];
if (JSON.stringify(runWorkerFirst) !== JSON.stringify(WORKER_FIRST)) {
  throw new Error(`assets.run_worker_first is ${JSON.stringify(runWorkerFirst)}; update front.js`);
}
const loaders = (wrangler.worker_loaders ?? []).map((loader) => {
  const keys = Object.keys(loader);
  if (keys.length !== 1 || keys[0] !== "binding") {
    throw new Error(`worker_loaders sets ${JSON.stringify(loader)}; only binding is translated`);
  }
  return loader.binding;
});
const localVars = wrangler.env?.local?.vars ?? {};
const vars = { ...wrangler.vars };
for (const key of LOCAL_VARS) {
  if (typeof localVars[key] !== "string") throw new Error(`env.local.vars.${key} is not a string`);
  vars[key] = localVars[key];
}
for (const [key, value] of Object.entries(vars)) {
  if (typeof value !== "string") throw new Error(`vars.${key} is not a string`);
}
const publicDir = resolve(dirname(wranglerConfig), assets.directory);
if (existsSync(resolve(publicDir, "_redirects"))) {
  throw new Error("public/_redirects is not translated; update front.js");
}

/** Compiles Cloudflare's `_headers` format into docker/front.js's rules. Supports path patterns
 * with `*` splats, `Name: value` and `! Name` lines; anything else fails the build. */
const headerRules = function (source) {
  const rules = [];
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const fail = (why) => {
      throw new Error(`public/_headers:${index + 1}: ${why}: ${raw}`);
    };
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      if (!/^\/[\w\-./*]*$/.test(line)) fail("only path patterns with `*` are translated");
      const pattern = `^${line.replaceAll(".", "\\.").replaceAll("*", ".*")}$`;
      rules.push({ pattern, set: [], unset: [] });
      continue;
    }
    const rule = rules.at(-1) ?? fail("a header before any path");
    const unset = /^!\s*([\w-]+)$/.exec(line);
    const set = /^([\w-]+):\s*(.*)$/.exec(line);
    if (unset) rule.unset.push(unset[1].toLowerCase());
    else if (set) rule.set.push([set[1].toLowerCase(), set[2]]);
    else fail("not a header");
  }
  return rules;
};
const headersFile = resolve(publicDir, "_headers");
const HEADER_RULES = existsSync(headersFile) ? headerRules(readFileSync(headersFile, "utf8")) : [];
/** Whether docker/front.js serves a path base from public/: it must name a file, and front.js
 * takes only a name with an extension for one. */
const servesInspector = function (base) {
  if (!base.startsWith("/")) return false;
  const { pathname } = new URL(base, "http://public");
  if (!/\.[a-z0-9]+$/i.test(pathname)) return false;
  return statSync(resolve(publicDir, `.${pathname}`), { throwIfNoEntry: false })?.isFile() === true;
};
// With a fallback, the engine probes public/ once for a path base and keeps the answer, so one
// failed probe would send Chrome to the fallback until the container restarts. A base that the
// image serves needs neither: without a fallback, the engine uses the base and never probes.
if (servesInspector(vars.KITESURF_INSPECTOR_BASE_URL ?? "")) {
  vars.KITESURF_INSPECTOR_FALLBACK_URL = "";
}

const text = (value) => {
  if (!/^[\x20-\x7e]*$/.test(value)) throw new Error(`not printable ASCII: ${value}`);
  return JSON.stringify(value);
};
const list = (items, indent) => items.map((item) => `\n${indent}${item},`).join("");

const files = [];
const walk = (dir) => {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, item.name);
    if (item.isDirectory()) walk(full);
    else files.push(relative(dist, full).replaceAll("\\", "/"));
  }
};
walk(resolve(dist));
files.sort();
if (!files.includes("index.js")) throw new Error(`${dist} has no index.js`);
const modules = [`(name = "index.js", esModule = embed "dist/index.js")`];
for (const name of files) {
  const type = MODULE_TYPES.find(([suffix]) => name.endsWith(suffix))?.[1];
  if (type) modules.push(`(name = ${text(name)}, ${type} = embed ${text(`dist/${name}`)})`);
}

const bindings = [
  ...[...Object.keys(vars), ...SECRETS].map(
    (name) => `(name = ${text(name)}, fromEnvironment = ${text(name)})`,
  ),
  ...loaders.map((name) => `(name = ${text(name)}, workerLoader = ())`),
  `(name = ${text(assets.binding)}, service = (name = "front", entrypoint = "Assets"))`,
];
// Native eval is an experimental flag that the engine grants its page isolates, which only an
// engine with `experimental` may do; KITESURF_NATIVE_EVAL decides at run time.
const compatibilityFlags = [...new Set([...(wrangler.compatibility_flags ?? []), "experimental"])];

const config = `# Generated by scripts/workerd-config.mjs (//docker:workerd_config). Do not edit.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "front", worker = .front),
    (name = "kitesurf", worker = .engine),
    (name = "public", disk = (path = ${text(`${root}/public`)})),
    # Miniflare's outbound network: public and private addresses, as a local runtime reaches.
    (
      name = "internet",
      network = (allow = ["public", "private", "240.0.0.0/4"], tlsOptions = (trustBrowserCas = true)),
    ),
  ],
  sockets = [(name = "http", address = "*:8787", http = (), service = "front")],
  v8Flags = [${flag("v8-flag").map(text).join(", ")}],
);

const front :Workerd.Worker = (
  compatibilityDate = ${text(wrangler.compatibility_date)},
  modules = [(name = "front.js", esModule = embed "front.js")],
  bindings = [
    (name = "ENGINE", service = "kitesurf"),
    (name = "PUBLIC", service = "public"),
    (name = "HEADERS", json = ${text(JSON.stringify(HEADER_RULES))}),
  ],
);

const engine :Workerd.Worker = (
  compatibilityDate = ${text(wrangler.compatibility_date)},
  compatibilityFlags = [${compatibilityFlags.map(text).join(", ")}],
  modules = [${list(modules, "    ")}
  ],
  bindings = [${list(bindings, "    ")}
  ],
);
`;

const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
const env = [
  "# Generated by scripts/workerd-config.mjs (//docker:workerd_config). Do not edit.",
  "# The engine vars' image defaults. A variable that is already set, even to '', keeps its value.",
  ...Object.entries(vars).map(
    ([name, value]) => `[ "\${${name}+set}" = set ] || ${name}=${quote(value)}; export ${name}`,
  ),
  "",
].join("\n");

writeFileSync(resolve(configOut), config);
writeFileSync(resolve(envOut), env);
