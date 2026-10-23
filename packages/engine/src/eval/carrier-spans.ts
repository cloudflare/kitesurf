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

interface ChunkCursor {
  index: number;
  oversized: number;
}

interface AttachTotals {
  attached: number;
  chunks: number;
  finalEmitted: boolean;
}

interface AttachChunkContext {
  tracer: Tracer;
  name: string;
  tags: SpanTags;
  finalTags: SpanTags;
  cursor: ChunkCursor;
  totals: AttachTotals;
}

function appendNextLog(
  logs: CarrierLog[],
  chunk: CarrierLog[],
  cursor: ChunkCursor,
  bytes: number,
): number | null {
  const log = logs[cursor.index];
  if (log === undefined) return null;
  const size = logSize(log);
  if (size > CARRIER_SPAN_BYTE_BUDGET) {
    cursor.oversized++;
    cursor.index++;
    return bytes;
  }
  if (bytes + size > CARRIER_SPAN_BYTE_BUDGET) return null;
  bytes += size;
  chunk.push(log);
  cursor.index++;
  return bytes;
}

function nextChunk(logs: CarrierLog[], cursor: ChunkCursor): CarrierLog[] {
  const chunk: CarrierLog[] = [];
  let bytes = 0;
  while (cursor.index < logs.length && chunk.length < CARRIER_SPAN_LOG_CAP) {
    const nextBytes = appendNextLog(logs, chunk, cursor, bytes);
    if (nextBytes === null) break;
    bytes = nextBytes;
  }
  return chunk;
}

function attachDataChunk(context: AttachChunkContext, chunk: CarrierLog[], last: boolean): void {
  const { tracer, name, tags, finalTags, cursor, totals } = context;
  tracer.enterSpan(name, (span) => {
    span.setTags({ ...tags, records: chunk.length });
    for (const log of chunk) span.addLogs({ [log.key]: log.value });
    totals.attached += chunk.length;
    if (last) {
      totals.finalEmitted = true;
      span.setTags({
        ...finalTags,
        ...(cursor.oversized > 0 ? { oversizedDropped: cursor.oversized } : {}),
      });
    }
  });
}

function needsFinalChunk(cursor: ChunkCursor, totals: AttachTotals, finalTags: SpanTags): boolean {
  return !totals.finalEmitted && (cursor.oversized > 0 || Object.keys(finalTags).length > 0);
}

function attachFinalChunk(context: AttachChunkContext): void {
  const { tracer, name, tags, finalTags, cursor } = context;
  tracer.enterSpan(name, (span) => {
    span.setTags({
      ...tags,
      records: 0,
      ...finalTags,
      ...(cursor.oversized > 0 ? { oversizedDropped: cursor.oversized } : {}),
    });
  });
}

export function attachChunked(
  tracer: Tracer,
  name: string,
  tags: SpanTags,
  logs: CarrierLog[],
  finalTags: SpanTags = {},
): AttachChunkedResult {
  const cursor: ChunkCursor = { index: 0, oversized: 0 };
  const totals: AttachTotals = { attached: 0, chunks: 0, finalEmitted: false };
  const context = { tracer, name, tags, finalTags, cursor, totals };
  while (cursor.index < logs.length) {
    const chunk = nextChunk(logs, cursor);
    if (chunk.length === 0) continue;
    totals.chunks++;
    attachDataChunk(context, chunk, cursor.index >= logs.length);
  }
  if (needsFinalChunk(cursor, totals, finalTags)) {
    totals.chunks++;
    attachFinalChunk(context);
  }
  return { attached: totals.attached, oversized: cursor.oversized, chunks: totals.chunks };
}
