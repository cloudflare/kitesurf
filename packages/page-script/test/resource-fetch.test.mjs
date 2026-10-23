// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { createContext, runInContext, SourceTextModule, SyntheticModule } from "node:vm";

// Stub the Worker/wasm boundaries, but keep resource scheduling and inflight accounting real.
async function resourceRuntime() {
  const context = createContext({
    console,
    URL,
    Response,
    Headers,
    Uint8Array,
    TextEncoder,
    TextDecoder,
    queueMicrotask,
    setTimeout,
    clearTimeout,
  });
  const page = runInContext("globalThis", context);
  const internal = { mutationSeq: 0, paintNeutralSeq: 0 };
  const state = {
    dom: {
      deliverResource: () => true,
      pendingImageNodes: () => [1],
      nodeInfo: () => ({ attributes: [] }),
    },
    paintCacheHandle: null,
    notifyImageResults() {},
    notifyStylesheetResults() {},
  };
  const started = Promise.withResolvers();
  const response = Promise.withResolvers();
  let requests = 0;
  const modules = new Map();
  function stub(specifier, exports) {
    modules.set(
      specifier,
      new SyntheticModule(
        Object.keys(exports),
        function () {
          for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        },
        { context, identifier: specifier },
      ),
    );
  }
  stub("./state.ts", { state, ksGlobal: page });
  stub("./native-scheduling.ts", { NativePromise: page.Promise });
  stub("./internal-state.js", { getInternalState: () => internal });
  stub("./wasm-glue.js", { __setBridgeFetchResource() {} });
  stub("./paint.ts", { cascadeSeq: () => 0, invalidatePaintDom() {} });
  stub("./lag-monitor.ts", { noteSyncOp() {} });
  stub("./font-loader.ts", {
    fontDeferActive: () => false,
    fontDemandFired: () => false,
    setParkedFontReleaseHook() {},
    fontLoaderMode: () => "full",
  });
  stub("@kitesurf/script-gate/gateway-headers", {
    KITESURF_CORS_VERDICT_HEADER: "x-kitesurf-cors",
    KITESURF_NOSNIFF_HEADER: "x-kitesurf-nosniff",
    responseIsOpaque: () => false,
  });
  stub("./trusted-fetch.ts", {
    trustedFetch: async () => {
      if (++requests === 3) started.resolve();
      await response.promise;
      return new Response("body", { headers: { "x-kitesurf-cors": "clean" } });
    },
  });
  function load(specifier) {
    const cached = modules.get(specifier);
    if (cached) return cached;
    const source = readFileSync(new URL(specifier, new URL("../src/", import.meta.url)), "utf8");
    const module = new SourceTextModule(stripTypeScriptTypes(source, { mode: "transform" }), {
      context,
      identifier: specifier,
    });
    modules.set(specifier, module);
    return module;
  }
  const module = load("./resource-fetch.ts");
  await module.link(load);
  await module.evaluate();
  return { resources: module.namespace, started: started.promise, release: response.resolve };
}

test("subresources enter inflight tracking before idle waiters can observe them", async () => {
  const { resources, started, release } = await resourceRuntime();
  const pending = ["Font", "Image", "Stylesheet"].map((kind, nodeId) =>
    resources.fetchResource(nodeId, `https://example.test/${kind}`, kind),
  );
  let fontsIdle = false;
  let inflightZero = false;
  const idle = resources.fontsIdle().then(() => {
    fontsIdle = true;
  });
  const zero = resources.waitForInflightZero().then(() => {
    inflightZero = true;
  });
  try {
    assert.deepEqual(
      {
        blocking: resources.blockingInflightCount(),
        fonts: resources.fontsInflightCount(),
        image: resources.isImageInflight("https://example.test/Image"),
      },
      { blocking: 3, fonts: 1, image: true },
    );
    await started;
    assert.deepEqual({ fontsIdle, inflightZero }, { fontsIdle: false, inflightZero: false });
  } finally {
    release();
    await Promise.all([...pending, idle, zero]);
  }
  assert.deepEqual(
    {
      blocking: resources.blockingInflightCount(),
      fonts: resources.fontsInflightCount(),
      image: resources.isImageInflight("https://example.test/Image"),
      fontsIdle,
      inflightZero,
    },
    { blocking: 0, fonts: 0, image: false, fontsIdle: true, inflightZero: true },
  );
});
