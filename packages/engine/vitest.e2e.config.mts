// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { compileModuleRules, testRegExps } from "miniflare";
import { unstable_getMiniflareWorkerOptions } from "wrangler";
import { defineConfig } from "vitest/config";

import { WBA_TEST_PRIVATE_JWK, WBA_TEST_SIGNATURE_AGENT } from "./test/e2e/wba-test-key.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIST = resolve(HERE, process.env.KS_E2E_ENGINE_DIST ?? "test/e2e/.engine-dist");
const FIXTURES_DIST = resolve(HERE, process.env.KS_E2E_FIXTURES_DIST ?? "test/e2e/.fixtures-dist");

type ModuleRule = Parameters<typeof compileModuleRules>[0][number];
type WranglerWorkerOptions = ReturnType<typeof unstable_getMiniflareWorkerOptions>["workerOptions"];

function defaultIfUndefined<T>(value: T | undefined, fallback: T): T {
  return value ?? fallback;
}

function makeVitestOptions(opts: EngineE2EOptions) {
  return {
    // Vitest's default CSS stub would erase raw fixture response bytes.
    css: { include: [/\.css\?raw$/] },
    globalSetup: [resolve(HERE, "test/e2e/global-setup.ts")],
    dir: defaultIfUndefined(opts.dir, HERE),
    include: defaultIfUndefined(opts.include, ["test/e2e/**/*.e2e.test.ts"]),
    ...(opts.exclude ? { exclude: opts.exclude } : {}),
    isolate: false,
    testTimeout: 120_000,
    hookTimeout: 300_000,
  };
}

function distModules(root: string, entry: string, rules: ModuleRule[]) {
  const compiled = compileModuleRules(rules);
  const modules = [{ type: "ESModule", path: resolve(root, entry) }];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = resolve(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      const name = relative(root, full).replaceAll("\\", "/");
      if (name === entry) continue;
      const rule = compiled.find((r) => testRegExps(r.include, name));
      if (rule) modules.push({ type: rule.type, path: full });
    }
  };
  walk(root);
  return modules;
}

const otlpCaptureWorker = {
  name: "kitesurf-otlp-capture",
  modules: true,
  modulesRoot: resolve(HERE, "test/e2e"),
  scriptPath: resolve(HERE, "test/e2e/otlp-capture-worker.mjs"),
  compatibilityDate: "2026-09-11",
};

const CORE_PKG = resolve(HERE, "../core/pkg");
const coreWasmWorker = {
  name: "kitesurf-core-wasm",
  modulesRoot: resolve(HERE, ".."),
  modules: [
    { type: "ESModule", path: resolve(HERE, "test/e2e/core-wasm-worker.mjs") },
    { type: "ESModule", path: resolve(CORE_PKG, "kitesurf_core.js") },
    { type: "CompiledWasm", path: resolve(CORE_PKG, "kitesurf_core_bg.wasm") },
  ],
  compatibilityDate: "2026-09-11",
};

const sceneHostWorker = {
  name: "kitesurf-scene-host",
  modulesRoot: HERE,
  modules: [
    { type: "ESModule", path: resolve(HERE, "test/e2e/scene-host-worker.mjs") },
    { type: "CompiledWasm", path: resolve(HERE, "public/rbi/scene_host.wasm") },
  ],
  compatibilityDate: "2026-09-11",
};

// Mirrors the rules in the fixtures worker's wrangler.jsonc: fixture
// bodies are real files under assets/, not literals in serve.ts.
const FIXTURES_RULES: ModuleRule[] = [
  {
    type: "Text",
    include: ["**/*.html", "**/*.css", "**/*.svg", "**/*.js", "**/*.mjs", "**/*.txt", "**/*.json"],
  },
  { type: "Data", include: ["**/*.woff2", "**/*.png", "**/*.wasm", "**/*.bin"] },
];

const fixturesWorker = {
  name: "kitesurf-fixtures",
  modulesRoot: FIXTURES_DIST,
  compatibilityDate: "2026-09-11",
  get modules() {
    return distModules(FIXTURES_DIST, "index.js", FIXTURES_RULES);
  },
};

export interface EngineE2EOptions {
  wranglerConfig: string;
  engineDist: string;
  dir?: string;
  include?: string[];
  exclude?: string[];
  workers?: object[];
  fixtureWorkers?: Array<{
    name: string;
    wranglerConfig: string;
    outdir: string;
    serviceBindings?: Record<string, unknown>;
  }>;
  bindings?: Record<string, string>;
  serviceBindings?: Record<string, unknown>;
  engineServiceBindings?: Record<string, unknown>;
  engineBindings?: Record<string, unknown>;
  engineDurableObjects?: WranglerWorkerOptions["durableObjects"];
  // More engine instances built from the same dist, for hosts whose tests
  // need an engine with another outbound or other bindings.
  extraEngines?: Array<{
    name: string;
    outboundService: string;
    bindings?: Record<string, unknown>;
  }>;
}

type EngineBindings = Record<string, unknown>;

function setE2eEnvironment(opts: EngineE2EOptions): void {
  process.env.KS_E2E_WRANGLER_CONFIG = opts.wranglerConfig;
  process.env.KS_E2E_ENGINE_DIST = opts.engineDist;
  process.env.KS_E2E_FIXTURE_WORKER_BUILDS = JSON.stringify(
    (opts.fixtureWorkers ?? []).map(({ wranglerConfig, outdir }) => ({
      wranglerConfig,
      outdir,
    })),
  );
}

