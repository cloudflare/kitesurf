// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Accepts worker span records and attaches bounded log chunks to the active trace.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Tracer, SpanContext } from "../tracing.ts";
import { attachChunked } from "./carrier-spans.ts";
import { bindLocalFlushCtx, LocalTracer, localTracerSingleton } from "../tracing-local.ts";

const MAX_RECORDS_PER_CALL = 2000;
const MAX_BYTES_PER_CALL = 4 * 1024 * 1024;

interface SinkEnv {
  HOST_TRACER?: Tracer;
}

interface SinkProps {
  kind?: string;
  localTraceParent?: SpanContext;
}

function resolveTracer(
  configured: Tracer | undefined,
  stamped: SpanContext | undefined,
  ctx: ExecutionContext,
): { tracer: Tracer | undefined; local: LocalTracer | null } {
  const local = configuredLocalTracer(configured);
  if (local && stamped) bindLocalFlushCtx(ctx);
  return { tracer: activeTracer(configured, local, stamped), local };
}

function configuredLocalTracer(configured: Tracer | undefined): LocalTracer | null {
  if (configured instanceof LocalTracer) return configured;
  return configured ? null : localTracerSingleton();
}

function activeTracer(
  configured: Tracer | undefined,
  local: LocalTracer | null,
  stamped: SpanContext | undefined,
): Tracer | undefined {
  return local && stamped ? local : configured;
}

function hasRecordsToAttach(tracer: Tracer | undefined, records: string[]): tracer is Tracer {
  return tracer !== undefined && Array.isArray(records) && records.length > 0;
}

function attachInContext(
  local: LocalTracer | null,
  stamped: SpanContext | undefined,
  attach: () => number,
): number {
  return local && stamped ? local.runWithSpanContext(stamped, attach) : attach();
}

function boundedRecords(records: string[]): { kept: string[]; dropped: number } {
  const kept: string[] = [];
  let bytes = 0;
  for (const record of records) {
    if (typeof record !== "string") continue;
    if (kept.length >= MAX_RECORDS_PER_CALL || bytes + record.length > MAX_BYTES_PER_CALL) break;
    kept.push(record);
    bytes += record.length;
  }
  return { kept, dropped: records.length - kept.length };
}

export class SpanSink extends WorkerEntrypoint<SinkEnv, SinkProps> {
  emit(records: string[]): number {
    const stamped = this.ctx.props?.localTraceParent;
    const { tracer, local } = resolveTracer(this.env.HOST_TRACER, stamped, this.ctx);
    const activeTracer = tracer;
    if (!hasRecordsToAttach(activeTracer, records)) return 0;
    const attach = () => this.#attach(activeTracer, records);
    return attachInContext(local, stamped, attach);
  }

  #attach(tracer: Tracer, records: string[]): number {
    if (tracer.getSpanContext() === null) return 0;
    const { kept, dropped } = boundedRecords(records);
    const kind = this.ctx.props?.kind;
    const result = attachChunked(
      tracer,
      "child.spans",
      typeof kind === "string" ? { kind } : {},
      kept.map((value) => ({ key: "otel.span", value })),
      dropped > 0 ? { recordsDropped: dropped } : {},
    );
    return result.attached;
  }
}
