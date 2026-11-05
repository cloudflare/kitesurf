// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(
  new URL("../packages/page-script/src/pdf-stream.ts", import.meta.url),
  "utf8",
);
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function loadPdfScenePages(schedule = setTimeout, clear = clearTimeout) {
  const exports = {};
  runInContext(
    code,
    createContext({
      exports,
      ReadableStream,
      Uint8Array,
      DataView,
      TextEncoder,
      Error,
      setTimeout: schedule,
      clearTimeout: clear,
      require: () => ({ nativeSetTimeout: schedule, nativeClearTimeout: clear }),
    }),
  );
  return exports.pdfScenePages;
}
const pdfScenePages = loadPdfScenePages();

function streamError(frame) {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  assert.equal(view.getUint32(0, true), 0);
  const length = view.getUint32(4, true);
  return new TextDecoder().decode(frame.subarray(8, 8 + length));
}

test("cancelling a partially read PDF releases its page source without recording more pages", async () => {
  let pages = 0;
  let frees = 0;
  let resumes = 0;
  const stream = pdfScenePages(
    { pageCount: 3, free: () => frees++ },
    () => Uint8Array.of(++pages, 9),
    () => {},
    () => assert.fail("unexpected invalidation"),
    () => resumes++,
  );
  const reader = stream.getReader();
  assert.equal(pages, 0);
  assert.deepEqual([...(await reader.read()).value], [2, 0, 0, 0]);
  assert.deepEqual([...(await reader.read()).value], [1, 9]);
  assert.equal(pages, 1);
  await reader.cancel("renderer stopped");
  assert.equal(frees, 1);
  assert.equal(resumes, 1);
  assert.equal(pages, 1);
});

test("a recording failure releases and invalidates the page source", async () => {
  let frees = 0;
  let invalidations = 0;
  let resumes = 0;
  const stream = pdfScenePages(
    { pageCount: 2, free: () => frees++ },
    () => {
      throw new Error("recording failed");
    },
    () => {},
    () => invalidations++,
    () => resumes++,
  );
  const reader = stream.getReader();
  const { value } = await reader.read();
  assert.equal(streamError(value), "recording failed");
  assert.equal(frees, 1);
  assert.equal(invalidations, 1);
  assert.equal(resumes, 1);
});

test("a changed snapshot stops before recording another page and releases the source", async () => {
  let pages = 0;
  let frees = 0;
  let invalidations = 0;
  let resumes = 0;
  const stream = pdfScenePages(
    { pageCount: 2, free: () => frees++ },
    () => Uint8Array.of(++pages),
    () => {
      if (pages > 0) throw new Error("PDF document changed during scene streaming");
    },
    () => invalidations++,
    () => resumes++,
  );
  const reader = stream.getReader();
  await reader.read();
  await reader.read();
  const { value } = await reader.read();
  assert.equal(streamError(value), "PDF document changed during scene streaming");
  assert.equal(pages, 1);
  assert.equal(frees, 1);
  assert.equal(invalidations, 1);
  assert.equal(resumes, 1);
});

test("the stream deadline reports an error and releases the page task gate", async () => {
  let expire;
  let frees = 0;
  let resumes = 0;
  const pdfScenePagesWithClock = loadPdfScenePages(
    (callback) => {
      expire = callback;
      return 1;
    },
    () => {},
  );
  const stream = pdfScenePagesWithClock(
    { pageCount: 2, free: () => frees++ },
    () => Uint8Array.of(1),
    () => {},
    () => {},
    () => resumes++,
  );
  const reader = stream.getReader();
  expire();
  const { value } = await reader.read();
  assert.match(streamError(value), /PDF scene stream exceeded .* ms deadline/);
  assert.equal(frees, 1);
  assert.equal(resumes, 1);
});
