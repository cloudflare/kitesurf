// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// scripts/workerd-config.mjs and docker/front.js, run on the pinned workerd in front of a fake
// engine that answers the warm-up's CDP commands.

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

// FAKE_WARM_UP=fail makes Page.navigate report an error, and =hold holds the warm-up until a
// request to /release. /attempts counts warm-up targets.
const FAKE_ENGINE = `
let attempts = 0;
let released = false;
export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/attempts") return new Response(String(attempts));
    if (pathname === "/release") {
      released = true;
      return new Response("released");
    }
    if (request.headers.get("upgrade") !== "websocket") return new Response("engine " + pathname);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("message", async (event) => {
      const { id, method } = JSON.parse(event.data);
      // Polled: a promise resolved by another request cannot send on this request's socket.
      while (method === "Runtime.evaluate" && env.FAKE_WARM_UP === "hold" && !released) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      let result = {};
      if (method === "Target.createTarget") {
        attempts++;
        result = { targetId: "t" };
      } else if (method === "Target.attachToTarget") result = { sessionId: "s" };
      else if (method === "Page.navigate" && env.FAKE_WARM_UP === "fail") {
        result = { frameId: "f", errorText: "net::ERR_FAILED" };
      } else if (method === "Runtime.evaluate") result = { result: { type: "string", value: "1,2" } };
      server.send(JSON.stringify({ id, result }));
    });
    return new Response(null, { status: 101, webSocket: client });
  },
};
`;

const BASE_OPTIONS = {
  compatibilityDate: "2026-09-11",
  compatibilityFlags: ["global_fetch_strictly_public"],
  bindings: { FAKE_WARM_UP: "ok" },
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

/** Starts workerd on the image's config; returns its base URL. */
const serve = async function (t, root, env = {}) {
  const port = await freePort();
  const child = spawn(
    WORKERD,
    ["serve", "--experimental", "--socket-addr", `http=127.0.0.1:${port}`, "config.capnp"],
    { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
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
      await (await fetch(`${base}/attempts`)).text();
      return { base, output: () => output };
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
};

const waitFor = async function (check) {
  const deadline = Date.now() + DEADLINE_MS;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
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
  "front.js serves public/ with _headers and gates /health on the warm-up",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const root = makeImage(t);
    assert.equal(generate(root).status, 0);
    const { base, output } = await serve(t, root, { FAKE_WARM_UP: "hold" });

    const held = await fetch(`${base}/health`);
    assert.equal(held.status, 503);
    await held.body?.cancel();
    await (await fetch(`${base}/release`)).text();
    await waitFor(async () => {
      const health = await fetch(`${base}/health`);
      await health.body?.cancel();
      return health.status !== 503;
    });
    assert.match(output(), /\[kitesurf\] warmed up in \d+ ms/);
    assert.equal(await (await fetch(`${base}/health`)).text(), "engine /health");
    assert.equal(await (await fetch(`${base}/attempts`)).text(), "1");

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
  },
);

test(
  "front.js keeps /health failing after a failed warm-up and tries again",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const root = makeImage(t);
    assert.equal(generate(root).status, 0);
    const { base, output } = await serve(t, root, { FAKE_WARM_UP: "fail" });

    await waitFor(async () => {
      const health = await fetch(`${base}/health`);
      assert.equal(health.status, 503);
      await health.body?.cancel();
      return Number(await (await fetch(`${base}/attempts`)).text()) >= 2;
    });
    assert.match(output(), /\[kitesurf\] warm-up failed: Page\.navigate: net::ERR_FAILED/);
  },
);
