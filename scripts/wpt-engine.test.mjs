// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { prepare } from "./wpt-engine.mjs";

const ENGINE_TEST_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 5_000;

test(
  "engine preparation and serving retain the embedding host's config and binary imports",
  { timeout: ENGINE_TEST_TIMEOUT_MS },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "kitesurf-host-dist-"));
    const config = join(root, "wrangler.jsonc");
    const dist = join(root, "dist");
    let child;
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), SHUTDOWN_TIMEOUT_MS);
        try {
          await exited;
        } finally {
          clearTimeout(timer);
        }
      }
      rmSync(root, { recursive: true, force: true });
    });
    writeFileSync(join(root, "data.bin"), new Uint8Array([1, 2, 3]));
    writeFileSync(
      join(root, "index.js"),
      'import data from "./data.bin"; export default { fetch(_request, env) { return new Response(`private host:${env.HOST_MARKER}:${new Uint8Array(data)}`); } };',
    );
    writeFileSync(
      config,
      JSON.stringify({
        name: "kitesurf-test-host",
        main: "index.js",
        compatibility_date: "2026-09-11",
        vars: { HOST_MARKER: "private" },
        rules: [{ type: "Data", globs: ["**/*.bin"], fallthrough: true }],
      }),
    );
    await prepare(dist, config);
    assert.ok(readFileSync(join(dist, "index.js"), "utf8").includes("private host"));
    const options = JSON.parse(readFileSync(join(dist, "engine-mf.json"), "utf8"));
    assert.equal(options.bindings.HOST_MARKER, "private");
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    server.close();
    await once(server, "close");
    assert.ok(address && typeof address !== "string");
    child = spawn(
      process.execPath,
      [
        resolve(import.meta.dirname, "wpt-engine.mjs"),
        "serve",
        "--dist",
        dist,
        "--port",
        String(address.port),
        "--inspector-port",
        "0",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const url = await new Promise((ready, reject) => {
      let output = "";
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`engine exited ${code}: ${output}`)));
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/\[wpt-engine\] ready on (http:\/\/[^\s]+)/);
        if (match) ready(match[1]);
      });
    });
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "private host:private:1,2,3");
  },
);
