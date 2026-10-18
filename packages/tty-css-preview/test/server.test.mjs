// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createPreviewServer } from "../src/server.mjs";

const PACKAGE_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_CSS_DIRECTORY = resolve(PACKAGE_DIRECTORY, "../engine/src/tty");

async function withServer(testContext, options = {}) {
  const server = createPreviewServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  testContext.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

test("serves valid level 1 CSS without template markers", async (testContext) => {
  const baseUrl = await withServer(testContext);
  const response = await fetch(`${baseUrl}/tty.css?level=1`);
  const css = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/css; charset=utf-8");
  assert.match(css, /--ks-tty-cell-h: 17px/);
  assert.doesNotMatch(css, /\{\{/);
  assert.doesNotMatch(css, /filter: none !important/);
});

test("appends strict rules for level 2", async (testContext) => {
  const baseUrl = await withServer(testContext);
  const response = await fetch(`${baseUrl}/tty.css?level=2`);
  const css = await response.text();

  assert.equal(response.status, 200);
  assert.match(css, /filter: none !important/);
  assert.match(css, /writing-mode: horizontal-tb !important/);
});

test("reads changed CSS without restarting the server", async (testContext) => {
  const cssDirectory = await mkdtemp(join(tmpdir(), "tty-css-preview-test-"));
  testContext.after(() => rm(cssDirectory, { recursive: true, force: true }));
  await writeFile(join(cssDirectory, "stylesheet.css"), "html { color: red; }\n");

  const baseUrl = await withServer(testContext, { cssDirectory });
  const url = `${baseUrl}/tty.css`;

  assert.equal(await (await fetch(url)).text(), "html { color: red; }\n");
  await writeFile(join(cssDirectory, "stylesheet.css"), "html { color: blue; }\n");
  assert.equal(await (await fetch(url)).text(), "html { color: blue; }\n");
});

test("rejects an unknown preview level", async (testContext) => {
  const baseUrl = await withServer(testContext);
  const response = await fetch(`${baseUrl}/tty.css?level=3`);

  assert.equal(response.status, 400);
  assert.equal(await response.text(), "The level must be 1 or 2\n");
});

test("reports server health", async (testContext) => {
  const baseUrl = await withServer(testContext);
  const response = await fetch(`${baseUrl}/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("declares the permissions required for document-scoped injection", async () => {
  const source = await readFile(resolve(PACKAGE_DIRECTORY, "extension/manifest.json"), "utf8");
  const manifest = JSON.parse(source);

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "106");
  assert.deepEqual(manifest.permissions, ["scripting", "storage"]);
  assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
});

test("bundles the current engine stylesheets for offline use", async () => {
  const [engineLevel1, engineLevel2, fallbackLevel1, fallbackLevel2] = await Promise.all([
    readFile(resolve(ENGINE_CSS_DIRECTORY, "stylesheet.css"), "utf8"),
    readFile(resolve(ENGINE_CSS_DIRECTORY, "stylesheet-level2.css"), "utf8"),
    readFile(resolve(PACKAGE_DIRECTORY, "extension/fallback-level1.css"), "utf8"),
    readFile(resolve(PACKAGE_DIRECTORY, "extension/fallback-level2.css"), "utf8"),
  ]);

  assert.equal(fallbackLevel1, engineLevel1);
  assert.equal(fallbackLevel2, engineLevel2);
});
