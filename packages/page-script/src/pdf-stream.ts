// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { nativeClearTimeout, nativeSetTimeout } from "./native-scheduling.ts";

interface PdfPageSource {
  readonly pageCount: number;
  free(): void;
}

const PDF_SCENE_STREAM_DEADLINE_MS = 25_000;
const PDF_STREAM_ERROR_MAX_BYTES = 1_024;

export function pdfScenePages(
  source: PdfPageSource,
  nextPage: () => Uint8Array,
  validate: () => void,
  invalidate: () => void,
  releasePageTasks: () => void,
): ReadableStream<Uint8Array> {
  let remaining = source.pageCount;
  let finished = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let controller: ReadableByteStreamController | null = null;
  const finish = (): unknown | null => {
    if (finished) return null;
    finished = true;
    if (timeout !== null) {
      try {
        nativeClearTimeout(timeout);
      } catch {}
      timeout = null;
    }
    let cleanupError: unknown | null = null;
    try {
      source.free();
    } catch (error) {
      cleanupError = error;
    } finally {
      try {
        releasePageTasks();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    return cleanupError;
  };
  const writeError = (error: unknown) => {
    if (!controller) return;
    const message = (error instanceof Error ? error.message : String(error)).slice(
      0,
      PDF_STREAM_ERROR_MAX_BYTES,
    );
    const text = new TextEncoder().encode(message);
    const frame = new Uint8Array(8 + text.byteLength);
    const header = new DataView(frame.buffer);
    header.setUint32(0, 0, true);
    header.setUint32(4, text.byteLength, true);
    frame.set(text, 8);
    try {
      controller.enqueue(frame);
      controller.close();
    } catch {}
  };
  const fail = (error: unknown) => {
    if (finished || !controller) return;
    try {
      invalidate();
    } catch {}
    finish();
    writeError(error);
  };
  return new ReadableStream({
    type: "bytes",
    start(streamController) {
      controller = streamController;
      timeout = nativeSetTimeout(() => {
        fail(new Error(`PDF scene stream exceeded ${PDF_SCENE_STREAM_DEADLINE_MS} ms deadline`));
      }, PDF_SCENE_STREAM_DEADLINE_MS);
    },
    pull(controller) {
      try {
        if (finished) return;
        if (remaining === 0) {
          const cleanupError = finish();
          if (cleanupError !== null) {
            try {
              invalidate();
            } catch {}
            writeError(cleanupError);
            return;
          }
          controller.close();
          return;
        }
        validate();
        const page = nextPage();
        if (page.byteLength === 0) throw new Error("empty PDF scene page");
        const header = new Uint8Array(4);
        new DataView(header.buffer).setUint32(0, page.byteLength, true);
        controller.enqueue(header);
        controller.enqueue(page);
        remaining--;
      } catch (error) {
        fail(error);
      }
    },
    cancel() {
      finish();
    },
  });
}
