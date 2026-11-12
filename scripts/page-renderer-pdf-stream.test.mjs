// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

const compile = (path) =>
  ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
const producerCode = compile("../packages/page-script/src/pdf-stream.ts");
const rendererCode = compile("../packages/page-renderer/src/index.ts");

function harness(failure) {
  const state = { pages: 0, sourceFreed: 0, pdfFreed: 0 };
  const producer = {};
  runInContext(
    producerCode,
    createContext({
      exports: producer,
      ReadableStream,
      Uint8Array,
      DataView,
      TextEncoder,
      Error,
      setTimeout,
      clearTimeout,
      require: () => ({ nativeSetTimeout: setTimeout, nativeClearTimeout: clearTimeout }),
    }),
  );
  const source = { pageCount: 3, free: () => state.sourceFreed++ };
  const pages =
    failure === "oversized"
      ? new ReadableStream({
          start(controller) {
            const header = new Uint8Array(4);
            new DataView(header.buffer).setUint32(0, 33 * 1024 * 1024, true);
            controller.enqueue(header);
          },
          cancel() {
            state.sourceFreed++;
          },
        })
      : producer.pdfScenePages(
          source,
          () => Uint8Array.of(++state.pages),
          () => {
            if (failure === "stream")
              throw new Error("PDF document changed during scene streaming");
          },
          () => {},
          () => {
            state.resumed = (state.resumed ?? 0) + 1;
          },
        );
  class SceneRasterizer {
    resetResources() {}
    beginPdf() {
      if (failure === "begin") throw new Error("begin failed");
      return { free: () => state.pdfFreed++ };
    }
    missingResources() {
      return failure === "resources"
        ? Uint8Array.of(1, 0, 0, 0, 3, 1, 0, 0, 0, 0, 0, 0, 0)
        : Uint8Array.of(0, 0, 0, 0);
    }
    appendPdfPage() {
      return false;
    }
    lastRasterizeInfo() {
      return "raster failed";
    }
  }
  const dependencies = {
    "cloudflare:workers": {
      WorkerEntrypoint: class {
        env = {};
      },
      abortIsolate() {},
    },
    "./wasm-glue.js": {
      initSync() {},
      SceneRasterizer,
      set_ks_tracing() {},
      set_ks_trace_parent() {},
      ks_set_emit_hook() {},
    },
    "./core_bg.wasm": { default: {} },
  };
  const exports = {};
  const require = (name) => {
    if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected import ${name}`);
    return dependencies[name];
  };
  runInContext(
    rendererCode,
    createContext({
      exports,
      require,
      WebAssembly,
      Uint8Array,
      DataView,
      ArrayBuffer,
      ReadableStream,
      TextDecoder,
      console,
      Error,
    }),
  );
  const renderer = new exports.PageRenderer();
  const port = {
    recordPdfScenes: async () => ({ pages, pageCount: 3 }),
    getPaintResources: async () => {
      throw new Error("resource failed");
    },
  };
  return { renderer, port, state };
}

for (const failure of ["begin", "resources", "raster", "stream"]) {
  test(`renderer ${failure} failure cancels the page stream`, async () => {
    const { renderer, port, state } = harness(failure);
    const result = await renderer.renderPdf(port, {}, async () => null);
    assert.equal(
      result.stage,
      failure === "resources" ? "resources" : failure === "stream" ? "record" : "raster",
    );
    if (failure === "stream") {
      assert.equal(result.error, "PDF document changed during scene streaming");
    }
    assert.equal(state.sourceFreed, 1);
    assert.equal(state.pages, failure === "begin" || failure === "stream" ? 0 : 1);
    assert.equal(state.pdfFreed, failure === "begin" ? 0 : 1);
    assert.equal(state.resumed, 1);
  });
}

test("renderer rejects an oversized scene as a record-stage PDF error", async () => {
  const { renderer, port, state } = harness("oversized");
  const result = await renderer.renderPdf(port, {}, async () => null);

  assert.equal(result.stage, "record");
  assert.match(result.error, /PDF scene exceeds 32 MiB limit/);
  assert.equal(state.sourceFreed, 1);
  assert.equal(state.pages, 0);
  assert.equal(state.pdfFreed, 1);
});

test("renderer cancellation releases the page gate and a subsequent PDF render succeeds", async () => {
  const state = {
    paused: false,
    failResources: true,
    sourceFreed: 0,
    pdfFreed: 0,
    pages: 0,
  };
  const producer = {};
  runInContext(
    producerCode,
    createContext({
      exports: producer,
      ReadableStream,
      Uint8Array,
      DataView,
      TextEncoder,
      Error,
      setTimeout,
      clearTimeout,
      require: () => ({ nativeSetTimeout: setTimeout, nativeClearTimeout: clearTimeout }),
    }),
  );
  const SceneRasterizer = class {
    resetResources() {}
    beginPdf() {
      return { free: () => state.pdfFreed++ };
    }
    missingResources() {
      return state.failResources
        ? Uint8Array.of(1, 0, 0, 0, 3, 1, 0, 0, 0, 0, 0, 0, 0)
        : Uint8Array.of(0, 0, 0, 0);
    }
    putResources() {}
    appendPdfPage() {
      return true;
    }
    finishPdf() {
      return Uint8Array.of(37, 80, 68, 70);
    }
    lastRasterizeInfo() {
      return "ok";
    }
  };
  const dependencies = {
    "cloudflare:workers": {
      WorkerEntrypoint: class {
        env = {};
      },
      abortIsolate() {},
    },
    "./wasm-glue.js": {
      initSync() {},
      SceneRasterizer,
      set_ks_tracing() {},
      set_ks_trace_parent() {},
      ks_set_emit_hook() {},
    },
    "./core_bg.wasm": { default: {} },
  };
  const exports = {};
  runInContext(
    rendererCode,
    createContext({
      exports,
      require: (name) => {
        if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected import ${name}`);
        return dependencies[name];
      },
      WebAssembly,
      Uint8Array,
      DataView,
      ArrayBuffer,
      ReadableStream,
      TextDecoder,
      console,
      Error,
    }),
  );
  const renderer = new exports.PageRenderer();
  const port = {
    recordPdfScenes: async () => {
      state.paused = true;
      const source = { pageCount: 2, free: () => state.sourceFreed++ };
      const pages = producer.pdfScenePages(
        source,
        () => Uint8Array.of(++state.pages),
        () => {},
        () => {},
        () => {
          state.paused = false;
        },
      );
      return { pages, pageCount: source.pageCount };
    },
    getPaintResources: async () => {
      throw new Error("resource unavailable");
    },
  };

  const cancelled = await renderer.renderPdf(port, {}, async () => null);
  assert.equal(cancelled.stage, "resources");
  assert.equal(state.paused, false);
  assert.equal(state.sourceFreed, 1);

  state.failResources = false;
  const nextPrint = await renderer.renderPdf(port, {}, async () => null);
  assert.deepEqual(Array.from(nextPrint.bytes ?? []), [37, 80, 68, 70]);
  assert.equal(state.paused, false);
  assert.equal(state.sourceFreed, 2);
});
