// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Splits worker logs into byte-bounded tracing spans before attaching them.

import type { Tracer, SpanTags } from "../tracing.ts";

export const CARRIER_SPAN_BYTE_BUDGET = 48 * 1024;
export const CARRIER_SPAN_LOG_CAP = 1000;

export interface CarrierLog {
  key: string;
  value: string;
}

export interface AttachChunkedResult {
  attached: number;
  oversized: number;
  chunks: number;
}

const UTF8 = new TextEncoder();
function logSize(log: CarrierLog): number {
  return UTF8.encode(log.key).length + UTF8.encode(log.value).length;
}

export function attachChunked(
  tracer: Tracer,
  name: string,
  tags: SpanTags,
  logs: CarrierLog[],
  finalTags: SpanTags = {},
): AttachChunkedResult {
  let attached = 0;
  let oversized = 0;
  let chunks = 0;
  let finalEmitted = false;
  let i = 0;
  while (i < logs.length) {
    const chunk: CarrierLog[] = [];
    let bytes = 0;
    while (i < logs.length && chunk.length < CARRIER_SPAN_LOG_CAP) {
      const log = logs[i];
      if (log === undefined) break;
      const size = logSize(log);
      if (size > CARRIER_SPAN_BYTE_BUDGET) {
        oversized++;
        i++;
        continue;
      }
      if (bytes + size > CARRIER_SPAN_BYTE_BUDGET) break;
      bytes += size;
      chunk.push(log);
      i++;
    }
    if (chunk.length === 0) continue;
    chunks++;
    const last = i >= logs.length;
    tracer.enterSpan(name, (s) => {
      s.setTags({ ...tags, records: chunk.length });
      for (const log of chunk) s.addLogs({ [log.key]: log.value });
      attached += chunk.length;
      if (last) {
        finalEmitted = true;
        s.setTags({
          ...finalTags,
          ...(oversized > 0 ? { oversizedDropped: oversized } : {}),
        });
      }
    });
  }
  if (!finalEmitted && (oversized > 0 || Object.keys(finalTags).length > 0)) {
    chunks++;
    tracer.enterSpan(name, (s) => {
      s.setTags({
        ...tags,
        records: 0,
        ...finalTags,
        ...(oversized > 0 ? { oversizedDropped: oversized } : {}),
      });
    });
  }
  return { attached, oversized, chunks };
}
