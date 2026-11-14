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
const PAGE_LENGTH_BYTES = 4;
const ERROR_HEADER_BYTES = PAGE_LENGTH_BYTES * 2;

// Frames each page as a little-endian length header followed by the scene bytes. A zero length
// instead marks a stream error, followed by the message length and the message.
export function pdfScenePages(
  source: PdfPageSource,
  nextPage: () => Uint8Array,
  validate: () => void,
  invalidate: () => void,
  releaseGates: () => void,
): ReadableStream<Uint8Array> {
  let remaining = source.pageCount;
  let finished = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let controller: ReadableByteStreamController | null = null;

  const clearDeadline = (): void => {
    if (timeout === null) return;
    try {
      nativeClearTimeout(timeout);
    } catch {}
    timeout = null;
  };

  // Releases the page source and the caller's gates once, however the stream ends.
  const releaseStream = (): unknown | null => {
    if (finished) return null;
    finished = true;
    clearDeadline();
    let cleanupError: unknown | null = null;
    try {
      source.free();
    } catch (error) {
      cleanupError = error;
    } finally {
      try {
        releaseGates();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    return cleanupError;
  };

  const writeStreamError = (error: unknown): void => {
    if (!controller) return;
    // Clamp the encoded bytes, not the string: a non-ASCII message would otherwise exceed the
    // renderer's byte cap and be replaced by a length error.
    const message = error instanceof Error ? error.message : String(error);
    const text = new TextEncoder().encode(message).slice(0, PDF_STREAM_ERROR_MAX_BYTES);
    const frame = new Uint8Array(ERROR_HEADER_BYTES + text.byteLength);
    const header = new DataView(frame.buffer);
    header.setUint32(0, 0, true);
    header.setUint32(PAGE_LENGTH_BYTES, text.byteLength, true);
    frame.set(text, ERROR_HEADER_BYTES);
    try {
      controller.enqueue(frame);
      controller.close();
    } catch {}
  };

  const fail = (error: unknown): void => {
    if (finished || !controller) return;
    try {
      invalidate();
    } catch {}
    releaseStream();
    writeStreamError(error);
  };

  const writePage = (stream: ReadableByteStreamController): void => {
    validate();
    const page = nextPage();
    if (page.byteLength === 0) throw new Error("empty PDF scene page");
    const lengthHeader = new Uint8Array(PAGE_LENGTH_BYTES);
    new DataView(lengthHeader.buffer).setUint32(0, page.byteLength, true);
    stream.enqueue(lengthHeader);
    stream.enqueue(page);
    remaining--;
  };

  const closeStream = (stream: ReadableByteStreamController): void => {
    const cleanupError = releaseStream();
    if (cleanupError === null) {
      stream.close();
      return;
    }
    try {
      invalidate();
    } catch {}
    writeStreamError(cleanupError);
  };

  return new ReadableStream({
    type: "bytes",
    start(stream) {
      controller = stream;
      timeout = nativeSetTimeout(() => {
        fail(new Error(`PDF scene stream exceeded ${PDF_SCENE_STREAM_DEADLINE_MS} ms deadline`));
      }, PDF_SCENE_STREAM_DEADLINE_MS);
    },
    pull(stream) {
      if (finished) return;
      try {
        if (remaining === 0) closeStream(stream);
        else writePage(stream);
      } catch (error) {
        fail(error);
      }
    },
    cancel() {
      releaseStream();
    },
  });
}
