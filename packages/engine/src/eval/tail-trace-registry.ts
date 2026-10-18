// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Stores trace parents for worker tails.

import type { Tracer, SpanContext } from "../tracing.ts";

const entries = new Map<string, { tracer: Tracer; parent: SpanContext | null }>();
const MAX_ENTRIES = 64;

export function registerTailTrace(
  scriptName: string,
  tracer: Tracer,
  parent: SpanContext | null,
): void {
  if (!entries.has(scriptName) && entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entries.set(scriptName, { tracer, parent });
}

export function getTailTrace(
  scriptName: string,
): { tracer: Tracer; parent: SpanContext | null } | undefined {
  return entries.get(scriptName);
}
