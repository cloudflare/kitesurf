// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Writes the Docker image's workerd config (//docker:workerd_config), which runs the engine dist
// on workerd alone, behind docker/front.js, and env.sh, the vars' defaults for the entry point.
// `--root` is the image directory that holds dist/, public/ and front.js.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

// The module types of packages/engine-server/server.mjs's ENGINE_RULES, by file name suffix.
const MODULE_TYPES = [
  [".wasm", "wasm"],
  [".glue.js", "text"],
  [".css", "text"],
  [".dat", "text"],
  [".woff2", "data"],
  [".bin", "data"],
];
// engine-mf.json keys that this config translates, and those it may only find empty.
const TRANSLATED = new Set([
  "compatibilityDate",
  "compatibilityFlags",
  "bindings",
  "workerLoaders",
]);
const EMPTY_ONLY = new Set(["email", "additionalUnboundDurableObjects", "tails", "streamingTails"]);
// The `assets` keys that docker/front.js implements. routerConfig derives from run_worker_first.
const ASSET_KEYS = new Set([
  "binding",
  "directory",
  "run_worker_first",
  "routerConfig",
  "assetConfig",
]);
const ASSET_CONFIG_KEYS = new Set(["compatibility_date", "compatibility_flags"]);
// Wrangler's `run_worker_first` routes, which docker/front.js sends to the engine first.
const WORKER_FIRST = ["/", "/rbi/*"];
// The secret that wrangler.jsonc documents but cannot list among its vars.
const SECRETS = ["WEB_BOT_AUTH_JWK"];

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const flag = (name) =>
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith(`--${name}=`))
    .map((arg) => arg.slice(name.length + 3));
const [dist, containerVarsFile, configOut, envOut] = positional;
const [root] = flag("root");
if (!dist || !containerVarsFile || !configOut || !envOut || !root) {
  console.error(
    "usage: node scripts/workerd-config.mjs <dist> <container-vars.json> <config.capnp> " +
      "<env.sh> --root=<image dir> [--v8-flag=<flag>]...",
  );
  process.exit(2);
}

const options = JSON.parse(readFileSync(resolve(dist, "engine-mf.json"), "utf8"));
const isEmpty = (value) =>
  Array.isArray(value)
    ? value.length === 0
    : typeof value === "object" && value !== null && Object.values(value).every(isEmpty);
for (const [key, value] of Object.entries(options)) {
  if (TRANSLATED.has(key) || key === "assets" || (EMPTY_ONLY.has(key) && isEmpty(value))) continue;
  throw new Error(
    `engine-mf.json sets ${key}, which the image's workerd config does not translate`,
  );
}
for (const key of Object.keys(options.assets ?? {})) {
  if (!ASSET_KEYS.has(key)) throw new Error(`assets.${key} is not translated; update front.js`);
}
for (const key of Object.keys(options.assets?.assetConfig ?? {})) {
  if (!ASSET_CONFIG_KEYS.has(key)) {
    throw new Error(`assets.assetConfig.${key} is not translated; update front.js`);
  }
}
const runWorkerFirst = options.assets?.run_worker_first ?? [];
if (JSON.stringify(runWorkerFirst) !== JSON.stringify(WORKER_FIRST)) {
  throw new Error(`assets.run_worker_first is ${JSON.stringify(runWorkerFirst)}; update front.js`);
}
const publicDir = resolve(dist, options.assets.directory);
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
const vars = { ...options.bindings, ...JSON.parse(readFileSync(containerVarsFile, "utf8")) };

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
  ...Object.keys(options.workerLoaders ?? {}).map(
    (name) => `(name = ${text(name)}, workerLoader = ())`,
  ),
  `(name = ${text(options.assets.binding)}, service = (name = "front", entrypoint = "Assets"))`,
];
// Native eval is an experimental flag that the engine grants its page isolates, which only an
// engine with `experimental` may do; KITESURF_NATIVE_EVAL decides at run time.
const compatibilityFlags = [...new Set([...(options.compatibilityFlags ?? []), "experimental"])];

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
  compatibilityDate = ${text(options.compatibilityDate)},
  modules = [(name = "front.js", esModule = embed "front.js")],
  bindings = [
    (name = "ENGINE", service = "kitesurf"),
    (name = "PUBLIC", service = "public"),
    (name = "HEADERS", json = ${text(JSON.stringify(HEADER_RULES))}),
  ],
);

const engine :Workerd.Worker = (
  compatibilityDate = ${text(options.compatibilityDate)},
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
