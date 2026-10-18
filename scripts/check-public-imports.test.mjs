// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { readPublicPackageNames, scanPublicImports } from "./check-public-imports.mjs";

const FILE = "packages/page-script/src/consumer.ts";
const PUBLIC_PACKAGES = new Set(["@kitesurf/engine", "@kitesurf/page-script"]);

test("rejects a @kitesurf package that is not a public workspace package", () => {
  assert.deepEqual(scanPublicImports(FILE, 'import "@kitesurf/private-worker";', PUBLIC_PACKAGES), [
    { file: FILE, line: 1, specifier: "@kitesurf/private-worker" },
  ]);
});

test("rejects relative paths that normalize under internal/", () => {
  const violations = scanPublicImports(
    FILE,
    [
      'import "./state.js";',
      'import "../../../internal/./packages/engine-private/src/index.js";',
    ].join("\n"),
    PUBLIC_PACKAGES,
  );

  assert.deepEqual(violations, [
    {
      file: FILE,
      line: 2,
      specifier: "../../../internal/./packages/engine-private/src/index.js",
    },
  ]);
});

test("rejects internal workspace package roots, re-exports, and subpaths", () => {
  const violations = scanPublicImports(
    FILE,
    [
      'import { KitesurfEngine } from "@kitesurf/engine-private";',
      'export { type Env } from "@kitesurf/internal/private";',
      'export * from "@kitesurf/engine-private/cdp";',
    ].join("\n"),
    PUBLIC_PACKAGES,
  );

  assert.deepEqual(
    violations.map(({ line, specifier }) => ({ line, specifier })),
    [
      { line: 1, specifier: "@kitesurf/engine-private" },
      { line: 2, specifier: "@kitesurf/internal/private" },
      { line: 3, specifier: "@kitesurf/engine-private/cdp" },
    ],
  );
});

test("rejects internal dependencies in public scripts, configuration, and tests", () => {
  for (const file of [
    "scripts/build.mjs",
    "packages/page-script/scripts/build.mjs",
    "packages/engine/vitest.config.mts",
    "packages/engine/test/boundary.test.ts",
  ]) {
    assert.deepEqual(
      scanPublicImports(file, 'import "@kitesurf/engine-private";', PUBLIC_PACKAGES),
      [{ file, line: 1, specifier: "@kitesurf/engine-private" }],
    );
  }
});

test("rejects type, dynamic, and require imports with literal internal targets", () => {
  const violations = scanPublicImports(
    FILE,
    [
      'import type { Env } from "@kitesurf/engine-private/types";',
      'type RuntimeEnv = import("@kitesurf/engine-private/runtime").Env;',
      'const runtime = import("@kitesurf/engine-private/runtime");',
      'const required = require("@kitesurf/engine-private/commonjs");',
      'import Engine = require("@kitesurf/engine-private/legacy");',
    ].join("\n"),
    PUBLIC_PACKAGES,
  );

  assert.deepEqual(
    violations.map(({ line }) => line),
    [1, 2, 3, 4, 5],
  );
});

test("rejects internal TypeScript path and package reference directives", () => {
  assert.deepEqual(
    scanPublicImports(
      FILE,
      [
        '/// <reference types="node" />',
        '/// <reference path="../../../internal/packages/engine-private/src/index.ts" />',
        '/// <reference types="@kitesurf/engine-private" />',
      ].join("\n"),
      PUBLIC_PACKAGES,
    ).map(({ line, specifier }) => ({ line, specifier })),
    [
      { line: 2, specifier: "../../../internal/packages/engine-private/src/index.ts" },
      { line: 3, specifier: "@kitesurf/engine-private" },
    ],
  );
  assert.deepEqual(
    scanPublicImports(
      "config.ts",
      '/// <reference path="internal/packages/engine-private/src/index.ts" />',
      PUBLIC_PACKAGES,
    ),
    [{ file: "config.ts", line: 1, specifier: "internal/packages/engine-private/src/index.ts" }],
  );
});

test("accepts public imports and ignores comments, fixture strings, and generated declarations", () => {
  const violations = scanPublicImports(
    FILE,
    [
      'import { KitesurfEngine } from "@kitesurf/engine";',
      'import { state } from "./state.js";',
      '// import "@kitesurf/engine-private";',
      '/* export * from "@kitesurf/engine-private"; */',
      'const fixture = `export * from "../../../internal/packages/host"`;',
      "const nonLiteral = import(packageName);",
    ].join("\n"),
    PUBLIC_PACKAGES,
  );

  assert.deepEqual(violations, []);
  assert.deepEqual(
    scanPublicImports(
      "packages/dom-shim/src/idl/model.generated.ts",
      'import "@kitesurf/engine-private";',
      PUBLIC_PACKAGES,
    ),
    [],
  );
  assert.deepEqual(
    scanPublicImports(
      "packages/page-script/src/runtime.d.ts",
      'import "@kitesurf/engine-private";',
      PUBLIC_PACKAGES,
    ),
    [],
  );
  for (const file of [
    "internal/packages/engine-private/src/index.ts",
    "packages/engine/test/fixtures-worker/assets/script.js",
    "packages/dom-shim/src/editing/implementation.js",
  ]) {
    assert.deepEqual(
      scanPublicImports(file, 'import "@kitesurf/engine-private";', PUBLIC_PACKAGES),
      [],
    );
  }
});

test("accepts subpaths of public packages and leaves other scopes alone", () => {
  assert.deepEqual(
    scanPublicImports(
      FILE,
      [
        'import "@kitesurf/page-script/state";',
        'import "@kitesurf/engine-extra";',
        'import "@cloudflare/puppeteer";',
      ].join("\n"),
      PUBLIC_PACKAGES,
    ).map(({ specifier }) => specifier),
    ["@kitesurf/engine-extra"],
  );
});

test("reads the public package names from the workspace manifests", () => {
  const names = readPublicPackageNames();
  assert.ok(names.has("@kitesurf/engine"));
  assert.ok(names.has("@kitesurf/page-script"));
});
