// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = resolve(HERE, "..", "..");
const REPO_ROOT = resolve(ENGINE_DIR, "..", "..");
export const FIXTURES_DIST = resolve(
  process.env.KS_E2E_FIXTURES_DIST ?? resolve(HERE, ".fixtures-dist"),
);

import { existsSync, rmSync } from "node:fs";

const WRANGLER_CONFIG = process.env.KS_E2E_WRANGLER_CONFIG ?? resolve(ENGINE_DIR, "wrangler.jsonc");
const ENGINE_DIST = resolve(process.env.KS_E2E_ENGINE_DIST ?? resolve(HERE, ".engine-dist"));
const fixtureWorkerBuildsSchema = z.array(
  z
    .object({
      wranglerConfig: z.string(),
      outdir: z.string(),
    })
    .strict(),
);

function fixtureWorkerBuilds(): Array<{ wranglerConfig: string; outdir: string }> {
  const raw = process.env.KS_E2E_FIXTURE_WORKER_BUILDS;
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error("KS_E2E_FIXTURE_WORKER_BUILDS must be valid JSON", { cause: error });
  }
  return fixtureWorkerBuildsSchema.parse(value);
}

export default function setup(): void {
  if (process.env.KS_E2E_ENGINE_DIST && process.env.KS_E2E_FIXTURES_DIST) {
    if (
      !existsSync(resolve(ENGINE_DIST, "index.js")) ||
      !existsSync(resolve(FIXTURES_DIST, "index.js"))
    ) {
      throw new Error("The provided e2e engine or fixtures dist is missing index.js");
    }
    return;
  }
  const runE = (cmd: string, args: string[], cwd = REPO_ROOT) =>
    execFileSync(cmd, args, { cwd, stdio: "inherit" });
  runE(
    "pnpm",
    [
      "exec",
      "wrangler",
      "deploy",
      "--dry-run",
      "--config",
      "test/fixtures-worker/wrangler.jsonc",
      "--outdir",
      FIXTURES_DIST,
    ],
    ENGINE_DIR,
  );
  for (const fixtureWorker of fixtureWorkerBuilds()) {
    runE("pnpm", [
      "exec",
      "wrangler",
      "deploy",
      "--dry-run",
      "--config",
      fixtureWorker.wranglerConfig,
      "--outdir",
      fixtureWorker.outdir,
    ]);
  }
  if (!existsSync(resolve(REPO_ROOT, "packages/engine/public/rbi/scene_host.wasm"))) {
    console.log("[e2e] building scene host (artifact missing)");
    runE("pnpm", ["run", "build:scene-host:raw"]);
  }
  if (!existsSync(resolve(REPO_ROOT, "packages/renderer-core/pkg/renderer_core_bg.wasm"))) {
    console.log("[e2e] building renderer core (pkg missing)");
    runE("pnpm", ["run", "build:renderer-core:raw"]);
  }
  if (process.env.KS_E2E_SKIP_BUILD && existsSync(resolve(ENGINE_DIST, "index.js"))) {
    console.log("[e2e] KS_E2E_SKIP_BUILD set — reusing existing engine dist");
    return;
  }
  const started = Date.now();
  rmSync(ENGINE_DIST, { recursive: true, force: true });

  const pkgWasm = resolve(REPO_ROOT, "packages/core/pkg/kitesurf_core_bg.wasm");
  if (!existsSync(pkgWasm)) {
    console.log("[e2e] building wasm core (pkg missing)…");
    runE("pnpm", ["run", "build:wasm"]);
  }
  console.log(
    "[e2e] building dom-shim + page-script + page-renderer + worker-script bundles + engine dist…",
  );
  runE("pnpm", ["run", "build:engine-js"]);
  runE(
    "pnpm",
    [
      "exec",
      "wrangler",
      "deploy",
      "--dry-run",
      "--config",
      WRANGLER_CONFIG,
      "--outdir",
      ENGINE_DIST,
    ],
    ENGINE_DIR,
  );
  console.log(`[e2e] engine dist ready in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}
