// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

type FileReaderTaskOutput = {
  order: string[];
  afterProgress: { result: string | ArrayBuffer | null; readyState: number; loaded: number }[];
  afterLoad: { resultSet: boolean; readyState: number; seenLoadend: boolean }[];
  finalResult: string | ArrayBuffer | null;
};

type InvalidBlobReadOutcome = {
  domExceptionUnset: boolean;
  synchronousErrorType: string | null;
  readyState: number;
  doneState: number;
  errorType: string | null;
  events: string[];
  constructorRestored: boolean;
};

const MARKUP = `<script>
  (async () => {
    const reader = new FileReader();
    const order = [];
    const afterProgress = [];
    const afterLoad = [];
    reader.addEventListener("loadstart", () => order.push("loadstart"));
    reader.addEventListener("progress", (e) => {
      order.push("progress");
      // Two hops deep, like EventWatcher.wait_for(...).then(...).
      Promise.resolve().then(() => Promise.resolve()).then(() => {
        afterProgress.push({ result: reader.result, readyState: reader.readyState, loaded: e.loaded });
      });
    });
    reader.addEventListener("load", () => {
      order.push("load");
      Promise.resolve().then(() => Promise.resolve()).then(() => {
        afterLoad.push({ resultSet: reader.result !== null, readyState: reader.readyState, seenLoadend: order.includes("loadend") });
      });
    });
    reader.addEventListener("loadend", () => order.push("loadend"));
    reader.readAsText(new Blob(["kitesurf"]));
    await new Promise((r) => reader.addEventListener("loadend", r, { once: true }));
    await new Promise((r) => setTimeout(r, 10));
    window.__out = { order, afterProgress, afterLoad, finalResult: reader.result };
  })();
</script>`;

test("FileReader fires load and loadend in later tasks than progress", async ({ page }) => {
  await setContent(page, MARKUP);
  await page.waitForFunction("!!window.__out", { timeout: 10_000 }).catch(() => {});
  const r: FileReaderTaskOutput | null = await page.evaluate(
    () => (window as typeof window & { __out?: FileReaderTaskOutput }).__out ?? null,
  );
  expect(r).not.toBeNull();
  if (r === null) throw new Error("FileReader event task output was not produced");
  expect(r.order).toEqual(["loadstart", "progress", "load", "loadend"]);
  expect(r.afterProgress).toEqual([{ result: null, readyState: 1, loaded: 8 }]);
  expect(r.afterLoad).toEqual([{ resultSet: true, readyState: 2, seenLoadend: false }]);
  expect(r.finalResult).toBe("kitesurf");
});

test("FileReader reports an invalid Blob when DOMException is unavailable", async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const originalDOMException = window.DOMException;
    const readSynchronousError = (reader: FileReader): string | null => {
      try {
        Reflect.apply(reader.readAsText, reader, [{}]);
      } catch (error) {
        return error instanceof Error ? error.name : String(error);
      }
      return null;
    };
    const errorName = (reader: FileReader): string | null => reader.error?.name ?? null;

    let readOutcome: Omit<InvalidBlobReadOutcome, "constructorRestored"> | null = null;
    try {
      const domExceptionUnset =
        Reflect.set(window, "DOMException", undefined) && window.DOMException === undefined;
      const reader = new FileReader();
      const events: string[] = [];
      const loadend = new Promise<void>((resolve) => {
        reader.addEventListener("error", () => events.push("error"));
        reader.addEventListener(
          "loadend",
          () => {
            events.push("loadend");
            resolve();
          },
          { once: true },
        );
      });
      const synchronousErrorType = readSynchronousError(reader);
      if (synchronousErrorType === null) await loadend;
      readOutcome = {
        domExceptionUnset,
        synchronousErrorType,
        readyState: reader.readyState,
        doneState: FileReader.DONE,
        errorType: errorName(reader),
        events,
      };
    } finally {
      Reflect.set(window, "DOMException", originalDOMException);
    }
    if (readOutcome === null) throw new Error("FileReader invalid-Blob result was not captured");
    return {
      ...readOutcome,
      constructorRestored: window.DOMException === originalDOMException,
    };
  });

  expect(outcome.domExceptionUnset).toBe(true);
  expect(outcome.synchronousErrorType).toBeNull();
  expect(outcome.readyState).toBe(outcome.doneState);
  expect(outcome.errorType).toBe("TypeError");
  expect(outcome.events).toEqual(["error", "loadend"]);
  expect(outcome.constructorRestored).toBe(true);
});
