// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// scripts/workerd-config.mjs and docker/front.js, run on the pinned workerd in front of a fake
// engine that logs and echoes the path it receives, answers 500 on /fail and throws on /throw.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
    console.log("[fake-engine] " + pathname);
    if (pathname === "/throw") throw new Error("engine down");
    if (pathname === "/fail") return new Response("engine down", { status: 500 });
    return new Response("engine " + pathname);
  },
};
`;

const BASE_CONFIG = {
  $schema: "../../node_modules/wrangler/config-schema.json",
  name: "kitesurf",
  main: "src/index.ts",
  compatibility_date: "2026-09-11",
  compatibility_flags: ["global_fetch_strictly_public"],
  limits: { cpu_ms: 300000 },
  vars: { KITESURF_ENV: "production" },
  worker_loaders: [{ binding: "LOADER" }],
  assets: { directory: "./public", binding: "FONT_ASSETS", run_worker_first: ["/", "/rbi/*"] },
  env: {
    local: {
      vars: { KITESURF_INSPECTOR_BASE_URL: "", KITESURF_INSPECTOR_FALLBACK_URL: "" },
      services: [{ binding: "FIXTURES", service: "kitesurf-fixtures" }],
    },
  },
};

const HEADERS = "/fonts/*\n  Cache-Control: public, max-age=31536000, immutable\n  ! X-Drop\n";

/** An image directory with a fake engine dist, a public/ tree and the engine's wrangler.jsonc. */
const makeImage = function (t, { config = BASE_CONFIG, headers = HEADERS, files = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kitesurf-workerd-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "dist"));
  mkdirSync(join(root, "public/fonts"), { recursive: true });
  writeFileSync(join(root, "dist/index.js"), FAKE_ENGINE);
  writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify(config));
  writeFileSync(join(root, "public/a.txt"), "root a");
  writeFileSync(join(root, "public/fonts/a.txt"), "fonts a");
  writeFileSync(join(root, "public/fonts/a.woff2"), "woff2");
  if (headers !== null) writeFileSync(join(root, "public/_headers"), headers);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), body);
  }
  copyFileSync(join(REPO, "docker/front.js"), join(root, "front.js"));
  return root;
};

const generate = function (root) {
  return spawnSync(
    process.execPath,
    [
      GENERATOR,
      join(root, "dist"),
      join(root, "wrangler.jsonc"),
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

const READY = "[kitesurf] ready: ";
const readyLines = (output) => output().split(READY).length - 1;

/** Waits for a log line, which can still be in the pipe after its request's response. */
const waitForLog = async function (output, text) {
  const deadline = Date.now() + DEADLINE_MS;
  while (!output().includes(text) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
};

test("the generator rejects engine config that front.js does not translate", (t) => {
  const assets = BASE_CONFIG.assets;
  const cases = [
    [
      { config: { ...BASE_CONFIG, durable_objects: { bindings: [] } } },
      /wrangler\.jsonc sets durable_objects/,
    ],
    [
      { config: { ...BASE_CONFIG, connect: [{ protocol: "tcp" }] } },
      /wrangler\.jsonc sets connect/,
    ],
    [
      { config: { ...BASE_CONFIG, assets: { ...assets, html_handling: "none" } } },
      /assets\.html_handling/,
    ],
    [
      {
        config: {
          ...BASE_CONFIG,
          assets: { ...assets, not_found_handling: "single-page-application" },
        },
      },
      /assets\.not_found_handling/,
    ],
    [
      { config: { ...BASE_CONFIG, assets: { ...assets, run_worker_first: ["/"] } } },
      /run_worker_first/,
    ],
    [
      { config: { ...BASE_CONFIG, worker_loaders: [{ binding: "LOADER", limits: {} }] } },
      /worker_loaders sets/,
    ],
    [
      { config: { ...BASE_CONFIG, vars: { KITESURF_ENV: 1 } } },
      /vars\.KITESURF_ENV is not a string/,
    ],
    [{ config: { ...BASE_CONFIG, env: {} } }, /env\.local\.vars\.KITESURF_INSPECTOR_BASE_URL/],
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
    config: { ...BASE_CONFIG, compatibility_flags: ["experimental", "nodejs_compat"] },
  });
  const result = generate(root);
  assert.equal(result.status, 0, result.stderr);
  const config = readFileSync(join(root, "config.capnp"), "utf8");
  assert.match(config, /compatibilityFlags = \["experimental", "nodejs_compat"\]/);
});

test("the generator takes the top-level vars and only the inspector pair from env.local", (t) => {
  const local = { KITESURF_INSPECTOR_BASE_URL: "", KITESURF_INSPECTOR_FALLBACK_URL: "https://x/" };
  const root = makeImage(t, {
    config: { ...BASE_CONFIG, env: { local: { vars: { ...local, KITESURF_ENV: "local" } } } },
  });
  const result = generate(root);
  assert.equal(result.status, 0, result.stderr);
  const env = readFileSync(join(root, "env.sh"), "utf8");
  assert.ok(env.includes("|| KITESURF_ENV='production'"), env);
  assert.ok(env.includes("|| KITESURF_INSPECTOR_FALLBACK_URL='https://x/'"), env);
  const config = readFileSync(join(root, "config.capnp"), "utf8");
  assert.match(config, /\(name = "LOADER", workerLoader = \(\)\)/);
  assert.doesNotMatch(config, /FIXTURES/);
});

test("the generator sets the hosted frontend unless the image serves its own", (t) => {
  const hosted = "https://example.com/inspector.html";
  const frontend = { "public/inspector/inspector.html": "" };
  /** The fallback's default in env.sh, for a base and a public/ with these files and dirs. */
  const fallback = function ({ base = "/inspector/inspector.html", files = {}, dirs = [] }) {
    const vars = { KITESURF_INSPECTOR_BASE_URL: base, KITESURF_INSPECTOR_FALLBACK_URL: hosted };
    const root = makeImage(t, { config: { ...BASE_CONFIG, env: { local: { vars } } }, files });
    for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
    const result = generate(root);
    assert.equal(result.status, 0, result.stderr);
    const env = readFileSync(join(root, "env.sh"), "utf8");
    assert.ok(env.includes(`|| KITESURF_INSPECTOR_BASE_URL='${base}'`), env);
    return /\|\| KITESURF_INSPECTOR_FALLBACK_URL='([^']*)'/.exec(env)?.[1];
  };
  assert.equal(fallback({ files: frontend }), "");
  // A build without the frontend leaves public/inspector/ empty.
  assert.equal(fallback({ dirs: ["public/inspector"] }), hosted);
  // front.js serves only a file whose name has an extension.
  assert.equal(fallback({ base: "/inspector/", files: frontend }), hosted);
  assert.equal(fallback({ base: "/inspector/", dirs: ["public/inspector"] }), hosted);
  const license = { "public/inspector/LICENSE": "" };
  assert.equal(fallback({ base: "/inspector/LICENSE", files: license }), hosted);
  assert.equal(fallback({ base: "/inspector.d", dirs: ["public/inspector.d"] }), hosted);
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

    await waitForLog(output, READY);
    assert.equal(readyLines(output), 1);
  },
);

test(
  "front.js logs ready only after the engine answers",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const root = makeImage(t);
    assert.equal(generate(root).status, 0);
    const { base, output, probeStatus } = await serve(t, root, "/throw");
    assert.equal(probeStatus, 500);
    const failed = await fetch(`${base}/fail`);
    assert.equal(failed.status, 500);
    await failed.body?.cancel();
    assert.equal(await (await fetch(`${base}/health`)).text(), "engine /health");

    const answered = "[fake-engine] /health";
    await waitForLog(output, answered);
    await waitForLog(output, READY);
    const log = output();
    assert.ok(log.includes(answered), log);
    // A line from a failed request would come before the request that the engine answered.
    assert.ok(log.indexOf(READY) > log.indexOf(answered), log);
    assert.equal(readyLines(output), 1);
  },
);