function configureEngineBindings(opts: EngineE2EOptions, wo: EngineBindings): EngineBindings {
  if (opts.engineDurableObjects) {
    const existing = wo.durableObjects;
    wo.durableObjects = {
      ...(typeof existing === "object" && existing !== null ? existing : {}),
      ...opts.engineDurableObjects,
    };
  }
  wo.serviceBindings = {
    ...(wo.serviceBindings as Record<string, unknown> | undefined),
    FIXTURES: "kitesurf-fixtures",
    ...opts.engineServiceBindings,
    OTLP_CAPTURE: "kitesurf-otlp-capture",
  };
  const engineBindings = {
    ...(wo.bindings as Record<string, unknown> | undefined),
    KITESURF_ENV: "local",
    // Route tests cover a configured hosted inspector on the main engine
    // and Chrome's bundled frontend on the no-inspector engine.
    KITESURF_INSPECTOR_BASE_URL: "https://example.com/devtools",
    WEB_BOT_AUTH_JWK: JSON.stringify(WBA_TEST_PRIVATE_JWK),
    WEB_BOT_AUTH_SIGNATURE_AGENT: WBA_TEST_SIGNATURE_AGENT,
    ...opts.engineBindings,
  };
  wo.bindings = engineBindings;
  return engineBindings;
}

function makeEngineWorkerOptions(
  opts: EngineE2EOptions,
  wo: EngineBindings,
  bindings: EngineBindings,
  name: string,
  outboundService: string,
  rules: ModuleRule[],
) {
  return {
    ...wo,
    bindings,
    name,
    modulesRoot: opts.engineDist,
    script: undefined,
    modulesRules: undefined,
    get modules() {
      return distModules(opts.engineDist, "index.js", rules);
    },
    outboundService,
  };
}

function makeFixtureWorkerOptions(opts: EngineE2EOptions): object[] {
  return (opts.fixtureWorkers ?? []).map((fixtureWorker) => ({
    name: fixtureWorker.name,
    modulesRoot: fixtureWorker.outdir,
    compatibilityDate: "2026-09-11",
    ...(fixtureWorker.serviceBindings !== undefined
      ? { serviceBindings: fixtureWorker.serviceBindings }
      : {}),
    get modules() {
      return distModules(fixtureWorker.outdir, "index.js", FIXTURES_RULES);
    },
  }));
}

function makeExtraEngineWorkers(
  opts: EngineE2EOptions,
  wo: EngineBindings,
  engineBindings: EngineBindings,
  rules: ModuleRule[],
): object[] {
  return (opts.extraEngines ?? []).map((engine) =>
    makeEngineWorkerOptions(
      opts,
      wo,
      { ...engineBindings, ...engine.bindings },
      engine.name,
      engine.outboundService,
      rules,
    ),
  );
}

function makeEngineE2eConfig(
  opts: EngineE2EOptions,
  engineWorker: object,
  noInspectorEngineWorker: object,
  extraEngineWorkers: object[],
  fixtureWorkers: object[],
): ReturnType<typeof defineConfig> {
  return defineConfig({
    plugins: [
      cloudflareTest({
        miniflare: {
          compatibilityDate: "2026-09-11",
          bindings: defaultIfUndefined(opts.bindings, {}),
          serviceBindings: {
            ENGINE: "kitesurf-engine",
            ENGINE_NO_INSPECTOR: "kitesurf-engine-no-inspector",
            ...opts.serviceBindings,
            OTLP_CAPTURE: "kitesurf-otlp-capture",
            CORE_WASM: "kitesurf-core-wasm",
            SCENE_HOST_WASM: "kitesurf-scene-host",
          },
          workers: [
            engineWorker as never,
            noInspectorEngineWorker as never,
            ...(extraEngineWorkers as never[]),
            fixturesWorker as never,
            ...(defaultIfUndefined(opts.workers, []).concat(fixtureWorkers) as never[]),
            otlpCaptureWorker as never,
            coreWasmWorker as never,
            sceneHostWorker as never,
          ],
        },
      }),
    ],
    test: makeVitestOptions(opts),
  });
}

export function engineE2EConfig(opts: EngineE2EOptions): ReturnType<typeof defineConfig> {
  setE2eEnvironment(opts);
  const { workerOptions } = unstable_getMiniflareWorkerOptions(opts.wranglerConfig);
  const wo = workerOptions as EngineBindings;
  const engineBindings = configureEngineBindings(opts, wo);
  const ENGINE_RULES: ModuleRule[] = [
    { type: "CompiledWasm", include: ["**/*.wasm"] },
    { type: "Text", include: ["**/*.glue.js", "*.css", "**/*.css"] },
    // Wrangler bundles *.bin as Data by default; wrapping engines ship such modules.
    { type: "Data", include: ["**/*.woff2", "**/*.bin"] },
  ];

  const engineWorker = makeEngineWorkerOptions(
    opts,
    wo,
    engineBindings,
    "kitesurf-engine",
    "kitesurf-engine",
    ENGINE_RULES,
  );
  const fixtureWorkerOptions = makeFixtureWorkerOptions(opts);

  // Keep modules lazy: global setup replaces the dist before the pool starts.
  // Spreading these options would snapshot the previous build's module paths.
  const noInspectorEngineWorker = makeEngineWorkerOptions(
    opts,
    wo,
    { ...engineBindings, KITESURF_INSPECTOR_BASE_URL: "" },
    "kitesurf-engine-no-inspector",
    "kitesurf-engine-no-inspector",
    ENGINE_RULES,
  );

  const extraEngineWorkers = makeExtraEngineWorkers(opts, wo, engineBindings, ENGINE_RULES);

  return makeEngineE2eConfig(
    opts,
    engineWorker,
    noInspectorEngineWorker,
    extraEngineWorkers,
    fixtureWorkerOptions,
  );
}

export default engineE2EConfig({
  wranglerConfig: resolve(HERE, process.env.KS_E2E_WRANGLER_CONFIG ?? "wrangler.jsonc"),
  engineDist: ENGINE_DIST,
});
