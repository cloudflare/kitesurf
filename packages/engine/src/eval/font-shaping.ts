// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Strips font outlines through core WebAssembly for pixel-free rendering.

import { traceSpan, type Tracer } from "../tracing.ts";

type StripFont = (bytes: Uint8Array) => Uint8Array | undefined;
let stripFontForShaping: StripFont | null = null;

async function loadTransform(): Promise<StripFont> {
  if (!stripFontForShaping) {
    const mod = await import("../wasm.ts");
    stripFontForShaping = mod.stripFontForShaping;
  }
  return stripFontForShaping;
}

export const MAX_SHAPED_FONT_BYTES = 8 * 1024 * 1024;

const MAX_CONCURRENT_TRANSFORMS = 4;
const waiters: Array<() => void> = [];
let running = 0;

async function acquireSlot(): Promise<boolean> {
  if (running < MAX_CONCURRENT_TRANSFORMS) {
    running += 1;
    return false;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  running += 1;
  return true;
}

function releaseSlot(): void {
  running -= 1;
  waiters.shift()?.();
}

export async function shapeFontBytes(
  bytes: Uint8Array,
  tracer?: Tracer,
): Promise<Uint8Array | null> {
  return await traceSpan(
    tracer,
    "font.strip",
    async (span) => {
      const queued = await acquireSlot();
      try {
        const shaped = (await loadTransform())(bytes) ?? null;
        span?.setTags({
          queued,
          outputBytes: shaped?.byteLength ?? 0,
          shaped: shaped !== null,
        });
        return shaped;
      } finally {
        releaseSlot();
      }
    },
    { inputBytes: bytes.byteLength },
  );
}
