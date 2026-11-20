// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// scripts/workerd-config.mjs and docker/front.js, run on the pinned workerd in front of a fake
// engine that echoes the path it receives and throws on /fail.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const REPO = resolve(import.meta.dirname, "..");
const GENERATOR = join(REPO, "scripts/workerd-config.mjs");
const requireFromServer = createRequire(join(REPO, "packages/engine-server/server.mjs"));
const WORKERD = createRequire(requireFromServer.resolve("miniflare"))("workerd").default;
const TEST_TIMEOUT_MS = 60_000;
const DEADLINE_MS = 20_000;

const FAKE_ENGINE = `
export default {
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/fail") throw new Error("engine down");
    return new Response("engine " + pathname);
  },
};
`;

const BASE_OPTIONS = {
  compatibilityDate: "2026-09-11",
  compatibilityFlags: ["global_fetch_strictly_public"],
  bindings: {},
  workerLoaders: {},
  email: {},
  assets: {
    directory: "../public",
    binding: "FONT_ASSETS",
    run_worker_first: ["/", "/rbi/*"],
    routerConfig: { has_user_worker: true },
    assetConfig: { compatibility_date: "2026-09-11", compatibility_flags: [] },
  },
};

const HEADERS = "/fonts/*\n  Cache-Control: public, max-age=31536000, immutable\n  ! X-Drop\n";

/** An image directory with a fake engine dist and a public/ tree. */
const makeImage = function (t, { options = BASE_OPTIONS, headers = HEADERS, files = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kitesurf-workerd-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "dist"));
  mkdirSync(join(root, "public/fonts"), { recursive: true });
  writeFileSync(join(root, "dist/index.js"), FAKE_ENGINE);
  writeFileSync(join(root, "dist/engine-mf.json"), JSON.stringify(options));
  writeFileSync(join(root, "container-vars.json"), "{}");
  writeFileSync(join(root, "public/a.txt"), "root a");
  writeFileSync(join(root, "public/fonts/a.txt"), "fonts a");
  writeFileSync(join(root, "public/fonts/a.woff2"), "woff2");
  if (headers !== null) writeFileSync(join(root, "public/_headers"), headers);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  copyFileSync(join(REPO, "docker/front.js"), join(root, "front.js"));
  return root;
};

const generate = function (root) {
  return spawnSync(
    process.execPath,
    [
      GENERATOR,
      join(root, "dist"),
      join(root, "container-vars.json"),
      join(root, "config.capnp"),
      join(root, "env.sh"),
      `--root=${root}`,
    ],
    { encoding: "utf8" },
  );
};

const freePort = async function () {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
};

/** Starts workerd on the image's config and waits until `probe` gets a response. */
const serve = async function (t, root, probe = "/health") {
  const port = await freePort();
  const child = spawn(
    WORKERD,
    ["serve", "--experimental", "--socket-addr", `http=127.0.0.1:${port}`, "config.capnp"],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + DEADLINE_MS;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`workerd exited ${child.exitCode}: ${output}`);
    try {
      const response = await fetch(`${base}${probe}`);
      await response.body?.cancel();
      return { base, output: () => output, probeStatus: response.status };
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
};

const readyLines = (output) => output().match(/\[kitesurf\] ready: /g)?.length ?? 0;

/** Waits for front.js's `ready` line, which can still be in the pipe after its response. */
const waitForReady = async function (output) {
  const deadline = Date.now() + DEADLINE_MS;
  while (readyLines(output) === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
};

test("the generator rejects engine options that front.js does not translate", (t) => {
  const assets = BASE_OPTIONS.assets;
  const cases = [
    [{ options: { ...BASE_OPTIONS, durableObjects: { X: "X" } } }, /sets durableObjects/],
    [
      { options: { ...BASE_OPTIONS, assets: { ...assets, html_handling: "none" } } },
      /assets\.html_handling/,
    ],
    [
      {
        options: {
          ...BASE_OPTIONS,
          assets: {
            ...assets,
            assetConfig: { ...assets.assetConfig, not_found_handling: "single-page-application" },
          },
        },
      },
      /assets\.assetConfig\.not_found_handling/,
    ],
    [
      { options: { ...BASE_OPTIONS, assets: { ...assets, run_worker_first: ["/"] } } },
      /run_worker_first/,
    ],
    [{ files: { "public/_redirects": "/a /b 301\n" } }, /_redirects/],
    [{ headers: "https://example.com/*\n  X-A: b\n" }, /_headers:1: only path patterns/],
    [{ headers: "/a/:name\n  X-A: b\n" }, /_headers:1: only path patterns/],
    [{ headers: "  X-A: b\n" }, /_headers:1: a header before any path/],
    [{ headers: "/a\n  not a header\n" }, /_headers:2: not a header/],
  ];
  for (const [image, error] of cases) {
    const result = generate(makeImage(t, image));
    assert.notEqual(result.status, 0, `accepted ${JSON.stringify(image)}`);
    assert.match(result.stderr, error);
  }
  assert.equal(generate(makeImage(t)).status, 0);
});

test("the generator lists the experimental flag once", (t) => {
  const root = makeImage(t, {
    options: { ...BASE_OPTIONS, compatibilityFlags: ["experimental", "nodejs_compat"] },
  });
  const result = generate(root);
  assert.equal(result.status, 0, result.stderr);
  const config = readFileSync(join(root, "config.capnp"), "utf8");
  assert.match(config, /compatibilityFlags = \["experimental", "nodejs_compat"\]/);
});

test(
  "front.js serves public/ with _headers and sends the rest to the engine",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const root = makeImage(t);
    assert.equal(generate(root).status, 0);
    const { base, output } = await serve(t, root);

    assert.equal(await (await fetch(`${base}/health`)).text(), "engine /health");
    assert.equal(await (await fetch(`${base}/`)).text(), "engine /");
    assert.equal(await (await fetch(`${base}/a.txt`)).text(), "root a");
    assert.equal(await (await fetch(`${base}/missing.txt`)).text(), "engine /missing.txt");
    // A leading `//` must not turn the first segment into a host.
    assert.equal(await (await fetch(`${base}//fonts/a.txt`)).text(), "fonts a");
    assert.equal(await (await fetch(`${base}//x.txt`)).text(), "engine //x.txt");

    const font = await fetch(`${base}/fonts/a.woff2`);
    assert.equal(font.status, 200);
    assert.equal(font.headers.get("content-type"), "font/woff2");
    assert.equal(font.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(await font.text(), "woff2");
    const lastModified = font.headers.get("last-modified");
    assert.ok(lastModified);
    const revalidated = await fetch(`${base}/fonts/a.woff2`, {
      headers: { "if-modified-since": lastModified },
    });
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.headers.get("cache-control"), "public, max-age=31536000, immutable");
    const text = await fetch(`${base}/a.txt`);
    assert.equal(text.headers.get("cache-control"), null);
    await text.body?.cancel();

    await waitForReady(output);
    assert.equal(readyLines(output), 1);
  },
);

test(
  "front.js logs ready only after the engine answers",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const root = makeImage(t);
    assert.equal(generate(root).status, 0);
    const { base, output, probeStatus } = await serve(t, root, "/fail");
    assert.equal(probeStatus, 500);
    // A line from the failed request reaches the pipe within milliseconds.
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(readyLines(output), 0);

    assert.equal(await (await fetch(`${base}/health`)).text(), "engine /health");
    await waitForReady(output);
    assert.equal(readyLines(output), 1);
  },
);
