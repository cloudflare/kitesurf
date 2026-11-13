// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const compilerOptions = { module: ts.ModuleKind.CommonJS, esModuleInterop: true };
const compile = (source) => ts.transpileModule(source, { compilerOptions }).outputText;
const engineCode = compile(
  readFileSync(new URL("../packages/engine/src/eval/page-script.ts", import.meta.url), "utf8"),
);
const probeCode = compile(
  readFileSync(new URL("../packages/page-script/src/startup-probe.ts", import.meta.url), "utf8"),
);

function execute(code, imports = {}, globals = {}) {
  const exports = {};
  const require = (name) => {
    if (!Object.hasOwn(imports, name)) throw new Error(`Unexpected import: ${name}`);
    return imports[name];
  };
  runInNewContext(code, { exports, require, ...globals });
  return exports;
}

function dependency(values = {}) {
  return new Proxy(
    { __esModule: true, ...values },
    {
      get(target, key) {
        if (!Object.hasOwn(target, key))
          throw new Error(`Unexpected dependency use: ${String(key)}`);
        return target[key];
      },
    },
  );
}

const engine = execute(
  engineCode,
  {
    "./page-isolate-entry.ts": dependency({ pageIsolateEntry: () => "page.js" }),
    "../../../core/pkg/kitesurf_core.glue.js": dependency({ default: "wasm glue" }),
    "../../../core/pkg/kitesurf_core_bg.wasm": dependency({ default: {} }),
    "@kitesurf/dom-shim": dependency({ DOM_SHIM_SOURCE: "dom shim" }),
    "@kitesurf/page-script": dependency({
      INTERNAL_STATE_SOURCE: "internal state",
      PAGE_SCRIPT_SOURCE: "page script",
    }),
    "./page-script-rpc-session.ts": dependency(),
    "../tracing.ts": dependency(),
    "../tracing-local.ts": dependency({ localTraceParentProps: () => ({}) }),
    // The generator bounds runtime value JSON with the document cap.
    "../read-capped.ts": dependency({ MAX_DOCUMENT_BYTES: 16 * 1024 * 1024 }),
    "./attribution-tail.ts": dependency({ attributionTails: () => [] }),
    "./host-clock.ts": dependency({ makeWallClock: () => () => 0 }),
    "./walk-module-graph.ts": dependency({ FALLBACK_MODULE_RESOLVER_SOURCE: "resolver" }),
  },
  { crypto: { randomUUID: () => "test-uuid" }, URL },
);

// Captures the generated startup module by recording it in LOADER.load and throwing.
function startupModule(startupInput) {
  const sentinel = new Error("captured LOADER.load");
  let source;
  assert.throws(
    () =>
      engine.getOrCreatePageScript({
        env: {
          LOADER: {
            load: (options) => {
              source = options.modules["__ks_startup_probe_input.js"];
              throw sentinel;
            },
          },
        },
        ctx: { exports: { PageScriptTail: () => ({}) } },
        key: { connectionId: "connection", targetId: "target", navigateGeneration: 1 },
        pageOrigin: "https://example.test",
        startupInput,
        sandboxOutbound: { loaded: () => ({}) },
      }),
    (error) => error === sentinel,
  );
  assert.equal(typeof source, "string");
  return source;
}

function startupExports(source) {
  return execute(compile(source));
}

function startupSnapshot(input) {
  const probe = execute(probeCode, {
    "./__ks_startup_probe_input.js": input,
    "./wasm-glue.js": dependency({ initSync: () => {}, ks_bridge_install_desc_helpers: () => {} }),
    "./core_bg.wasm": dependency({ default: {} }),
    "./internals.ts": dependency({ ksInternals: {} }),
  });
  return probe.startupInputSnapshot;
}

test("startup metadata preserves HTML presence and UTF-16 length in the probe", () => {
  const cases = [
    { input: {}, hasHtml: false, htmlLength: 0 },
    { input: { html: null }, hasHtml: false, htmlLength: 0 },
    { input: { html: "" }, hasHtml: true, htmlLength: 0 },
    { input: { html: "hello" }, hasHtml: true, htmlLength: 5 },
    { input: { html: "a😀b" }, hasHtml: true, htmlLength: 4 },
    { input: { html: 123 }, hasHtml: false, htmlLength: 0 },
    { input: { html: false }, hasHtml: false, htmlLength: 0 },
    { input: { html: { length: 7 } }, hasHtml: false, htmlLength: 0 },
  ];

  for (const { input, hasHtml, htmlLength } of cases) {
    const generated = startupExports(startupModule(input));
    const snapshot = startupSnapshot(generated);

    assert.equal(snapshot.hasHtml, hasHtml);
    assert.equal(snapshot.htmlLength, htmlLength);
    assert.equal(generated.hasHtml, hasHtml);
    assert.equal(generated.htmlLength, htmlLength);
    assert.equal(Object.hasOwn(generated, "html"), false);
  }
});

test("startup module retains metadata instead of large HTML payloads", () => {
  const marker = "STARTUP_HTML_PAYLOAD_MARKER";
  const html = (length) => `<!--${marker}${"x".repeat(length - marker.length - 7)}-->`;
  const small = startupModule({ html: html(100000) });
  const large = startupModule({ html: html(900000) });

  assert.equal(small.length, large.length);

  for (const { source, length } of [
    { source: small, length: 100000 },
    { source: large, length: 900000 },
  ]) {
    assert.equal(source.includes(marker), false);

    const generated = startupExports(source);
    assert.equal(generated.hasHtml, true);
    assert.equal(generated.htmlLength, length);

    const snapshot = startupSnapshot(generated);
    assert.equal(snapshot.hasHtml, true);
    assert.equal(snapshot.htmlLength, length);
  }
});

test("other startup inputs survive generation and reach the probe", () => {
  const input = {
    html: "<p>page</p>",
    url: "https://example.test/path",
    cookies: "session=present",
    userAgent: "test agent",
    referrer: "https://example.test/previous",
    cdpDebug: true,
    scriptDescriptors: [
      { src: "/app.js", kind: "classic", body: "body", prefetchedSource: "source" },
    ],
  };
  const generated = startupExports(startupModule(input));

  assert.equal(generated.url, input.url);
  assert.equal(generated.cookies, input.cookies);
  assert.equal(generated.userAgent, input.userAgent);
  assert.equal(generated.referrer, input.referrer);
  assert.equal(generated.cdpDebug, true);
  // The descriptors come from the generated module's realm, so compare them as plain JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(generated.scriptDescriptors)), [
    { src: "/app.js", kind: "classic", body: "body", prefetchedLength: 6 },
  ]);

  const snapshot = startupSnapshot(generated);
  assert.equal(snapshot.url, input.url);
  assert.equal(snapshot.hasCookies, true);
  assert.equal(snapshot.scriptDescriptorCount, 1);
  assert.equal(snapshot.scriptDescriptorSample[0].prefetchedLen, 6);
});
